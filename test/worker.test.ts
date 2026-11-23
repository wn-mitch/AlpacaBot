import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import type { Env } from "../src/events";

const workerEnv: Env = {
  ...env,
  DISCORD_BOT_TOKEN: "token",
  PICKLEBALL_CHANNEL_ID: "pickleball-channel",
  PICKLEBALL_ROLE_ID: "pickleball-role",
  TRIVIA_CHANNEL_ID: "trivia-channel",
  TRIVIA_ROLE_ID: "trivia-role",
  BOARD_GAME_CHANNEL_ID: "board-game-channel",
  FANTASY_CHANNEL_ID: "fantasy-channel",
  SLEEPER_LEAGUE_ID: "league",
};

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function installDiscordFetch(...responses: Response[]) {
  const fetcher = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("Unexpected Discord request");
    }
    return next;
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

async function runScheduled(time: string, runtimeEnv: Env = workerEnv) {
  const context = createExecutionContext();
  worker.scheduled(
    createScheduledController({ scheduledTime: new Date(time), cron: "0 * * * *" }),
    runtimeEnv,
    context,
  );
  await waitOnExecutionContext(context);
}

afterEach(() => vi.unstubAllGlobals());

describe("scheduled Worker", () => {
  it("links an announcement to one attendance thread", async () => {
    const fetcher = installDiscordFetch(
      response({ id: "announcement" }),
      response({}),
      response({}),
      response({}),
      response({}),
    );

    await runScheduled("2026-08-05T19:00:00Z");

    expect(fetcher).toHaveBeenCalledTimes(5);
    const rollupFetch = installDiscordFetch(
      response([{ id: "human-attendee" }, { id: "bot-attendee", bot: true }]),
      response({}),
      response({ id: "attendance-thread" }),
      response({}),
    );

    await runScheduled("2026-08-05T22:00:00Z");

    const requests = rollupFetch.mock.calls;
    expect(requests.filter(([url]) => String(url).endsWith("/threads"))).toHaveLength(1);
    expect(JSON.parse(requests.at(-1)?.[1]?.body as string)).toEqual({
      content: "Confirmed attendees:\n1. <@human-attendee>",
      allowed_mentions: { users: ["human-attendee"] },
    });
  });

  it("does not send a request outside an event hour", async () => {
    const fetcher = installDiscordFetch();

    await runScheduled("2026-08-04T20:00:00Z");

    expect(fetcher).not.toHaveBeenCalled();
  });
  it("posts a Thursday preview once when AI commentary fails", async () => {
    const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
    const runtimeEnv: Env = {
      ...workerEnv,
      AI: { run: vi.fn(async () => { throw new Error("AI unavailable"); }) } as unknown as Env["AI"],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      const url = String(input);
      if (url.includes("/state/nfl")) return response({ league_season: "2026" });
      if (url.includes("/league/league/rosters")) return response([{ roster_id: 1, owner_id: null, players: ["qb"], starters: ["qb"], settings: { wins: 0, losses: 0, ties: 0 } }]);
      if (url.includes("/league/league/users")) return response([]);
      if (url.includes("/league/league/matchups/1")) return response([{ roster_id: 1, matchup_id: null, points: 0, starters: ["qb"], players_points: {} }]);
      if (url.includes("/league/league")) return response({ league_id: "league", status: "in_season", season: "2026", scoring_settings: { pass_yd: 0.1 }, roster_positions: ["QB"], settings: { leg: 1, last_scored_leg: 0 }, total_rosters: 1 });
      if (url.includes("api.sleeper.com/projections")) return response([{ player: { player_id: "qb", full_name: "Quarterback", fantasy_positions: ["QB"] }, stats: { pass_yd: 200 } }]);
      if (url.includes("/channels/fantasy-channel/messages")) return response({ id: "fantasy-message" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    await runScheduled("2026-08-06T23:00:00Z", runtimeEnv);
    const discordRequest = calls.find(([input]) => String(input).includes("/channels/fantasy-channel/messages"));
    expect(discordRequest).toBeDefined();
    const fantasyBody = JSON.parse(discordRequest?.[1]?.body as string);
    expect(fantasyBody.content).toContain("🏈 **Week 1 Matchup Preview**");
    expect(fantasyBody.content).toContain("```text");
    expect(fantasyBody.embeds).toBeUndefined();
    await runScheduled("2026-08-06T23:00:00Z", runtimeEnv);
    expect(calls.filter(([input]) => String(input).includes("/channels/fantasy-channel/messages"))).toHaveLength(1);
  });
});
