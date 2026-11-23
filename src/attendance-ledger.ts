import type { Env } from "./events";

export interface OccurrenceRecord {
  channelId: string;
  messageId: string;
  rollupState: "pending" | "creating" | "complete";
  threadId?: string;
  claimStartedAt?: number;
}

const occurrencePrefix = "/occurrences/";
const claimExpiryMs = 5 * 60 * 1_000;

export class AttendanceLedger implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(occurrencePrefix)) {
        return new Response("Not found", { status: 404 });
      }

      const occurrenceKey = decodeURIComponent(url.pathname.slice(occurrencePrefix.length));
      if (!occurrenceKey) {
        return new Response("Occurrence key is required", { status: 400 });
      }

      if (request.method === "PUT") {
        return this.record(occurrenceKey, request);
      }
      if (request.method === "POST" && url.pathname.endsWith("/claim-rollup")) {
        return this.claimRollup(occurrenceKey.replace(/\/claim-rollup$/, ""));
      }
      if (request.method === "POST" && url.pathname.endsWith("/complete-rollup")) {
        return this.completeRollup(occurrenceKey.replace(/\/complete-rollup$/, ""), request);
      }
      if (request.method === "POST" && url.pathname.endsWith("/release-rollup")) {
        return this.releaseRollup(occurrenceKey.replace(/\/release-rollup$/, ""));
      }
      return new Response("Not found", { status: 404 });
    });
  }

  private async record(occurrenceKey: string, request: Request): Promise<Response> {
    const body = await request.json<{ channelId?: string; messageId?: string }>();
    if (!body.channelId || !body.messageId) {
      return new Response("channelId and messageId are required", { status: 400 });
    }

    const existing = await this.state.storage.get<OccurrenceRecord>(occurrenceKey);
    if (existing) {
      return Response.json(existing);
    }

    const record: OccurrenceRecord = {
      channelId: body.channelId,
      messageId: body.messageId,
      rollupState: "pending",
    };
    await this.state.storage.put(occurrenceKey, record);
    return Response.json(record, { status: 201 });
  }

  private async claimRollup(occurrenceKey: string): Promise<Response> {
    const record = await this.state.storage.get<OccurrenceRecord>(occurrenceKey);
    if (!record) {
      return new Response("Occurrence not found", { status: 404 });
    }
    if (record.rollupState === "complete") {
      return Response.json(record);
    }

    const now = Date.now();
    if (
      record.rollupState === "creating" &&
      record.claimStartedAt !== undefined &&
      now - record.claimStartedAt < claimExpiryMs
    ) {
      return Response.json(record, { status: 409 });
    }

    const claimed: OccurrenceRecord = {
      ...record,
      rollupState: "creating",
      claimStartedAt: now,
    };
    await this.state.storage.put(occurrenceKey, claimed);
    return Response.json(claimed);
  }

  private async completeRollup(occurrenceKey: string, request: Request): Promise<Response> {
    const body = await request.json<{ threadId?: string }>();
    if (!body.threadId) {
      return new Response("threadId is required", { status: 400 });
    }

    const record = await this.state.storage.get<OccurrenceRecord>(occurrenceKey);
    if (!record) {
      return new Response("Occurrence not found", { status: 404 });
    }
    if (record.rollupState === "complete") {
      return Response.json(record);
    }
    if (record.rollupState !== "creating") {
      return Response.json(record, { status: 409 });
    }

    const complete: OccurrenceRecord = {
      ...record,
      rollupState: "complete",
      threadId: body.threadId,
      claimStartedAt: undefined,
    };
    await this.state.storage.put(occurrenceKey, complete);
    return Response.json(complete);
  }

  private async releaseRollup(occurrenceKey: string): Promise<Response> {
    const record = await this.state.storage.get<OccurrenceRecord>(occurrenceKey);
    if (!record) {
      return new Response("Occurrence not found", { status: 404 });
    }
    if (record.rollupState !== "creating") {
      return Response.json(record);
    }

    const pending: OccurrenceRecord = {
      ...record,
      rollupState: "pending",
      claimStartedAt: undefined,
    };
    await this.state.storage.put(occurrenceKey, pending);
    return Response.json(pending);
  }
}
