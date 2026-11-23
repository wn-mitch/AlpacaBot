import { postReport } from "./discord";
import type { Env } from "./events";
import type {
  FantasyReportRecord,
  FantasySkipReason,
  ProjectionSnapshot,
} from "./fantasy-ledger";
import {
  addCommentary,
  buildInjuryWatch,
  buildPowerRankings,
  buildPreview,
  buildRecap,
  buildScoreUpdate,
  buildWaivers,
  calculateWaivers,
  generateCommentary,
  type ReportCommentary,
  type ReportData,
} from "./fantasy-reports";
import { easternTimeParts } from "./schedule";
import { SleeperClient, type SleeperPlayer, type SleeperProjection } from "./sleeper";

export type FantasyReportKind =
  | "weekly-recap"
  | "waivers"
  | "power-rankings"
  | "matchup-preview"
  | "injury-watch"
  | "score-update-sunday-afternoon"
  | "score-update-sunday-evening"
  | "score-update-monday-morning";

export interface FantasyReportAction {
  kind: FantasyReportKind;
  occurrenceKey: string;
}

interface Cadence {
  weekday: string;
  hour: number;
  kind: FantasyReportKind;
}
const cadence: readonly Cadence[] = [
  { weekday: "Tuesday", hour: 8, kind: "weekly-recap" },
  { weekday: "Tuesday", hour: 18, kind: "waivers" },
  { weekday: "Wednesday", hour: 8, kind: "power-rankings" },
  { weekday: "Thursday", hour: 19, kind: "matchup-preview" },
  { weekday: "Sunday", hour: 8, kind: "injury-watch" },
  { weekday: "Sunday", hour: 16, kind: "score-update-sunday-afternoon" },
  { weekday: "Sunday", hour: 20, kind: "score-update-sunday-evening" },
  { weekday: "Monday", hour: 8, kind: "score-update-monday-morning" },
];

export function fantasyReportFor(scheduledTime: number): FantasyReportAction | undefined {
  const parts = easternTimeParts(scheduledTime);
  if (parts.minute !== "00") return undefined;
  const hour = Number(parts.hour);
  for (const entry of cadence) {
    if (entry.weekday !== parts.weekday) continue;
    if (hour === entry.hour || hour === entry.hour + 1) return { kind: entry.kind, occurrenceKey: `fantasy:${entry.kind}:${parts.year}-${parts.month}-${parts.day}` };
  }
  return undefined;
}

function ledgerRequest(env: Env, suffix: string, init: RequestInit): Promise<Response> {
  const id = env.FANTASY_LEDGER.idFromName("fantasy-reports");
  return env.FANTASY_LEDGER.get(id).fetch(`https://fantasy-ledger${suffix}`, init);
}

async function readRecord(response: Response): Promise<FantasyReportRecord> {
  if (!response.ok) throw new Error(`fantasy ledger request failed with ${response.status}`);
  return response.json<FantasyReportRecord>();
}

async function transition(
  env: Env,
  key: string,
  suffix: string,
  body?: unknown,
): Promise<FantasyReportRecord> {
  const request: RequestInit = { method: "POST" };
  if (body !== undefined) {
    request.headers = { "Content-Type": "application/json" };
    request.body = JSON.stringify(body);
  }

  const response = await ledgerRequest(
    env,
    `/reports/${encodeURIComponent(key)}${suffix}`,
    request,
  );
  return readRecord(response);
}

async function snapshot(
  env: Env,
  season: string,
  week: number,
  method: "GET" | "PUT",
  values?: Readonly<Record<string, number>>,
): Promise<ProjectionSnapshot | undefined> {
  const suffix = `/projections/${encodeURIComponent(season)}/${encodeURIComponent(String(week))}`;
  const request: RequestInit = { method };
  if (values) {
    request.headers = { "Content-Type": "application/json" };
    request.body = JSON.stringify({ projectedPointsByRoster: values });
  }

  const response = await ledgerRequest(env, suffix, request);
  if (!response.ok) {
    throw new Error(`fantasy projection snapshot failed with ${response.status}`);
  }
  if (method === "GET") {
    return response.status === 200
      ? (await response.json<ProjectionSnapshot | null>()) ?? undefined
      : undefined;
  }
  return response.json<ProjectionSnapshot>();
}

