// Anonymous Best Coast Pairings reads. Rosters, pairings, results, factions and
// placings are public; army lists need a BCP login and are never fetched.
const apiOrigin = "https://newprod-api.bestcoastpairings.com";
const apiHeaders = { "client-id": "web-app", env: "bcp", accept: "application/json" };

export const bcpEventUrl = (eventId: string) => `https://www.bestcoastpairings.com/event/${eventId}`;

export function bcpEventIds(text: string): string[] {
  return [...text.matchAll(/bestcoastpairings\.com\/event\/([A-Za-z0-9]+)/g)].map((match) => match[1]);
}

export interface BcpEvent {
  id: string;
  name: string;
  eventDate: string;
  currentRound: number;
  ended: boolean;
  hidePlacings: boolean;
  hideLists: boolean;
  rounds: number;
  teamEvent: boolean;
}

export interface BcpEntrant {
  userId: string;
  name: string;
  faction: string | null;
  placing: number | null;
  listId: string | null;
}

export interface Game {
  table: string;
  a: Side;
  b: Side | null;
  done: boolean;
}

interface Side {
  userId: string;
  name: string;
  faction: string | null;
  result: "W" | "L" | "D" | null;
}

interface RawUser {
  id?: string;
  firstName?: string;
  lastName?: string;
}

interface RawPlayer {
  userId?: string;
  listId?: string | null;
  user?: RawUser;
  faction?: string | { name?: string } | null;
  placing?: number | null;
}

interface RawPairing {
  table?: string | number;
  published?: boolean;
  isDone?: boolean;
  player1?: RawPlayer | null;
  player2?: RawPlayer | null;
  player1Game?: { result?: number | null } | null;
  player2Game?: { result?: number | null } | null;
}

async function getJson<T>(fetcher: typeof fetch, path: string): Promise<T> {
  const response = await fetcher(`${apiOrigin}${path}`, { headers: apiHeaders });
  if (!response.ok) throw new Error(`BCP ${path} returned ${response.status}`);
  return response.json<T>();
}

const fullName = (user?: RawUser) =>
  `${user?.firstName ?? ""} ${user?.lastName ?? ""}`.replace(/\s+/g, " ").trim();

const factionName = (faction: RawPlayer["faction"]) =>
  (typeof faction === "string" ? faction : faction?.name) || null;

const resultCode = (value?: number | null) =>
  value === 2 ? "W" : value === 1 ? "D" : value === 0 ? "L" : null;

export async function fetchEvent(fetcher: typeof fetch, eventId: string): Promise<BcpEvent> {
  const raw = await getJson<Record<string, unknown>>(fetcher, `/v1/events/${encodeURIComponent(eventId)}`);
  return {
    id: eventId,
    name: String(raw.name ?? eventId),
    eventDate: String(raw.eventDate),
    currentRound: Number(raw.currentRound) || 0,
    ended: raw.ended === true,
    hidePlacings: raw.hidePlacings === true,
    hideLists: raw.hideLists === true,
    rounds: Number(raw.numberOfRounds) || Number(raw.currentRound) || 0,
    teamEvent: raw.teamEvent === true,
  };
}

export async function fetchEntrants(
  fetcher: typeof fetch,
  eventId: string,
  placings = false,
): Promise<BcpEntrant[]> {
  const raw = await getJson<{ active?: RawPlayer[] }>(
    fetcher,
    `/v1/events/${encodeURIComponent(eventId)}/players?placings=${placings}`,
  );
  return (raw.active ?? [])
    .map((player) => ({
      userId: player.userId ?? player.user?.id ?? "",
      name: fullName(player.user),
      faction: factionName(player.faction),
      placing: typeof player.placing === "number" ? player.placing : null,
      listId: player.listId || null,
    }))
    .filter((entrant) => entrant.userId && entrant.name);
}

function side(player: RawPlayer | null | undefined, game: RawPairing["player1Game"], done: boolean): Side | null {
  const userId = player?.user?.id;
  const name = fullName(player?.user);
  if (!userId || !name) return null;
  return { userId, name, faction: factionName(player?.faction), result: done ? resultCode(game?.result) : null };
}

// Returns null until BCP has published every pairing in the round.
export async function fetchRound(
  fetcher: typeof fetch,
  eventId: string,
  round: number,
): Promise<Game[] | null> {
  const query = new URLSearchParams({ eventId, round: String(round), pairingType: "Pairing" });
  const raw = await getJson<{ active?: RawPairing[] }>(
    fetcher,
    `/v1/events/${encodeURIComponent(eventId)}/pairings?${query}`,
  );
  const pairings = raw.active ?? [];
  if (pairings.length === 0 || pairings.some((pairing) => pairing.published !== true)) return null;
  const games: Game[] = [];
  for (const pairing of pairings) {
    const done = pairing.isDone === true;
    const first = side(pairing.player1, pairing.player1Game, done);
    const second = side(pairing.player2, pairing.player2Game, done);
    const a = first ?? second;
    if (!a) continue;
    games.push({ table: String(pairing.table ?? ""), a, b: first ? second : null, done });
  }
  return games.sort((left, right) => Number(left.table) - Number(right.table) || left.table.localeCompare(right.table));
}

