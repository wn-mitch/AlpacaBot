export interface SleeperNflState {
  league_season: string;
  [key: string]: unknown;
}

export interface SleeperLeague {
  league_id: string;
  name?: string;
  status: string;
  season: string;
  scoring_settings: Readonly<Record<string, number>>;
  roster_positions: readonly string[];
  settings: { leg: number; last_scored_leg: number };
  total_rosters: number;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  players: readonly string[];
  starters: readonly string[];
  settings: Readonly<Record<string, number>>;
  metadata?: Readonly<Record<string, string>>;
}

export interface SleeperUser {
  user_id: string;
  display_name?: string;
  username?: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface SleeperMatchup {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  starters: readonly string[];
  starters_points: Readonly<Record<string, number>>;
  players_points: Readonly<Record<string, number>>;
}

export interface SleeperPlayer {
  player_id: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  fantasy_positions: readonly string[];
  injury_status?: string | null;
}

export interface SleeperTrend {
  player_id: string;
  count: number;
}

export interface SleeperProjection {
  player_id: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  fantasy_positions: readonly string[];
  stats: Readonly<Record<string, number>>;
}

const sleeperApi = "https://api.sleeper.app/v1";
const projectionApi = "https://api.sleeper.com";
const positions = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid Sleeper ${field}`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid Sleeper ${field}`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, field);
}

