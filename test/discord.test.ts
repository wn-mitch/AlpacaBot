import { describe, expect, it, vi } from "vitest";
import { postAttendanceRollup, postEvent, postReport } from "../src/discord";
import type { ScheduledEvent } from "../src/events";

const event: ScheduledEvent = {
  id: "board-game-night",
  weekday: "Tuesday",
  announceHour: 15,
  rollupHour: 18,
  title: "Weekly Board Game Night",
  description: "Board Game Night @ Tue. 7pm. You in?",
  channelId: "event-channel",
  roleId: "event-role",
  responses: [
    { emoji: "👍", label: "Yes!" },
    { emoji: "👎", label: "No" },
    { emoji: "❓", label: "Maybe" },
    { emoji: "⌛", label: "I'll be late" },
  ],
};

const source = { channelId: "event-channel", messageId: "source-message" };
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fetcherWith(...responses: Response[]) {
  const fetcher = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("Unexpected Discord request");
    }
    return next;
  });
  return fetcher as unknown as typeof fetch;
}

describe("postEvent", () => {
  it("posts a role-safe embed then adds reactions in order", async () => {
    const fetcher = fetcherWith(response({ id: "message-id" }), response({}), response({}), response({}), response({}));

    await expect(postEvent(fetcher, "token", event)).resolves.toEqual({
      channelId: "event-channel",
      messageId: "message-id",
    });

    const requests = vi.mocked(fetcher).mock.calls;
    expect(requests).toHaveLength(5);
    expect(JSON.parse(requests[0][1]?.body as string)).toEqual({
      content: "<@&event-role>",
      allowed_mentions: { roles: ["event-role"] },
      embeds: [
        {
          title: event.title,
          description: event.description,
          fields: [{ name: "Options", value: "👍 Yes!\n👎 No\n❓ Maybe\n⌛ I'll be late\n" }],
        },
      ],
    });
    expect(requests.slice(1).map(([url]) => url)).toEqual([
      "https://discord.com/api/v10/channels/event-channel/messages/message-id/reactions/%F0%9F%91%8D/@me",
      "https://discord.com/api/v10/channels/event-channel/messages/message-id/reactions/%F0%9F%91%8E/@me",
      "https://discord.com/api/v10/channels/event-channel/messages/message-id/reactions/%E2%9D%93/@me",
      "https://discord.com/api/v10/channels/event-channel/messages/message-id/reactions/%E2%8C%9B/@me",
    ]);
  });

  it("omits mentions when an event has no role", async () => {
    const fetcher = fetcherWith(response({ id: "message-id" }), response({}), response({}), response({}), response({}));

    await postEvent(fetcher, "token", { ...event, roleId: undefined });

    expect(JSON.parse(vi.mocked(fetcher).mock.calls[0][1]?.body as string)).not.toHaveProperty(
      "content",
    );
    expect(JSON.parse(vi.mocked(fetcher).mock.calls[0][1]?.body as string)).not.toHaveProperty(
      "allowed_mentions",
    );
  });

  it.each([0, 1, 2, 3, 4])("rejects when Discord request %i fails", async (failedRequest) => {
    const fetcher = fetcherWith(
      ...Array.from({ length: 5 }, (_, index) =>
        response(
          index === failedRequest ? { error: "failed" } : index === 0 ? { id: "message-id" } : {},
          index === failedRequest ? 500 : 200,
        ),
      ),
    );

    await expect(postEvent(fetcher, "token", event)).rejects.toThrow("failed with 500");
  });
});