function skipReason(error: unknown): FantasySkipReason | undefined {
  if (!(error instanceof Error)) return undefined;

  switch (error.message) {
    case "inactive-league":
    case "season-mismatch":
    case "no-completed-week":
      return error.message;
    default:
      return undefined;
  }
}

function logStatus(
  action: FantasyReportAction,
  fantasyStatus: "success" | "failed" | "skipped" | "uncertain",
  extra: Record<string, string> = {},
): void {
  console.log(
    JSON.stringify({
      occurrenceKey: action.occurrenceKey,
      reportKind: action.kind,
      fantasyStatus,
      ...extra,
    }),
  );
}

function requireBindings(env: Env): void {
  if (!env.FANTASY_CHANNEL_ID) {
    throw new Error("Missing required binding: FANTASY_CHANNEL_ID");
  }
  if (!env.SLEEPER_LEAGUE_ID) {
    throw new Error("Missing required binding: SLEEPER_LEAGUE_ID");
  }
}

interface BuiltReport {
  data: ReportData;
  season: string;
  week: number;
  saveSnapshot?: Readonly<Record<string, number>>;
}

const commentaryReportKinds: Partial<Record<FantasyReportKind, true>> = {
  "matchup-preview": true,
  "weekly-recap": true,
  "power-rankings": true,
  waivers: true,
};

type ScoreUpdateKind = Extract<FantasyReportKind, `score-update-${string}`>;

const scoreUpdateLabels: Record<ScoreUpdateKind, string> = {
  "score-update-sunday-afternoon": "Sunday Afternoon",
  "score-update-sunday-evening": "Sunday Evening",
  "score-update-monday-morning": "Monday Morning",
};

function playersFromProjections(
  projections: ReadonlyMap<string, SleeperProjection>,
): ReadonlyMap<string, SleeperPlayer> {
  const players = new Map<string, SleeperPlayer>();
  for (const projection of projections.values()) {
    players.set(projection.player_id, {
      player_id: projection.player_id,
      full_name: projection.full_name,
      first_name: projection.first_name,
      last_name: projection.last_name,
      fantasy_positions: projection.fantasy_positions,
    });
  }
  return players;
}