function stringArray(value: unknown, field: string, nullable = false): readonly string[] {
  if ((value === undefined || value === null) && nullable) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid Sleeper ${field}`);
  }
  return value;
}

function numberRecord(value: unknown, field: string): Readonly<Record<string, number>> {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error(`Invalid Sleeper ${field}`);
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) result[key] = finiteNumber(raw, `${field}.${key}`);
  return result;
}

function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new Error(`Invalid Sleeper ${field}`);
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") throw new Error(`Invalid Sleeper ${field}.${key}`);
    result[key] = raw;
  }
  return result;
}

function integer(value: unknown, field: string, minimum = 0): number {
  const result = finiteNumber(value, field);
  if (!Number.isInteger(result) || result < minimum) throw new Error(`Invalid Sleeper ${field}`);
  return result;
}

function parseState(value: unknown): SleeperNflState {
  if (!isObject(value)) throw new Error("Invalid Sleeper state");
  return { ...value, league_season: stringValue(value.league_season, "league_season") };
}

function parseLeague(value: unknown): SleeperLeague {
  if (!isObject(value)) throw new Error("Invalid Sleeper league");
  const settings = value.settings;
  if (!isObject(settings)) throw new Error("Invalid Sleeper league.settings");
  const scoring = value.scoring_settings;
  if (!isObject(scoring)) throw new Error("Invalid Sleeper scoring_settings");
  const scoringSettings: Record<string, number> = {};
  for (const [key, raw] of Object.entries(scoring)) scoringSettings[key] = finiteNumber(raw, `scoring_settings.${key}`);
  if (!Array.isArray(value.roster_positions) || value.roster_positions.some((slot) => typeof slot !== "string")) {
    throw new Error("Invalid Sleeper roster_positions");
  }
  return {
    league_id: stringValue(value.league_id, "league_id"),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    status: stringValue(value.status, "status"),
    season: stringValue(value.season, "season"),
    scoring_settings: scoringSettings,
    roster_positions: value.roster_positions,
    settings: {
      leg: integer(settings.leg ?? 0, "settings.leg"),
      last_scored_leg: integer(settings.last_scored_leg ?? 0, "settings.last_scored_leg"),
    },
    total_rosters: integer(value.total_rosters, "total_rosters", 1),
  };
}

function parseRosters(value: unknown): readonly SleeperRoster[] {
  if (!Array.isArray(value)) throw new Error("Invalid Sleeper rosters");
  const seen = new Set<number>();
  return value.map((raw) => {
    if (!isObject(raw)) throw new Error("Invalid Sleeper roster");
    const rosterId = integer(raw.roster_id, "roster_id", 1);
    if (seen.has(rosterId)) throw new Error("Duplicate Sleeper roster_id");
    seen.add(rosterId);
    return {
      roster_id: rosterId,
      owner_id: nullableString(raw.owner_id, "owner_id"),
      players: stringArray(raw.players, "players", true),
      starters: stringArray(raw.starters, "starters", true),
      settings: numberRecord(raw.settings, "settings"),
      ...(stringRecord(raw.metadata, "metadata") ? { metadata: stringRecord(raw.metadata, "metadata") } : {}),
    };
  });
}

function parseUsers(value: unknown): readonly SleeperUser[] {
  if (!Array.isArray(value)) throw new Error("Invalid Sleeper users");
  return value.map((raw) => {
    if (!isObject(raw)) throw new Error("Invalid Sleeper user");
    return {
      user_id: stringValue(raw.user_id, "user_id"),
      ...(typeof raw.display_name === "string" ? { display_name: raw.display_name } : {}),
      ...(typeof raw.username === "string" ? { username: raw.username } : {}),
      ...(stringRecord(raw.metadata, "metadata") ? { metadata: stringRecord(raw.metadata, "metadata") } : {}),
    };
  });
}

function parseMatchups(value: unknown): readonly SleeperMatchup[] {
  if (!Array.isArray(value)) throw new Error("Invalid Sleeper matchups");
  return value.map((raw) => {
    if (!isObject(raw)) throw new Error("Invalid Sleeper matchup");
    const matchupId = raw.matchup_id === null || raw.matchup_id === undefined ? null : integer(raw.matchup_id, "matchup_id", 1);
    const starters = stringArray(raw.starters, "starters", true);
    let startersPoints: Readonly<Record<string, number>>;
    if (Array.isArray(raw.starters_points)) {
      if (raw.starters_points.length !== starters.length) throw new Error("Invalid Sleeper starters_points");
      const values: Record<string, number> = {};
      for (const [index, value] of raw.starters_points.entries()) values[starters[index]] = finiteNumber(value, `starters_points.${starters[index]}`);
      startersPoints = values;
    } else {
      startersPoints = numberRecord(raw.starters_points, "starters_points");
    }
    return {
      roster_id: integer(raw.roster_id, "roster_id", 1),
      matchup_id: matchupId,
      points: finiteNumber(raw.points, "points"),
      starters,
      starters_points: startersPoints,
      players_points: numberRecord(raw.players_points, "players_points"),
    };
  });
}

function parsePlayers(value: unknown): ReadonlyMap<string, SleeperPlayer> {
  if (!isObject(value)) throw new Error("Invalid Sleeper players");
  const result = new Map<string, SleeperPlayer>();
  for (const [playerId, raw] of Object.entries(value)) {
    if (!isObject(raw)) throw new Error("Invalid Sleeper player");
    const id = stringValue(raw.player_id ?? playerId, "player_id");
    const positionsValue = raw.fantasy_positions === null || raw.fantasy_positions === undefined ? [] : raw.fantasy_positions;
    if (!Array.isArray(positionsValue) || positionsValue.some((position) => typeof position !== "string")) {
      throw new Error("Invalid Sleeper fantasy_positions");
    }
    result.set(id, {
      player_id: id,
      ...(typeof raw.full_name === "string" ? { full_name: raw.full_name } : {}),
      ...(typeof raw.first_name === "string" ? { first_name: raw.first_name } : {}),
      ...(typeof raw.last_name === "string" ? { last_name: raw.last_name } : {}),
      fantasy_positions: positionsValue,
      ...(raw.injury_status === null || typeof raw.injury_status === "string" ? { injury_status: raw.injury_status ?? null } : {}),
    });
  }
  return result;
}

function parseTrends(value: unknown): readonly SleeperTrend[] {
  if (!Array.isArray(value)) throw new Error("Invalid Sleeper trending adds");
  return value.map((raw) => {
    if (!isObject(raw)) throw new Error("Invalid Sleeper trend");
    return { player_id: stringValue(raw.player_id, "trend.player_id"), count: integer(raw.count, "trend.count") };
  });
}

function parseProjections(value: unknown): ReadonlyMap<string, SleeperProjection> {
  if (!Array.isArray(value)) throw new Error("Invalid Sleeper projections");
  const result = new Map<string, SleeperProjection>();
  for (const raw of value) {
    if (!isObject(raw) || !isObject(raw.player)) throw new Error("Invalid Sleeper projection");
    const player = raw.player;
    const id = stringValue(player.player_id, "projection.player.player_id");
    if (!Array.isArray(player.fantasy_positions) || player.fantasy_positions.some((position) => typeof position !== "string")) {
      throw new Error("Invalid Sleeper projection positions");
    }
    const stats = raw.stats;
    if (!isObject(stats)) throw new Error("Invalid Sleeper projection stats");
    const parsedStats: Record<string, number> = {};
    for (const [key, rawStat] of Object.entries(stats)) parsedStats[key] = finiteNumber(rawStat, `projection.stats.${key}`);
    result.set(id, {
      player_id: id,
      ...(typeof player.full_name === "string" ? { full_name: player.full_name } : {}),
      ...(typeof player.first_name === "string" ? { first_name: player.first_name } : {}),
      ...(typeof player.last_name === "string" ? { last_name: player.last_name } : {}),
      fantasy_positions: player.fantasy_positions,
      stats: parsedStats,
    });
  }
  return result;
}

export class SleeperClient {
  constructor(private readonly fetcher: typeof fetch, private readonly leagueId: string) {}

  private async get<T>(url: string, operation: string, parse: (value: unknown) => T): Promise<T> {
    const fetcher = this.fetcher;
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`${operation} failed with ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`${operation} returned invalid JSON`);
    }
    try {
      return parse(body);
    } catch (error) {
      throw new Error(`${operation} returned invalid data: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  getState(): Promise<SleeperNflState> {
    return this.get(`${sleeperApi}/state/nfl`, "get state", parseState);
  }

  getLeague(): Promise<SleeperLeague> {
    return this.get(`${sleeperApi}/league/${encodeURIComponent(this.leagueId)}`, "get league", parseLeague);
  }

  getRosters(): Promise<readonly SleeperRoster[]> {
    return this.get(`${sleeperApi}/league/${encodeURIComponent(this.leagueId)}/rosters`, "get rosters", parseRosters);
  }

  getUsers(): Promise<readonly SleeperUser[]> {
    return this.get(`${sleeperApi}/league/${encodeURIComponent(this.leagueId)}/users`, "get users", parseUsers);
  }

  getMatchups(week: number): Promise<readonly SleeperMatchup[]> {
    if (!Number.isInteger(week) || week < 1) throw new Error("Invalid matchup week");
    return this.get(`${sleeperApi}/league/${encodeURIComponent(this.leagueId)}/matchups/${encodeURIComponent(String(week))}`, "get matchups", parseMatchups);
  }

  getPlayers(): Promise<ReadonlyMap<string, SleeperPlayer>> {
    return this.get(`${sleeperApi}/players/nfl`, "get players", parsePlayers);
  }

  getTrendingAdds(): Promise<readonly SleeperTrend[]> {
    return this.get(`${sleeperApi}/players/nfl/trending/add?lookback_hours=24&limit=100`, "get trending adds", parseTrends);
  }

  getWeeklyProjections(season: string, week: number): Promise<ReadonlyMap<string, SleeperProjection>> {
    if (!season || !Number.isInteger(week) || week < 1) throw new Error("Invalid projection season or week");
    const url = new URL(`${projectionApi}/projections/nfl/${encodeURIComponent(season)}/${encodeURIComponent(String(week))}`);
    url.searchParams.set("season_type", "regular");
    for (const position of positions) url.searchParams.append("position[]", position);
    return this.get(url.toString(), "get weekly projections", parseProjections);
  }
}