// Needs a signed-in BCP access token; see bcp-auth.ts.
export async function fetchArmyList(fetcher: typeof fetch, token: string, listId: string): Promise<string | null> {
  const response = await fetcher(`${apiOrigin}/v1/armylists/${encodeURIComponent(listId)}`, {
    headers: { ...apiHeaders, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`BCP list ${listId} returned ${response.status}`);
  const list = await response.json<{ armyListText?: string | null }>();
  return list.armyListText?.trim() || null;
}

export type Records = Map<string, [number, number, number]>;

export function recordsFrom(rounds: readonly Game[][]): Records {
  const records: Records = new Map();
  const add = (s: Side | null, fallback: Side["result"] = null) => {
    const result = s?.result ?? fallback;
    if (!s || !result) return;
    const record = records.get(s.userId) ?? [0, 0, 0];
    record[["W", "L", "D"].indexOf(result)]++;
    records.set(s.userId, record);
  };
  for (const games of rounds) {
    for (const game of games) {
      if (!game.done) continue;
      add(game.a, game.b ? null : "W");
      add(game.b);
    }
  }
  return records;
}

// Circuit seasons run July 1 through June 30, labeled by starting year: "2026-27".
// The first season starts early, at the 11th edition launch, so ATC 2026 counts.
const firstSeasonStart = "2026-06-23";

export function circuitSeason(isoDate: string): string {
  const date = new Date(isoDate);
  const day = date.toISOString().slice(0, 10);
  const earlyStart = day >= firstSeasonStart && day < "2026-07-01";
  const start = date.getUTCMonth() >= 6 || earlyStart ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

// Finishing position matters most (it is squared), and bigger and longer events pay
// more on top: a win at an 8-player 3-round RTT is 100, a win at a 175-player
// 8-round GT is about 366. Fields under 10 players get no size bonus.
export const circuitFormula = "100 × pct² × (1 + log₁₀(players ÷ 10)) × √(rounds ÷ 3)";

export function circuitPoints(placing: number, fieldSize: number, rounds: number): number {
  const pct = (fieldSize - placing + 1) / fieldSize;
  const size = 1 + Math.log10(Math.max(fieldSize, 10) / 10);
  return Math.round(1000 * pct ** 2 * size * Math.sqrt(rounds / 3)) / 10;
}

export const countedEvents = 4;

export function discordText(text: string): string {
  return text.replace(/[\\`*_~|[\]<>]/g, "\\$&");
}

export function chunkMessage(header: string, lines: readonly string[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (current.length && `${header}\n\n${[...current, line].join("\n")}`.length > 2_000) {
      chunks.push(`${header}\n\n${current.join("\n")}`);
      current = [];
    }
    current.push(line);
  }
  if (current.length) chunks.push(`${header}\n\n${current.join("\n")}`);
  return chunks;
}

// Splits a list at blank lines into code blocks that each fit one Discord message.
export function listSections(text: string, limit = 2_000): string[] {
  const max = limit - 8;
  const pieces = text
    .replace(/```/g, "ʼʼʼ")
    .split(/\n\s*\n/)
    .flatMap((section) => (section.length <= max ? [section] : section.split("\n")))
    .flatMap((piece) => piece.match(new RegExp(`[^]{1,${max}}`, "g")) ?? []);
  const blocks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const next = current ? `${current}\n\n${piece}` : piece;
    if (next.length > max && current) {
      blocks.push(current);
      current = piece;
    } else {
      current = next;
    }
  }
  if (current) blocks.push(current);
  return blocks.map((block) => `\`\`\`\n${block}\n\`\`\``);
}

export function pairingsMessages(
  event: Pick<BcpEvent, "id" | "name">,
  round: number,
  games: readonly Game[],
  records: Records,
  members: ReadonlySet<string>,
): string[] {
  const describe = (s: Side) => {
    const name = discordText(s.name);
    const record = records.get(s.userId)?.join("-") ?? "0-0-0";
    return `${members.has(s.userId) ? `**${name}**` : name} (${record}, ${discordText(s.faction ?? "faction unknown")})`;
  };
  const lines = games
    .filter((game) => members.has(game.a.userId) || (game.b && members.has(game.b.userId)))
    .map((game) => `Table ${discordText(game.table)} | ${describe(game.a)} ${game.b ? `vs ${describe(game.b)}` : "has a bye"}`);
  const header = `**${discordText(event.name)} · Round ${round}**\nEntering records (W-L-D). [BCP pairings](<${bcpEventUrl(event.id)}?active_tab=pairings>)`;
  return chunkMessage(header, lines);
}

export interface ResultRow {
  bcpUserId: string;
  name: string;
  faction: string | null;
  placing: number;
  record: string;
  // Null for team events, which score no circuit points.
  points: number | null;
}

export function finalMessages(
  event: Pick<BcpEvent, "id" | "name">,
  fieldSize: number,
  rows: readonly ResultRow[],
): string[] {
  const lines = [...rows]
    .sort((left, right) => left.placing - right.placing)
    .map((row) => `${row.placing}. **${discordText(row.name)}** — ${row.record} · ${discordText(row.faction ?? "faction unknown")}${row.points === null ? "" : ` · ${row.points} circuit pts`}`);
  const header = `**${discordText(event.name)} · Final results**\nSCD members · ${fieldSize} players · [BCP placings](<${bcpEventUrl(event.id)}?active_tab=placings>)`;
  return chunkMessage(header, lines);
}

export interface Standing {
  discordUserId: string;
  name: string;
  points: number;
  events: number;
  // The event that scored the most points, not the lowest place number.
  bestEvent: string;
  bestPlacing: number;
  bestField: number;
  faction: string | null;
}

// One member's season with a single faction, for the faction leaderboard.
export interface FactionStanding {
  name: string;
  points: number;
  events: number;
  record: string;
  bestEvent: string;
  bestPlacing: number;
  bestField: number;
}

export const circuitHeader = (season: string) =>
  `**SCD Circuit ${season}**\nBest ${countedEvents} events count, team events excluded. Points = \`${circuitFormula}\`, where pct = (players you finished ahead of + 1) ÷ players.`;