async function buildReport(
  action: FantasyReportAction,
  env: Env,
  client: SleeperClient,
): Promise<BuiltReport> {
  const state = await client.getState();
  const league = await client.getLeague();
  if (league.league_id !== env.SLEEPER_LEAGUE_ID) {
    throw new Error("season-mismatch");
  }
  if (league.season !== state.league_season) {
    throw new Error("season-mismatch");
  }
  if (league.status !== "in_season") {
    throw new Error("inactive-league");
  }

  const completedWeekReport =
    action.kind === "weekly-recap" || action.kind === "power-rankings";
  const week = completedWeekReport
    ? league.settings.last_scored_leg
    : league.settings.leg;
  if (week < 1 && completedWeekReport) {
    throw new Error("no-completed-week");
  }

  const [rosters, users] = await Promise.all([
    client.getRosters(),
    client.getUsers(),
  ]);
  if (action.kind === "matchup-preview") {
    const [matchups, projections] = await Promise.all([
      client.getMatchups(week),
      client.getWeeklyProjections(league.season, week),
    ]);
    const players = playersFromProjections(projections);
    const data = buildPreview(
      week,
      action.occurrenceKey,
      league,
      rosters,
      users,
      matchups,
      projections,
      players,
    );
    return {
      data,
      season: league.season,
      week,
      saveSnapshot: data.projectionSnapshot,
    };
  }

  if (action.kind === "waivers") {
    const [projections, trends] = await Promise.all([
      client.getWeeklyProjections(league.season, week),
      client.getTrendingAdds(),
    ]);
    const players = playersFromProjections(projections);
    const waivers = calculateWaivers(
      league,
      rosters,
      projections,
      trends,
      players,
    );
    const data = buildWaivers(
      week,
      action.occurrenceKey,
      rosters,
      users,
      players,
      waivers,
    );
    return { data, season: league.season, week };
  }

  if (action.kind === "injury-watch") {
    const [, players] = await Promise.all([
      client.getMatchups(week),
      client.getPlayers(),
    ]);
    const data = buildInjuryWatch(
      week,
      action.occurrenceKey,
      rosters,
      users,
      players,
    );
    return { data, season: league.season, week };
  }

  if (action.kind === "power-rankings") {
    const completed = await Promise.all(
      Array.from({ length: week }, (_, index) =>
        client.getMatchups(index + 1),
      ),
    );
    const data = buildPowerRankings(
      week,
      action.occurrenceKey,
      rosters,
      users,
      completed,
    );
    return { data, season: league.season, week };
  }

  const matchups = await client.getMatchups(week);
  if (action.kind === "weekly-recap") {
    const players = await client.getPlayers();
    const locked = await snapshot(env, league.season, week, "GET");
    const data = buildRecap(
      week,
      action.occurrenceKey,
      league,
      rosters,
      users,
      matchups,
      players,
      locked,
    );
    return { data, season: league.season, week };
  }

  const data = buildScoreUpdate(
    week,
    scoreUpdateLabels[action.kind],
    action.occurrenceKey,
    rosters,
    users,
    matchups,
  );
  return { data, season: league.season, week };
}

export async function runFantasyReport(
  action: FantasyReportAction,
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  requireBindings(env);

  let claimed: FantasyReportRecord;
  try {
    claimed = await transition(env, action.occurrenceKey, "/claim");
  } catch (error) {
    logStatus(action, "failed");
    throw error;
  }

  if (claimed.state !== "building") {
    if (claimed.state === "skipped") {
      logStatus(action, "skipped");
    }
    return;
  }

  let begun = false;
  try {
    const client = new SleeperClient(fetcher, env.SLEEPER_LEAGUE_ID);
    const built = await buildReport(action, env, client);
    let commentary: ReportCommentary | undefined;

    if (commentaryReportKinds[action.kind]) {
      try {
        commentary = await generateCommentary(
          env.AI,
          action.occurrenceKey,
          built.data.facts,
        );
      } catch {
        console.log(
          JSON.stringify({
            occurrenceKey: action.occurrenceKey,
            reportKind: action.kind,
            aiStatus: "failed",
          }),
        );
      }
    }

    const content = commentary
      ? addCommentary(built.data.content, commentary)
      : built.data.content;
    if (built.saveSnapshot) {
      await snapshot(
        env,
        built.season,
        built.week,
        "PUT",
        built.saveSnapshot,
      );
    }

    await transition(env, action.occurrenceKey, "/begin-send");
    begun = true;
    const posted = await postReport(
      fetcher,
      env.DISCORD_BOT_TOKEN,
      env.FANTASY_CHANNEL_ID,
      await reportNonce(action.occurrenceKey),
      content,
    );
    await transition(env, action.occurrenceKey, "/complete", {
      messageId: posted.messageId,
    });
    logStatus(action, "success", { discordStatus: "success" });
  } catch (error) {
    if (begun) {
      try {
        await transition(env, action.occurrenceKey, "/uncertain");
      } catch {
        // Preserve the original delivery failure.
      }
      logStatus(action, "uncertain", { discordStatus: "uncertain" });
    } else {
      const reason = skipReason(error);
      if (reason) {
        await transition(env, action.occurrenceKey, "/skip", { reason });
        logStatus(action, "skipped");
        return;
      }

      try {
        await transition(env, action.occurrenceKey, "/release");
      } catch {
        // Preserve the original report-building failure.
      }
      logStatus(action, "failed", { sleeperStatus: "failed" });
    }
    throw error;
  }
}

export async function reportNonce(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

