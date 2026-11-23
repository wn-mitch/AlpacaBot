import {
  bcpEventIds,
  circuitMessage,
  circuitPoints,
  circuitSeason,
  countedEvents,
  fetchEntrants,
  fetchEvent,
  fetchRound,
  finalMessages,
  pairingsMessages,
  recordsFrom,
  type BcpEvent,
  type Game,
  type ResultRow,
  type Standing,
} from "./bcp";
import { postReport } from "./discord";
import type { Env } from "./events";
import { reportNonce } from "./fantasy";
import { easternTimeParts } from "./schedule";

const discordApi = "https://discord.com/api/v10";
// BCP often publishes Round 1 the night before; start polling 12 hours ahead.
const pollLeadMs = 12 * 60 * 60 * 1_000;

interface EventRow {
  bcp_id: string;
  name: string;
  starts_at: string;
  status: "upcoming" | "live" | "final";
}

export async function trackEvent(env: Env, fetcher: typeof fetch, eventId: string): Promise<BcpEvent> {
  const event = await fetchEvent(fetcher, eventId);
  await env.DB.prepare(
    `INSERT INTO bcp_events (bcp_id, name, starts_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (bcp_id) DO UPDATE SET name = ?2, starts_at = ?3`,
  )
    .bind(event.id, event.name, event.eventDate)
    .run();
  await refreshRoster(env, fetcher, event.id);
  return event;
}

async function refreshRoster(env: Env, fetcher: typeof fetch, eventId: string): Promise<void> {
  const entrants = await fetchEntrants(fetcher, eventId);
  const insert = env.DB.prepare("INSERT OR IGNORE INTO bcp_roster (event_id, bcp_user_id, name, list_id) VALUES (?, ?, ?, ?)");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bcp_roster WHERE event_id = ?").bind(eventId),
    ...entrants.map((entrant) => insert.bind(eventId, entrant.userId, entrant.name, entrant.listId)),
  ]);
}

// Tracks every SCD calendar event whose description or location links a BCP event.
export async function syncCalendar(env: Env, fetcher: typeof fetch): Promise<void> {
  const response = await fetcher(`${discordApi}/guilds/${env.SCD_GUILD_ID}/scheduled-events`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!response.ok) throw new Error(`list scheduled events failed with ${response.status}`);
  const scheduled = await response.json<{ description?: string | null; entity_metadata?: { location?: string } | null }[]>();
  const ids = new Set(
    scheduled.flatMap((event) => bcpEventIds(`${event.description ?? ""} ${event.entity_metadata?.location ?? ""}`)),
  );
  const { results: open } = await env.DB.prepare("SELECT bcp_id FROM bcp_events WHERE status != 'final'").all<{ bcp_id: string }>();
  for (const { bcp_id } of open) ids.add(bcp_id);
  for (const id of ids) {
    try {
      await trackEvent(env, fetcher, id);
    } catch (error) {
      console.error(JSON.stringify({ bcpEvent: id, action: "sync", error: String(error) }));
    }
  }
}

async function claimPost(env: Env, key: string): Promise<boolean> {
  const result = await env.DB.prepare("INSERT INTO bcp_posts (post_key, posted_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
    .bind(key, new Date().toISOString())
    .run();
  return result.meta.changes === 1;
}

// Events tracked long after they ended still record circuit points, but stay quiet.
const announceWindowMs = 14 * 24 * 60 * 60 * 1_000;

// Posts once per key; a failed send releases the key so the next poll retries.
async function postOnce(env: Env, fetcher: typeof fetch, key: string, messages: readonly string[]): Promise<void> {
  // An empty round is still claimed, so later polls skip refetching it.
  if (!(await claimPost(env, key)) || messages.length === 0) return;
  try {
    for (const [index, content] of messages.entries()) {
      await postReport(fetcher, env.DISCORD_BOT_TOKEN, env.BCP_CHANNEL_ID!, await reportNonce(`${key}:${index}`), content);
    }
  } catch (error) {
    await env.DB.prepare("DELETE FROM bcp_posts WHERE post_key = ?").bind(key).run();
    throw error;
  }
}

async function claimedIds(env: Env): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT bcp_user_id FROM bcp_claims").all<{ bcp_user_id: string }>();
  return new Set(results.map((row) => row.bcp_user_id));
}

async function roundsThrough(fetcher: typeof fetch, eventId: string, last: number): Promise<Game[][]> {
  const rounds = await Promise.all(Array.from({ length: last }, (_, index) => fetchRound(fetcher, eventId, index + 1)));
  return rounds.filter((games): games is Game[] => games !== null);
}

