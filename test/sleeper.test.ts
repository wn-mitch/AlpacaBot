import { describe, expect, it } from "vitest";
import { SleeperClient } from "../src/sleeper";

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const league = { league_id: "league/x", status: "in_season", season: "2026", scoring_settings: { pass_yd: 0.1 }, roster_positions: ["QB"], settings: { leg: 1, last_scored_leg: 0 }, total_rosters: 1 };
const roster = { roster_id: 1, owner_id: null, players: null, starters: null, settings: { wins: 0, losses: 0, ties: 0, fpts: 1, fpts_decimal: 25 } };

function makeClient(responses: Record<string, unknown>, status = 200) {
  const fetcher = (async (input: RequestInfo | URL) => {
    const path = String(input);
    const key = path.includes("/projections/") ? "projections" : path.includes("/trending/") ? "trending" : path.includes("/state/nfl") ? "nfl" : path.includes("/rosters") ? "rosters" : path.includes("/users") ? "users" : path.includes("/matchups/") ? "1" : path.includes("/league/") ? "league/x" : "players";
    return reply(responses[key], status);
  }) as typeof fetch;
  return { client: new SleeperClient(fetcher, "league/x"), fetcher };
}

describe("SleeperClient", () => {
  it("validates and normalizes the consumed documented responses", async () => {
    const { client } = makeClient({ nfl: { league_season: "2026" }, "league/x": league, rosters: [roster], users: [{ user_id: "u", display_name: "User", metadata: { team_name: "Team" } }], 1: [{ roster_id: 1, matchup_id: null, points: 12.5, starters: null, players_points: { qb: 12.5 } }], players: { qb: { player_id: "qb", full_name: "Player", fantasy_positions: ["QB"], injury_status: "Q" } }, trending: [{ player_id: "qb", count: 3 }], projections: [{ player: { player_id: "qb", fantasy_positions: ["QB"] }, stats: { pass_yd: 100 } }] });
    await expect(client.getState()).resolves.toMatchObject({ league_season: "2026" });
    await expect(client.getLeague()).resolves.toMatchObject({ league_id: "league/x" });
    await expect(client.getRosters()).resolves.toMatchObject([{ players: [], starters: [] }]);
    await expect(client.getMatchups(1)).resolves.toMatchObject([{ matchup_id: null, starters: [], players_points: { qb: 12.5 } }]);
    await expect(client.getTrendingAdds()).resolves.toEqual([{ player_id: "qb", count: 3 }]);
    await expect(client.getWeeklyProjections("2026", 1)).resolves.toMatchObject(new Map([["qb", { stats: { pass_yd: 100 } }]]));
  });

  it("encodes league and projection parameters", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => { calls.push(String(input)); return reply(input.toString().includes("projections") ? [] : input.toString().includes("state") ? { league_season: "2026" } : league); }) as typeof fetch;
    const sleeper = new SleeperClient(fetcher, "league/x");
    await sleeper.getState(); await sleeper.getLeague(); await sleeper.getWeeklyProjections("2026", 1);
    expect(calls[1]).toContain("league/league%2Fx");
    expect(calls[2].match(/position%5B%5D=/g)).toHaveLength(6);
    expect(calls[2]).toContain("season_type=regular");
  });

  it("rejects malformed data and non-success responses without response bodies", async () => {
    const { client } = makeClient({ nfl: { league_season: "2026" }, "league/x": league, rosters: [{ ...roster, roster_id: 1 }, { ...roster, roster_id: 1 }], projections: [{ player: { player_id: "qb", fantasy_positions: ["QB"] }, stats: { pass_yd: NaN } }] });
    await expect(client.getRosters()).rejects.toThrow("Duplicate");
    await expect(client.getWeeklyProjections("2026", 1)).rejects.toThrow("invalid data");
    const failed = new SleeperClient((async () => reply({ secret: "hidden" }, 503)) as typeof fetch, "league/x");
    await expect(failed.getState()).rejects.toThrow("get state failed with 503");
    expect(() => client.getMatchups(0)).toThrow("Invalid matchup week");
  });
});
