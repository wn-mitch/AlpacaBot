import type { FantasyReportKind } from "./fantasy";

export type FantasySkipReason = "inactive-league" | "season-mismatch" | "no-completed-week";

export interface FantasyReportRecord {
  state: "building" | "sending" | "sent" | "skipped" | "uncertain";
  claimedAt: number;
  messageId?: string;
  skipReason?: FantasySkipReason;
}

export interface ProjectionSnapshot {
  projectedPointsByRoster: Readonly<Record<string, number>>;
  createdAt: number;
}

const reportPrefix = "/reports/";
const projectionPrefix = "/projections/";
const claimExpiryMs = 15 * 60 * 1_000;
const skipReasons = new Set<FantasySkipReason>(["inactive-league", "season-mismatch", "no-completed-week"]);
const reportKinds = new Set<FantasyReportKind>([
  "weekly-recap",
  "waivers",
  "power-rankings",
  "matchup-preview",
  "injury-watch",
  "score-update-sunday-afternoon",
  "score-update-sunday-evening",
  "score-update-monday-morning",
]);

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

function conflict(record?: FantasyReportRecord): Response {
  return json(record ?? { error: "invalid state transition" }, 409);
}

function validKey(key: string): boolean {
  return key.length > 0 && key.length <= 200;
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export class FantasyLedger implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const url = new URL(request.url);
      if (url.pathname.startsWith(reportPrefix)) return this.handleReport(url.pathname, request);
      if (url.pathname.startsWith(projectionPrefix)) return this.handleProjection(url.pathname, request);
      return new Response("Not found", { status: 404 });
    });
  }

  private async handleReport(pathname: string, request: Request): Promise<Response> {
    const remainder = pathname.slice(reportPrefix.length);
    const slash = remainder.indexOf("/");
    const encodedKey = slash < 0 ? remainder : remainder.slice(0, slash);
    let key: string;
    try {
      key = decodeURIComponent(encodedKey);
    } catch {
      return badRequest("Invalid report key");
    }
    const operation = slash < 0 ? "" : remainder.slice(slash);
    if (!validKey(key)) return badRequest("Report key is required");
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    switch (operation) {
      case "/claim": return this.claim(key);
      case "/begin-send": return this.beginSend(key);
      case "/complete": return this.complete(key, request);
      case "/skip": return this.skip(key, request);
      case "/uncertain": return this.uncertain(key);
      case "/release": return this.release(key);
      default: return new Response("Not found", { status: 404 });
    }
  }

  private async claim(key: string): Promise<Response> {
    const existing = await this.state.storage.get<FantasyReportRecord>(`report:${key}`);
    const now = Date.now();
    if (!existing) {
      const created: FantasyReportRecord = { state: "building", claimedAt: now };
      await this.state.storage.put(`report:${key}`, created);
      return json(created, 201);
    }
    if (existing.state === "sent" || existing.state === "skipped" || existing.state === "uncertain") return json(existing);
    if (existing.state === "sending" && now - existing.claimedAt >= claimExpiryMs) {
      const uncertain: FantasyReportRecord = { ...existing, state: "uncertain" };
      await this.state.storage.put(`report:${key}`, uncertain);
      return json(uncertain);
    }
    if (now - existing.claimedAt >= claimExpiryMs) {
      const reclaimed: FantasyReportRecord = { ...existing, state: "building", claimedAt: now };
      await this.state.storage.put(`report:${key}`, reclaimed);
      return json(reclaimed);
    }
    return conflict(existing);
  }

  private async beginSend(key: string): Promise<Response> {
    const existing = await this.state.storage.get<FantasyReportRecord>(`report:${key}`);
    if (!existing) return conflict();
    if (existing.state !== "building") return conflict(existing);
    const sending: FantasyReportRecord = { ...existing, state: "sending", claimedAt: Date.now() };
    await this.state.storage.put(`report:${key}`, sending);
    return json(sending);
  }

  private async complete(key: string, request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!body || typeof body.messageId !== "string" || body.messageId.length === 0) return badRequest("messageId is required");
    const existing = await this.state.storage.get<FantasyReportRecord>(`report:${key}`);
    if (!existing) return conflict();
    if (existing.state === "sent") return json(existing);
    if (existing.state !== "sending") return conflict(existing);
    const sent: FantasyReportRecord = { ...existing, state: "sent", messageId: body.messageId };
    await this.state.storage.put(`report:${key}`, sent);
    return json(sent);
  }

  private async skip(key: string, request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!body || typeof body.reason !== "string" || !skipReasons.has(body.reason as FantasySkipReason)) return badRequest("valid skip reason is required");
    const existing = await this.state.storage.get<FantasyReportRecord>(`report:${key}`);
    if (!existing) return conflict();
    if (existing.state === "skipped") return json(existing);
    if (existing.state !== "building") return conflict(existing);
    const skipped: FantasyReportRecord = { ...existing, state: "skipped", skipReason: body.reason as FantasySkipReason };
    await this.state.storage.put(`report:${key}`, skipped);
    return json(skipped);
  }

  private async uncertain(key: string): Promise<Response> {
    const existing = await this.state.storage.get<FantasyReportRecord>(`report:${key}`);
    if (!existing) return conflict();
    if (existing.state === "uncertain") return json(existing);
    if (existing.state !== "sending") return conflict(existing);
    const uncertain: FantasyReportRecord = { ...existing, state: "uncertain" };
    await this.state.storage.put(`report:${key}`, uncertain);
    return json(uncertain);
  }

  private async release(key: string): Promise<Response> {
    const existing = await this.state.storage.get<FantasyReportRecord>(`report:${key}`);
    if (!existing) return json({ released: false });
    if (existing.state !== "building") return conflict(existing);
    await this.state.storage.delete(`report:${key}`);
    return json({ released: true });
  }

  private async handleProjection(pathname: string, request: Request): Promise<Response> {
    const pieces = pathname.slice(projectionPrefix.length).split("/");
    if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return badRequest("season and week are required");
    let season: string;
    let week: string;
    try {
      season = decodeURIComponent(pieces[0]);
      week = decodeURIComponent(pieces[1]);
    } catch {
      return badRequest("Invalid projection key");
    }
    if (!/^\d{4}$/.test(season) || !/^\d+$/.test(week)) return badRequest("Invalid projection key");
    const storageKey = `projection:${season}:${week}`;
    if (request.method === "GET") return json((await this.state.storage.get<ProjectionSnapshot>(storageKey)) ?? null);
    if (request.method !== "PUT" && request.method !== "POST") return new Response("Not found", { status: 404 });
    const body = await readJson(request);
    if (!body || typeof body.projectedPointsByRoster !== "object" || body.projectedPointsByRoster === null || Array.isArray(body.projectedPointsByRoster)) return badRequest("projectedPointsByRoster is required");
    const points: Record<string, number> = {};
    for (const [rosterId, value] of Object.entries(body.projectedPointsByRoster as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) return badRequest("projection values must be finite numbers");
      points[rosterId] = value;
    }
    const existing = await this.state.storage.get<ProjectionSnapshot>(storageKey);
    if (existing) return json(existing);
    const snapshot: ProjectionSnapshot = { projectedPointsByRoster: points, createdAt: Date.now() };
    await this.state.storage.put(storageKey, snapshot);
    return json(snapshot, 201);
  }
}
