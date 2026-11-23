import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AttendanceLedger, type OccurrenceRecord } from "../src/attendance-ledger";

function ledger() {
  return env.ATTENDANCE_LEDGER.get(env.ATTENDANCE_LEDGER.idFromName("event-messages"));
}

function request(path: string, init?: RequestInit) {
  return new Request(`https://attendance-ledger${path}`, init);
}

async function record(key: string) {
  return ledger().fetch(
    request(`/occurrences/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: "channel", messageId: "message" }),
    }),
  );
}

describe("AttendanceLedger", () => {
  it("records an announcement and atomically claims its roll-up", async () => {
    await expect(record("record-and-claim")).resolves.toHaveProperty("status", 201);

    const claimed = await ledger().fetch(request("/occurrences/record-and-claim/claim-rollup", { method: "POST" }));
    expect(claimed.status).toBe(200);
    await expect(claimed.json<OccurrenceRecord>()).resolves.toMatchObject({
      channelId: "channel",
      messageId: "message",
      rollupState: "creating",
    });

    const duplicate = await ledger().fetch(request("/occurrences/record-and-claim/claim-rollup", { method: "POST" }));
    expect(duplicate.status).toBe(409);
  });

  it("returns the completed thread when a roll-up is claimed again", async () => {
    await record("complete");
    await ledger().fetch(request("/occurrences/complete/claim-rollup", { method: "POST" }));
    const complete = await ledger().fetch(
      request("/occurrences/complete/complete-rollup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: "thread" }),
      }),
    );
    expect(complete.status).toBe(200);

    const repeated = await ledger().fetch(request("/occurrences/complete/claim-rollup", { method: "POST" }));
    await expect(repeated.json<OccurrenceRecord>()).resolves.toMatchObject({
      rollupState: "complete",
      threadId: "thread",
    });
  });

  it("releases a failed roll-up back to pending", async () => {
    await record("release");
    await ledger().fetch(request("/occurrences/release/claim-rollup", { method: "POST" }));
    const release = await ledger().fetch(request("/occurrences/release/release-rollup", { method: "POST" }));
    await expect(release.json<OccurrenceRecord>()).resolves.toMatchObject({ rollupState: "pending" });

    const reclaimed = await ledger().fetch(request("/occurrences/release/claim-rollup", { method: "POST" }));
    expect(reclaimed.status).toBe(200);
  });

  it("reclaims an abandoned five-minute-old claim", async () => {
    const stub = ledger();
    await runInDurableObject(stub, async (_instance: AttendanceLedger, state) => {
      await state.storage.put<OccurrenceRecord>("stale", {
        channelId: "channel",
        messageId: "message",
        rollupState: "creating",
        claimStartedAt: Date.now() - 5 * 60 * 1_000,
      });
    });

    const response = await stub.fetch(request("/occurrences/stale/claim-rollup", { method: "POST" }));
    await expect(response.json<OccurrenceRecord>()).resolves.toMatchObject({ rollupState: "creating" });
  });
});
