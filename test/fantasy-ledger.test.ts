import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FantasyLedger, type FantasyReportRecord } from "../src/fantasy-ledger";

function ledger() { return env.FANTASY_LEDGER.get(env.FANTASY_LEDGER.idFromName("fantasy-reports")); }
function request(path: string, init?: RequestInit) { return new Request(`https://fantasy-ledger${path}`, init); }
async function claim(key: string) { return ledger().fetch(request(`/reports/${encodeURIComponent(key)}/claim`, { method: "POST" })); }

const jsonBody = (value: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

describe("FantasyLedger", () => {
  it("claims once and enforces the send state machine", async () => {
    const first = await claim("ledger-state");
    expect(first.status).toBe(201);
    expect(await first.json<FantasyReportRecord>()).toMatchObject({ state: "building" });
    expect((await claim("ledger-state")).status).toBe(409);
    expect((await ledger().fetch(request("/reports/ledger-state/begin-send", { method: "POST" }))).status).toBe(200);
    expect((await ledger().fetch(request("/reports/ledger-state/complete", jsonBody({ messageId: "message" })))).status).toBe(200);
    expect((await claim("ledger-state")).status).toBe(200);
  });

  it("records a skip and protects first-write projection snapshots", async () => {
    await claim("ledger-skip");
    const skipped = await ledger().fetch(request("/reports/ledger-skip/skip", jsonBody({ reason: "no-completed-week" })));
    expect(await skipped.json<FantasyReportRecord>()).toMatchObject({ state: "skipped", skipReason: "no-completed-week" });
    const first = await ledger().fetch(request("/projections/2099/1", jsonBody({ projectedPointsByRoster: { "1": 10 } }))); 
    const second = await ledger().fetch(request("/projections/2099/1", jsonBody({ projectedPointsByRoster: { "1": 20 } })));
    expect(first.status).toBe(201);
    expect(await second.json()).toMatchObject({ projectedPointsByRoster: { "1": 10 } });
  });

  it("rejects malformed routes and bodies", async () => {
    expect((await ledger().fetch(request("/reports//claim", { method: "POST" }))).status).toBe(400);
    expect((await ledger().fetch(request("/reports/malformed/skip", jsonBody({ reason: "bad" })))).status).toBe(400);
    expect((await ledger().fetch(request("/reports/malformed/complete", jsonBody({})))).status).toBe(400);
    expect((await ledger().fetch(request("/projections/not-a-season/1", { method: "GET" }))).status).toBe(400);
  });

  it("allows releasing only a building claim", async () => {
    await claim("ledger-release");
    expect((await ledger().fetch(request("/reports/ledger-release/release", { method: "POST" }))).status).toBe(200);
    expect((await claim("ledger-release")).status).toBe(201);
  });

  it("supports direct state inspection for stale claims", async () => {
    await runInDurableObject(ledger(), async (_instance: FantasyLedger, state) => {
      await state.storage.put<FantasyReportRecord>("report:ledger-stale", { state: "sending", claimedAt: Date.now() - 16 * 60 * 1_000 });
    });
    expect((await claim("ledger-stale")).status).toBe(200);
    expect(await (await claim("ledger-stale")).json<FantasyReportRecord>()).toMatchObject({ state: "uncertain" });
  });
});
