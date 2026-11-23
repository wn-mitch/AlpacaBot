import { AttendanceLedger, type OccurrenceRecord } from "./attendance-ledger";
import { FantasyLedger } from "./fantasy-ledger";
import { fantasyReportFor, runFantasyReport } from "./fantasy";
import { postAttendanceRollup, postEvent, type PostedMessage } from "./discord";
import { actionFor, type Env, type ScheduledAction } from "./events";
import { runBcp } from "./bcp-bot";
import { handleInteraction } from "./interactions";

export { AttendanceLedger, FantasyLedger };

function ledgerRequest(env: Env, occurrenceKey: string, suffix: string, init: RequestInit): Promise<Response> {
  const id = env.ATTENDANCE_LEDGER.idFromName("event-messages");
  return env.ATTENDANCE_LEDGER
    .get(id)
    .fetch(`https://attendance-ledger/occurrences/${encodeURIComponent(occurrenceKey)}${suffix}`, init);
}

async function runAction(action: ScheduledAction, env: Env): Promise<void> {
  try {
    if (action.kind === "announce") {
      const source = await postEvent(fetch, env.DISCORD_BOT_TOKEN, action.event);
      const response = await ledgerRequest(env, action.occurrenceKey, "", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source),
      });
      if (!response.ok) {
        throw new Error(`record announcement failed with ${response.status}`);
      }
    } else {
      const claim = await ledgerRequest(env, action.occurrenceKey, "/claim-rollup", { method: "POST" });
      if (claim.status === 404) {
        throw new Error(`Missing attendance record for ${action.occurrenceKey}`);
      }
      if (claim.status === 409) {
        return;
      }
      if (!claim.ok) {
        throw new Error(`claim attendance rollup failed with ${claim.status}`);
      }

      const record = await claim.json<OccurrenceRecord>();
      if (record.rollupState === "complete") {
        return;
      }

      let threadId: string | undefined;
      try {
        const source: PostedMessage = { channelId: record.channelId, messageId: record.messageId };
        ({
          threadId,
        } = await postAttendanceRollup(
          fetch,
          env.DISCORD_BOT_TOKEN,
          action.event,
          source,
          action.occurrenceKey.slice(action.event.id.length + 1),
        ));
        const complete = await ledgerRequest(env, action.occurrenceKey, "/complete-rollup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId }),
        });
        if (!complete.ok) {
          throw new Error(`complete attendance rollup failed with ${complete.status}`);
        }
      } finally {
        if (!threadId) {
          const release = await ledgerRequest(env, action.occurrenceKey, "/release-rollup", {
            method: "POST",
          });
          if (!release.ok) {
            throw new Error(`release attendance rollup failed with ${release.status}`);
          }
        }
      }
    }

    console.log(JSON.stringify({ occurrenceKey: action.occurrenceKey, action: action.kind, discordStatus: "success" }));
  } catch (error) {
    console.error(JSON.stringify({ occurrenceKey: action.occurrenceKey, action: action.kind, discordStatus: "failed" }));
    throw error;
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    if (request.method === "POST" && new URL(request.url).pathname === "/interactions") {
      return handleInteraction(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    const jobs: Promise<void>[] = [];
    const action = actionFor(controller.scheduledTime, env);
    if (action) jobs.push(runAction(action, env));
    const fantasyAction = fantasyReportFor(controller.scheduledTime);
    if (fantasyAction) jobs.push(runFantasyReport(fantasyAction, env));
    jobs.push(runBcp(controller.scheduledTime, env));
    if (jobs.length) ctx.waitUntil(Promise.all(jobs).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
