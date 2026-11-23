// Records circuit results for past events. Discord's API does not return scheduled
// events that have ended, so this finds every BCP link posted in the SCD server,
// keeps events that ended on or after <since>, and prints SQL for D1:
//   DISCORD_BOT_TOKEN=… node scripts/bcp-backfill.ts 2026-06-23 > backfill.sql
//   npx wrangler d1 execute alpacabot-bcp --remote --file backfill.sql
// Backfilled events are marked final, so the bot never posts about them.
import { bcpEventIds, circuitPoints, circuitSeason, fetchEntrants, fetchEvent, fetchRound, recordsFrom, type Game } from "../src/bcp.ts";

const since = process.argv[2];
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.SCD_GUILD_ID ?? "732031881121497148";
if (!since || !token) {
  console.error("usage: DISCORD_BOT_TOKEN=… node scripts/bcp-backfill.ts <YYYY-MM-DD>");
  process.exit(1);
}

async function discord<T>(path: string): Promise<T> {
  for (;;) {
    const response = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
    if (response.status === 429 || response.status === 202) {
      const { retry_after = 2 } = (await response.json()) as { retry_after?: number };
      await new Promise((resolve) => setTimeout(resolve, retry_after * 1_000 + 500));
      continue;
    }
    if (!response.ok) throw new Error(`Discord ${path} returned ${response.status}`);
    return response.json() as Promise<T>;
  }
}

const ids = new Set<string>();
for (const query of ["link_hostname=bestcoastpairings.com", "content=bestcoastpairings.com"]) {
  for (let offset = 0; offset < 2_000; offset += 25) {
    const page = await discord<{ total_results: number; messages: unknown[][] }>(
      `/guilds/${guildId}/messages/search?${query}&limit=25&offset=${offset}`,
    );
    for (const id of bcpEventIds(JSON.stringify(page.messages))) ids.add(id);
    if (offset + 25 >= page.total_results) break;
  }
}

const q = (value: string | number | null) =>
  value === null ? "NULL" : typeof value === "number" ? String(value) : `'${value.replace(/'/g, "''")}'`;
const sql: string[] = [];
for (const id of ids) {
  const event = await fetchEvent(fetch, id).catch(() => null);
  if (!event?.ended || event.hidePlacings || event.eventDate < since) continue;
  const placed = (await fetchEntrants(fetch, id, true)).filter((entrant) => entrant.placing !== null);
  if (placed.length === 0) continue;
  // Team events pair teams rather than players, so their records may be blank.
  const rounds: Game[][] = [];
  for (let round = 1; round <= event.currentRound; round++) {
    const games = await fetchRound(fetch, id, round).catch(() => null);
    if (games) rounds.push(games);
  }
  const records = recordsFrom(rounds);
  const season = circuitSeason(event.eventDate);
  sql.push(
    `INSERT INTO bcp_events (bcp_id, name, starts_at, status) VALUES (${q(id)}, ${q(event.name)}, ${q(event.eventDate)}, 'final') ON CONFLICT (bcp_id) DO UPDATE SET status = 'final';`,
  );
  for (const entrant of placed) {
    sql.push(
      `INSERT OR REPLACE INTO bcp_roster (event_id, bcp_user_id, name, list_id) VALUES (${q(id)}, ${q(entrant.userId)}, ${q(entrant.name)}, ${q(entrant.listId)});`,
      `INSERT OR REPLACE INTO bcp_results VALUES (${q(id)}, ${q(entrant.userId)}, ${q(entrant.name)}, ${q(entrant.faction)}, ${entrant.placing}, ${q(records.get(entrant.userId)?.join("-") ?? "0-0-0")}, ${circuitPoints(entrant.placing!, placed.length)}, ${q(season)});`,
    );
  }
  console.error(`${event.eventDate.slice(0, 10)}  ${placed.length} players  ${event.name}`);
}
console.log(sql.join("\n"));
