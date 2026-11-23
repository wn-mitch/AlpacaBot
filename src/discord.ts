import type { ScheduledEvent } from "./events";

export interface PostedMessage {
  channelId: string;
  messageId: string;
}


interface DiscordUser {
  id: string;
  bot?: boolean;
}

interface SourceMessage {
  thread?: { id?: string };
}

const discordApi = "https://discord.com/api/v10";

async function responseBody(response: Response): Promise<string> {
  return response.text();
}

async function requireSuccess(response: Response, operation: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`${operation} failed with ${response.status}: ${await responseBody(response)}`);
  }
  return response;
}
export async function postReport(
  fetcher: typeof fetch,
  token: string,
  channelId: string,
  nonce: string,
  content: string,
): Promise<PostedMessage> {
  const response = await fetcher(`${discordApi}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: { ...authorization(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
      nonce,
      enforce_nonce: true,
    }),
  });
  if (!response.ok) throw new Error(`create fantasy report failed with ${response.status}`);
  let message: { id?: unknown };
  try {
    message = await response.json<{ id?: unknown }>();
  } catch {
    throw new Error("create fantasy report returned invalid JSON");
  }
  if (typeof message.id !== "string" || message.id.length === 0) {
    throw new Error("create fantasy report returned no message id");
  }
  return { channelId, messageId: message.id };
}

function authorization(token: string): HeadersInit {
  return {
    Authorization: `Bot ${token}`,
  };
}

async function fetchSourceMessage(
  fetcher: typeof fetch,
  token: string,
  source: PostedMessage,
): Promise<SourceMessage> {
  const response = await fetcher(
    `${discordApi}/channels/${source.channelId}/messages/${source.messageId}`,
    { headers: authorization(token) },
  );
  return (await requireSuccess(response, "fetch source message")).json<SourceMessage>();
}

export async function postEvent(
  fetcher: typeof fetch,
  token: string,
  event: ScheduledEvent,
): Promise<PostedMessage> {
  const body = {
    ...(event.roleId
      ? {
          content: `<@&${event.roleId}>`,
          allowed_mentions: { roles: [event.roleId] },
        }
      : {}),
    embeds: [
      {
        title: event.title,
        description: event.description,
        fields: [
          {
            name: "Options",
            value: event.responses.map((response) => `${response.emoji} ${response.label}\n`).join(""),
          },
        ],
      },
    ],
  };
  const messageResponse = await fetcher(`${discordApi}/channels/${event.channelId}/messages`, {
    method: "POST",
    headers: { ...authorization(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const message = await (await requireSuccess(messageResponse, "create event message")).json<{
    id?: string;
  }>();
  if (!message.id) {
    throw new Error("create event message returned no message id");
  }

  const source = { channelId: event.channelId, messageId: message.id };
  for (const [index, response] of event.responses.entries()) {
    const reactionResponse = await fetcher(
      `${discordApi}/channels/${source.channelId}/messages/${source.messageId}/reactions/${encodeURIComponent(response.emoji)}/@me`,
      { method: "PUT", headers: authorization(token) },
    );
    await requireSuccess(reactionResponse, `add ${response.emoji} reaction`);
    if (index < event.responses.length - 1) {
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, 500);
      await delay.promise;
    }
  }

  return source;
}

export async function postAttendanceRollup(
  fetcher: typeof fetch,
  token: string,
  event: ScheduledEvent,
  source: PostedMessage,
  occurrenceDate: string,
): Promise<{ threadId: string }> {
  const attendeeIds: string[] = [];
  const seenAttendeeIds = new Set<string>();
  let after: string | undefined;
  do {
    const searchParams = new URLSearchParams({ limit: "100" });
    if (after) {
      searchParams.set("after", after);
    }
    const response = await fetcher(
      `${discordApi}/channels/${source.channelId}/messages/${source.messageId}/reactions/${encodeURIComponent("👍")}?${searchParams}`,
      { headers: authorization(token) },
    );
    const page = await (await requireSuccess(response, "fetch attendance reactions")).json<
      DiscordUser[]
    >();
    for (const user of page) {
      if (!user.bot && !seenAttendeeIds.has(user.id)) {
        seenAttendeeIds.add(user.id);
        attendeeIds.push(user.id);
      }
    }
    after = page.at(-1)?.id;
    if (page.length < 100) {
      break;
    }
  } while (after);

  const existingThread = await fetchSourceMessage(fetcher, token, source);
  let threadId = existingThread.thread?.id;
  if (!threadId) {
    const threadResponse = await fetcher(
      `${discordApi}/channels/${source.channelId}/messages/${source.messageId}/threads`,
      {
        method: "POST",
        headers: { ...authorization(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${event.title} attendance · ${occurrenceDate}`,
          auto_archive_duration: 1440,
        }),
      },
    );
    if (threadResponse.ok) {
      const thread = await threadResponse.json<{ id?: string }>();
      if (!thread.id) {
        throw new Error("create attendance thread returned no thread id");
      }
      threadId = thread.id;
    } else if (threadResponse.status === 400) {
      const retrySource = await fetchSourceMessage(fetcher, token, source);
      if (!retrySource.thread?.id) {
        throw new Error(
          `create attendance thread failed with 400: ${await responseBody(threadResponse)}`,
        );
      }
      threadId = retrySource.thread.id;
    } else {
      await requireSuccess(threadResponse, "create attendance thread");
    }
  }
  if (!threadId) {
    throw new Error("create attendance thread returned no thread id");
  }


  if (attendeeIds.length === 0) {
    const response = await fetcher(`${discordApi}/channels/${threadId}/messages`, {
      method: "POST",
      headers: { ...authorization(token), "Content-Type": "application/json" },
      body: JSON.stringify({ content: "No confirmed attendees." }),
    });
    await requireSuccess(response, "post empty attendance summary");
    return { threadId };
  }

  const chunks: { attendeeIds: string[]; start: number }[] = [];
  let chunk: string[] = [];
  let chunkStart = 0;
  for (const [index, attendeeId] of attendeeIds.entries()) {
    const candidate = [...chunk, attendeeId];
    const content = `Confirmed attendees:\n${candidate
      .map((id, offset) => `${chunkStart + offset + 1}. <@${id}>`)
      .join("\n")}`;
    if (content.length >= 2_000 && chunk.length > 0) {
      chunks.push({ attendeeIds: chunk, start: chunkStart });
      chunk = [attendeeId];
      chunkStart = index;
    } else {
      chunk = candidate;
    }
  }
  chunks.push({ attendeeIds: chunk, start: chunkStart });

  for (const { attendeeIds: attendeeChunk, start } of chunks) {
    const response = await fetcher(`${discordApi}/channels/${threadId}/messages`, {
      method: "POST",
      headers: { ...authorization(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `Confirmed attendees:\n${attendeeChunk
          .map((id, offset) => `${start + offset + 1}. <@${id}>`)
          .join("\n")}`,
        allowed_mentions: { users: attendeeChunk },
      }),
    });
    await requireSuccess(response, "post attendance summary");
  }

  return { threadId };
}