describe("postAttendanceRollup", () => {
  it("paginates human attendees and posts only their mentions", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `user-${index}`,
      bot: index === 0,
    }));
    const fetcher = fetcherWith(
      response(firstPage),
      response([{ id: "user-1" }, { id: "human-last" }]),
      response({}),
      response({ id: "attendance-thread" }),
      response({}),
    );

    await expect(postAttendanceRollup(fetcher, "token", event, source, "2026-08-04")).resolves.toEqual({
      threadId: "attendance-thread",
    });

    const requests = vi.mocked(fetcher).mock.calls;
    expect(requests[1][0]).toContain("after=user-99");
    expect(requests[3][0]).toBe(
      "https://discord.com/api/v10/channels/event-channel/messages/source-message/threads",
    );
    expect(JSON.parse(requests[3][1]?.body as string)).toEqual({
      name: "Weekly Board Game Night attendance · 2026-08-04",
      auto_archive_duration: 1440,
    });
    const summary = JSON.parse(requests[4][1]?.body as string);
    expect(summary.allowed_mentions.users).not.toContain("user-0");
    expect(summary.allowed_mentions.users).toEqual([...Array.from({ length: 99 }, (_, index) => `user-${index + 1}`), "human-last"]);
  });

  it("posts the exact empty-attendance message", async () => {
    const fetcher = fetcherWith(response([]), response({}), response({ id: "attendance-thread" }), response({}));

    await postAttendanceRollup(fetcher, "token", event, source, "2026-08-04");

    expect(JSON.parse(vi.mocked(fetcher).mock.calls[3][1]?.body as string)).toEqual({
      content: "No confirmed attendees.",
    });
  });

  it("chunks long attendance lists below Discord's message limit", async () => {
    const attendees = Array.from({ length: 300 }, (_, index) => ({ id: `123456789012345678${index}` }));
    const fetcher = fetcherWith(
      response(attendees.slice(0, 100)),
      response(attendees.slice(100, 200)),
      response(attendees.slice(200)),
      response([]),
      response({}),
      response({ id: "attendance-thread" }),
      ...Array.from({ length: 10 }, () => response({})),
    );

    await postAttendanceRollup(fetcher, "token", event, source, "2026-08-04");

    const summaries = vi
      .mocked(fetcher)
      .mock.calls.slice(6)
      .map(([, init]) => JSON.parse(init?.body as string));
    expect(summaries.length).toBeGreaterThan(1);
    for (const summary of summaries) {
      expect(summary.content.length).toBeLessThan(2_000);
      expect(summary.allowed_mentions.users).toEqual(
        [...summary.content.matchAll(/<@([^>]+)>/g)].map((match) => match[1]),
      );
    }
  });

  it("recovers the existing thread after a thread creation race", async () => {
    const fetcher = fetcherWith(
      response([{ id: "human" }]),
      response({}),
      response({ error: "already has thread" }, 400),
      response({ thread: { id: "already-created-thread" } }),
      response({}),
    );

    await expect(postAttendanceRollup(fetcher, "token", event, source, "2026-08-04")).resolves.toEqual({
      threadId: "already-created-thread",
    });
  });

  it.each([
    ["reaction users", [response({ error: "failed" }, 500)]],
    ["source message", [response([]), response({ error: "failed" }, 500)]],
    ["thread creation", [response([]), response({}), response({ error: "failed" }, 500)]],
    [
      "attendance summary",
      [response([{ id: "human" }]), response({}), response({ id: "thread" }), response({ error: "failed" }, 500)],
    ],
  ] as const)("rejects on %s failure", async (_operation, responses) => {
    await expect(postAttendanceRollup(fetcherWith(...responses), "token", event, source, "2026-08-04")).rejects.toThrow(
      "failed with 500",
    );
  });
});

describe("postReport", () => {
  const content = "🏈 **Week 1 Matchup Preview**\n\n```text\nA vs B\n```";

  it("posts one nonce-enforced report without mentions", async () => {
    const fetcher = fetcherWith(response({ id: "report-message" }));
    await expect(postReport(fetcher, "token", "fantasy-channel", "0123456789abcdef01234567", content)).resolves.toEqual({
      channelId: "fantasy-channel",
      messageId: "report-message",
    });
    const body = JSON.parse(vi.mocked(fetcher).mock.calls[0][1]?.body as string);
    expect(body).toEqual({ content, allowed_mentions: { parse: [] }, nonce: "0123456789abcdef01234567", enforce_nonce: true });
  });

  it("rejects success responses without an id and hides HTTP bodies", async () => {
    await expect(postReport(fetcherWith(response({}), 200), "token", "channel", "nonce", content)).rejects.toThrow("no message id");
    await expect(postReport(fetcherWith(response({ secret: "hidden" }, 500)), "token", "channel", "nonce", content)).rejects.toThrow("failed with 500");
  });
});