export async function circuitStandings(env: Env, season: string): Promise<Standing[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.discord_user_id, c.bcp_name, r.points, r.placing, r.faction, e.name AS event,
       (SELECT count(*) FROM bcp_results x WHERE x.event_id = r.event_id) AS field
     FROM bcp_claims c
     JOIN bcp_results r ON r.bcp_user_id = c.bcp_user_id
     JOIN bcp_events e ON e.bcp_id = r.event_id
     WHERE r.season = ? ORDER BY r.points DESC`,
  )
    .bind(season)
    .all<{ discord_user_id: string; bcp_name: string; points: number; placing: number; faction: string | null; event: string; field: number }>();
  const byMember = new Map<string, Standing & { factions: Map<string, number> }>();
  for (const row of results) {
    const standing = byMember.get(row.discord_user_id) ?? {
      discordUserId: row.discord_user_id, name: row.bcp_name, points: 0, events: 0,
      // Rows arrive highest-scoring first, so the first row is the best event.
      bestEvent: row.event, bestPlacing: row.placing, bestField: row.field, faction: null, factions: new Map(),
    };
    if (standing.events < countedEvents) standing.points += row.points;
    standing.events++;
    if (row.faction) standing.factions.set(row.faction, (standing.factions.get(row.faction) ?? 0) + 1);
    byMember.set(row.discord_user_id, standing);
  }
  return [...byMember.values()]
    .map(({ factions, ...standing }) => {
      // Ties go to the faction played at the higher-scoring event, which was seen first.
      let faction: string | null = null;
      for (const [name, count] of factions) if (!faction || count > factions.get(faction)!) faction = name;
      return { ...standing, points: Math.round(standing.points * 10) / 10, faction };
    })
    .sort((left, right) => right.points - left.points || left.name.localeCompare(right.name));
}

async function finalize(env: Env, fetcher: typeof fetch, event: BcpEvent): Promise<void> {
  if (event.hidePlacings) return;
  const placed = (await fetchEntrants(fetcher, event.id, true)).filter((entrant) => entrant.placing !== null);
  if (placed.length === 0) return;
  const records = recordsFrom(await roundsThrough(fetcher, event.id, event.currentRound));
  const season = circuitSeason(event.eventDate);
  const rows: ResultRow[] = placed.map((entrant) => ({
    bcpUserId: entrant.userId,
    name: entrant.name,
    faction: entrant.faction,
    placing: entrant.placing!,
    record: records.get(entrant.userId)?.join("-") ?? "0-0-0",
    points: event.teamEvent ? null : circuitPoints(entrant.placing!, placed.length, event.rounds),
  }));
  const insert = env.DB.prepare(
    `INSERT OR REPLACE INTO bcp_results (event_id, bcp_user_id, name, faction, placing, record, points, season)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Team events pair teams, not players, so they are posted but never scored.
  if (!event.teamEvent) {
    await env.DB.batch(rows.map((row) => insert.bind(event.id, row.bcpUserId, row.name, row.faction, row.placing, row.record, row.points, season)));
  }

  const members = await claimedIds(env);
  const memberRows = rows.filter((row) => members.has(row.bcpUserId));
  if (memberRows.length && Date.now() - Date.parse(event.eventDate) < announceWindowMs) {
    await postOnce(env, fetcher, `final:${event.id}`, [
      ...finalMessages(event, placed.length, memberRows),
      circuitMessage(season, await circuitStandings(env, season)),
    ]);
  }
  await env.DB.prepare("UPDATE bcp_events SET status = 'final' WHERE bcp_id = ?").bind(event.id).run();
}

async function pollEvent(env: Env, fetcher: typeof fetch, row: EventRow): Promise<void> {
  const event = await fetchEvent(fetcher, row.bcp_id);
  if (event.ended) return finalize(env, fetcher, event);
  if (event.currentRound < 1) return;
  if (row.status === "upcoming") {
    await env.DB.prepare("UPDATE bcp_events SET status = 'live' WHERE bcp_id = ?").bind(row.bcp_id).run();
  }
  const key = `pairings:${event.id}:${event.currentRound}`;
  if (await env.DB.prepare("SELECT 1 FROM bcp_posts WHERE post_key = ?").bind(key).first()) return;
  const games = await fetchRound(fetcher, event.id, event.currentRound);
  if (!games) return;
  const records = recordsFrom(await roundsThrough(fetcher, event.id, event.currentRound - 1));
  await postOnce(env, fetcher, key, pairingsMessages(event, event.currentRound, games, records, await claimedIds(env)));
}

export async function runBcp(scheduledTime: number, env: Env, fetcher: typeof fetch = fetch): Promise<void> {
  if (!env.BCP_CHANNEL_ID || !env.SCD_GUILD_ID) return;
  if (easternTimeParts(scheduledTime).minute === "30") await syncCalendar(env, fetcher);
  const { results } = await env.DB.prepare("SELECT * FROM bcp_events WHERE status != 'final' AND starts_at <= ?")
    .bind(new Date(scheduledTime + pollLeadMs).toISOString())
    .all<EventRow>();
  for (const row of results) {
    try {
      await pollEvent(env, fetcher, row);
    } catch (error) {
      console.error(JSON.stringify({ bcpEvent: row.bcp_id, action: "poll", error: String(error) }));
    }
  }
}
