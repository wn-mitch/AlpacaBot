import { bcpEventIds, bcpEventUrl, circuitHeader, circuitSeason, countedEvents, discordText, fetchArmyList, fetchEvent, listSections } from "./bcp";
import { bcpAccessToken } from "./bcp-auth";
import { circuitStandings, factionStandings, trackEvent } from "./bcp-bot";
import { circuitPng, factionLeaderCount, factionPng } from "./circuit-image";
import { commands } from "./commands";
import type { Env } from "./events";

const discordApi = "https://discord.com/api/v10";
const ephemeral = 64;
// Manage Server or Manage Events lets a member track events and unclaim others.
const moderatorBits = (1n << 5n) | (1n << 33n);

interface Option {
  name: string;
  value?: string | number;
  focused?: boolean;
  options?: Option[];
}

interface Interaction {
  type: number;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: { permissions?: string; user?: { id: string } };
  user?: { id: string };
  data?: { name: string; options?: Option[] };
}

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/../g) ?? []).map((byte) => parseInt(byte, 16)));
}

export async function verifySignature(request: Request, body: string, publicKey: string): Promise<boolean> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

const reply = (content: string, flags = 0) =>
  Response.json({ type: 4, data: { content, flags, allowed_mentions: { parse: [] } } });

const userId = (interaction: Interaction) => interaction.member?.user?.id ?? interaction.user?.id ?? "";

const isModerator = (interaction: Interaction) =>
  (BigInt(interaction.member?.permissions ?? "0") & moderatorBits) !== 0n;

function option(options: Option[] | undefined, name: string): Option | undefined {
  return options?.find((candidate) => candidate.name === name);
}

async function autocomplete(env: Env, sub: Option): Promise<Response> {
  const query = String(option(sub.options, "name")?.value ?? "").trim();
  const { results } = await env.DB.prepare(
    // Each BCP account is labeled with its latest event, so same-name accounts can be told apart.
    `SELECT r.bcp_user_id, r.name, e.name AS event, max(e.starts_at) FROM bcp_roster r
     JOIN bcp_events e ON e.bcp_id = r.event_id
     WHERE r.name LIKE ?1 ESCAPE '\\' GROUP BY r.bcp_user_id ORDER BY r.name LIMIT 25`,
  )
    .bind(`%${query.replace(/[\\%_]/g, "\\$&")}%`)
    .all<{ bcp_user_id: string; name: string; event: string }>();
  return Response.json({
    type: 8,
    data: { choices: results.map((row) => ({ name: `${row.name} · ${row.event}`.slice(0, 100), value: row.bcp_user_id })) },
  });
}

async function listAutocomplete(env: Env, sub: Option): Promise<Response> {
  const query = String(option(sub.options, "player")?.value ?? "").trim();
  const { results } = await env.DB.prepare(
    `SELECT r.event_id, r.bcp_user_id, r.name, e.name AS event FROM bcp_roster r
     JOIN bcp_events e ON e.bcp_id = r.event_id
     WHERE r.list_id IS NOT NULL AND r.name LIKE ?1 ESCAPE '\\'
     ORDER BY e.starts_at DESC, r.name LIMIT 25`,
  )
    .bind(`%${query.replace(/[\\%_]/g, "\\$&")}%`)
    .all<{ event_id: string; bcp_user_id: string; name: string; event: string }>();
  return Response.json({
    type: 8,
    data: { choices: results.map((row) => ({ name: `${row.name} · ${row.event}`.slice(0, 100), value: `${row.event_id}:${row.bcp_user_id}` })) },
  });
}

async function factionAutocomplete(env: Env, sub: Option): Promise<Response> {
  const query = String(option(sub.options, "faction")?.value ?? "").trim();
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT faction FROM bcp_results WHERE faction LIKE ?1 ESCAPE '\\' ORDER BY faction LIMIT 25`,
  )
    .bind(`%${query.replace(/[\\%_]/g, "\\$&")}%`)
    .all<{ faction: string }>();
  return Response.json({ type: 8, data: { choices: results.map((row) => ({ name: row.faction.slice(0, 100), value: row.faction })) } });
}

interface ListRow {
  name: string;
  list_id: string;
  event_id: string;
}

// Posts the list as code-block sections in a thread on the bot's public reply.
async function postArmyList(env: Env, interaction: Interaction, row: ListRow): Promise<void> {
  const event = await fetchEvent(fetch, row.event_id);
  if (event.hideLists) {
    await followUp(interaction, `Lists for ${discordText(event.name)} are hidden by the organizer.`);
    return;
  }
  const text = await fetchArmyList(fetch, await bcpAccessToken(env, fetch), row.list_id);
  if (!text) {
    await followUp(interaction, `${discordText(row.name)} hasn't entered list text on BCP.`);
    return;
  }
  const reply = await followUp(
    interaction,
    `**${discordText(row.name)}** · ${discordText(event.name)} · [BCP list](<https://www.bestcoastpairings.com/list/${row.list_id}>)`,
  );
  const bot = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" };
  const thread = await fetch(`${discordApi}/channels/${interaction.channel_id}/messages/${reply.id}/threads`, {
    method: "POST",
    headers: bot,
    body: JSON.stringify({ name: `${row.name} · ${event.name}`.slice(0, 100), auto_archive_duration: 1440 }),
  });
  if (!thread.ok) throw new Error(`create list thread failed with ${thread.status}`);
  const { id: threadId } = await thread.json<{ id: string }>();
  for (const content of listSections(text)) {
    const sent = await fetch(`${discordApi}/channels/${threadId}/messages`, {
      method: "POST",
      headers: bot,
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (!sent.ok) throw new Error(`post list section failed with ${sent.status}`);
  }
}

async function list(env: Env, interaction: Interaction, sub: Option, ctx: ExecutionContext): Promise<Response> {
  const [eventId, bcpUserId] = String(option(sub.options, "player")?.value ?? "").split(":");
  const row = await env.DB.prepare(
    "SELECT name, list_id, event_id FROM bcp_roster WHERE event_id = ? AND bcp_user_id = ? AND list_id IS NOT NULL",
  )
    .bind(eventId, bcpUserId)
    .first<ListRow>();
  if (!row) return reply("Pick a player from the list. Only players who submitted a list appear.", ephemeral);
  ctx.waitUntil(
    postArmyList(env, interaction, row).catch((error) =>
      followUp(interaction, `Couldn't load that list from BCP: ${String(error).slice(0, 200)}`).then(() => undefined),
    ),
  );
  return Response.json({ type: 5 });
}

async function followUp(interaction: Interaction, content: string): Promise<{ id: string }> {
  const response = await fetch(`${discordApi}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) throw new Error(`edit interaction reply failed with ${response.status}`);
  return response.json<{ id: string }>();
}

async function claim(env: Env, interaction: Interaction, sub: Option): Promise<Response> {
  const bcpUserId = String(option(sub.options, "name")?.value ?? "");
  const entrant = await env.DB.prepare("SELECT name FROM bcp_roster WHERE bcp_user_id = ? LIMIT 1")
    .bind(bcpUserId)
    .first<{ name: string }>();
  if (!entrant) {
    return reply("Pick your name from the list. Only players signed up for a tracked SCD event appear there.", ephemeral);
  }
  const owner = await env.DB.prepare("SELECT discord_user_id FROM bcp_claims WHERE bcp_user_id = ?")
    .bind(bcpUserId)
    .first<{ discord_user_id: string }>();
  const member = userId(interaction);
  if (owner && owner.discord_user_id !== member) {
    return reply(`${discordText(entrant.name)} is already claimed by <@${owner.discord_user_id}>. Ask a mod if that's wrong.`, ephemeral);
  }
  await env.DB.prepare(
    `INSERT INTO bcp_claims (discord_user_id, bcp_user_id, bcp_name, claimed_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (bcp_user_id) DO NOTHING`,
  )
    .bind(member, bcpUserId, entrant.name, new Date().toISOString())
    .run();
  return reply(`You're linked to **${discordText(entrant.name)}** on BCP. Your pairings and results will post in the event channel. If you have another BCP account, claim it too.`, ephemeral);
}

async function unclaim(env: Env, interaction: Interaction, sub: Option): Promise<Response> {
  const target = String(option(sub.options, "member")?.value ?? userId(interaction));
  if (target !== userId(interaction) && !isModerator(interaction)) {
    return reply("Only mods can unclaim someone else.", ephemeral);
  }
  const result = await env.DB.prepare("DELETE FROM bcp_claims WHERE discord_user_id = ?").bind(target).run();
  return reply(result.meta.changes ? `Removed the BCP link for <@${target}>.` : `<@${target}> has no BCP link.`, ephemeral);
}

async function events(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT e.bcp_id, e.name, e.starts_at, group_concat(c.bcp_name, '|') AS members
     FROM bcp_events e
     LEFT JOIN bcp_roster r ON r.event_id = e.bcp_id
     LEFT JOIN bcp_claims c ON c.bcp_user_id = r.bcp_user_id
     WHERE e.status != 'final' GROUP BY e.bcp_id ORDER BY e.starts_at LIMIT 10`,
  ).all<{ bcp_id: string; name: string; starts_at: string; members: string | null }>();
  if (results.length === 0) return reply("No upcoming BCP events on the SCD calendar.");
  const lines = results.map((row) => {
    const when = `<t:${Math.floor(Date.parse(row.starts_at) / 1000)}:D>`;
    // Names, not mentions, so listing events never pings anyone.
    const members = row.members ? row.members.split("|").sort().map((name) => `- ${discordText(name)}`).join("\n") : "No claimed members yet.";
    return `**[${discordText(row.name)}](<${bcpEventUrl(row.bcp_id)}>)** · ${when}\n${members}`;
  });
  return reply(`**Upcoming SCD events**\nRegister on BCP, then use \`/bcp claim\` once so the bot knows you.\n\n${lines.join("\n\n")}`.slice(0, 2_000));
}

async function track(env: Env, interaction: Interaction, sub: Option, ctx: ExecutionContext): Promise<Response> {
  if (!isModerator(interaction)) return reply("Only mods can track events.", ephemeral);
  const [eventId] = bcpEventIds(String(option(sub.options, "link")?.value ?? ""));
  if (!eventId) return reply("Paste a link like https://www.bestcoastpairings.com/event/abc123.", ephemeral);
  ctx.waitUntil(
    trackEvent(env, fetch, eventId)
      .then((event) => `Tracking **${discordText(event.name)}**. Round pairings will post here as BCP publishes them.`)
      .catch((error) => `Couldn't read that event from BCP: ${String(error).slice(0, 200)}`)
      .then((content) => followUp(interaction, content)),
  );
  return Response.json({ type: 5, data: { flags: ephemeral } });
}

async function profile(env: Env, interaction: Interaction, sub: Option): Promise<Response> {
  const season = String(option(sub.options, "season")?.value ?? circuitSeason(new Date().toISOString()));
  const { results } = await env.DB.prepare(
    `SELECT e.bcp_id, e.name, e.starts_at, r.placing, r.record, r.points,
       (SELECT count(*) FROM bcp_results x WHERE x.event_id = r.event_id) AS field
     FROM bcp_claims c JOIN bcp_results r ON r.bcp_user_id = c.bcp_user_id
     JOIN bcp_events e ON e.bcp_id = r.event_id
     WHERE c.discord_user_id = ? AND r.season = ? ORDER BY r.points DESC, e.starts_at`,
  )
    .bind(userId(interaction), season)
    .all<{ bcp_id: string; name: string; starts_at: string; placing: number; record: string; points: number; field: number }>();
  const header = `**Your SCD Circuit ${season}**`;
  if (results.length === 0) return reply(`${header}\nNo results yet this season.`, ephemeral);
  // Same ranking as circuitStandings: the highest-scoring events count.
  const total = results.slice(0, countedEvents).reduce((sum, row) => sum + row.points, 0);
  const lines = results.map((row, index) => {
    const event = `[${discordText(row.name)}](<${bcpEventUrl(row.bcp_id)}>)`;
    const detail = `${row.placing}/${row.field} · ${row.record} · ${row.points.toFixed(1)} pts`;
    return index < countedEvents ? `- ✅ **${event}** · ${detail}` : `- ${event} · ${detail} (not counted)`;
  });
  const content = `${header}\n**${total.toFixed(1)} pts** from your best ${Math.min(countedEvents, results.length)} of ${results.length} event${results.length === 1 ? "" : "s"}.\n\n${lines.join("\n")}`;
  return reply(content.slice(0, 2_000), ephemeral);
}

async function faction(env: Env, interaction: Interaction, sub: Option): Promise<Response> {
  const name = String(option(sub.options, "faction")?.value ?? "").trim();
  const season = String(option(sub.options, "season")?.value ?? circuitSeason(new Date().toISOString()));
  const { results } = await env.DB.prepare(
    `SELECT c.discord_user_id, e.bcp_id, e.name, r.faction, r.placing, r.record, r.points,
       (SELECT count(*) FROM bcp_results x WHERE x.event_id = r.event_id) AS field,
       (SELECT count(*) FROM bcp_results x WHERE x.event_id = r.event_id AND x.faction = r.faction) AS same,
       (SELECT min(placing) FROM bcp_results x WHERE x.event_id = r.event_id AND x.faction = r.faction) AS top
     FROM bcp_claims c JOIN bcp_results r ON r.bcp_user_id = c.bcp_user_id
     JOIN bcp_events e ON e.bcp_id = r.event_id
     WHERE r.faction = ? COLLATE NOCASE AND r.season = ? ORDER BY r.points DESC, e.starts_at`,
  )
    .bind(name, season)
    .all<{ discord_user_id: string; bcp_id: string; name: string; faction: string; placing: number; record: string; points: number; field: number; same: number; top: number }>();
  const mine = results.filter((row) => row.discord_user_id === userId(interaction));
  // BCP's spelling, whatever case the member typed.
  const shown = discordText(mine[0]?.faction ?? name);
  const header = `**Your ${shown} · SCD Circuit ${season}**`;
  if (mine.length === 0) return reply(`${header}\nYou haven't played ${shown} at a scored event this season.`, ephemeral);

  // Members ranked by their best four events with this faction, like the circuit.
  const totals = new Map<string, number[]>();
  for (const row of results) totals.set(row.discord_user_id, [...(totals.get(row.discord_user_id) ?? []), row.points]);
  const best = (points: number[]) => points.slice(0, countedEvents).reduce((sum, value) => sum + value, 0);
  const ranked = [...totals.entries()].map(([id, points]) => ({ id, total: best(points) })).sort((left, right) => right.total - left.total);
  const rank = ranked.findIndex((row) => row.id === userId(interaction)) + 1;

  const record = [0, 0, 0];
  for (const row of mine) row.record.split("-").forEach((count, index) => (record[index] += Number(count) || 0));
  const bif = mine.filter((row) => row.placing === row.top && row.same > 1).length;
  const lines = mine.map((row) => {
    const award = row.placing === row.top && row.same > 1 ? ` · 🏅 best of ${row.same}` : "";
    return `- [${discordText(row.name)}](<${bcpEventUrl(row.bcp_id)}>) · ${row.placing}/${row.field} · ${row.record} · ${row.points.toFixed(1)} pts${award}`;
  });
  const summary = [
    `${mine.length} event${mine.length === 1 ? "" : "s"} · ${record.join("-")}`,
    `**${best(mine.map((row) => row.points)).toFixed(1)} pts** from your best ${Math.min(countedEvents, mine.length)}`,
    `#${rank} of ${ranked.length} SCD ${shown} player${ranked.length === 1 ? "" : "s"}`,
    ...(bif ? [`best in faction ${bif}×`] : []),
  ].join(" · ");
  return reply(`${header}\n${summary}\n\n${lines.join("\n")}`.slice(0, 2_000), ephemeral);
}

function help(): Response {
  const lines = commands[0].options.map((sub) => `\`/bcp ${sub.name}\` · ${sub.description}`);
  return reply(`**AlpacaBot BCP commands**\n${lines.join("\n")}\n\nStart with \`/bcp claim\` so your pairings and results show up in bold.`, ephemeral);
}

// Edits the deferred reply to carry a PNG.
async function imageReply(interaction: Interaction, content: string, png: Uint8Array, filename: string): Promise<void> {
  const form = new FormData();
  form.set("payload_json", JSON.stringify({ content, attachments: [{ id: 0, filename }], allowed_mentions: { parse: [] } }));
  form.set("files[0]", new Blob([png], { type: "image/png" }), filename);
  const response = await fetch(`${discordApi}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, { method: "PATCH", body: form });
  if (!response.ok) throw new Error(`image reply failed with ${response.status}`);
}

async function circuit(env: Env, interaction: Interaction, sub: Option, ctx: ExecutionContext): Promise<Response> {
  const season = String(option(sub.options, "season")?.value ?? circuitSeason(new Date().toISOString()));
  ctx.waitUntil(
    (async () => {
      const standings = await circuitStandings(env, season);
      if (standings.length === 0) return followUp(interaction, `${circuitHeader(season)}\n\nNo claimed results yet.`);
      await imageReply(interaction, circuitHeader(season), await circuitPng(env, season, standings), `scd-circuit-${season}.png`);
    })().catch((error) => followUp(interaction, `Couldn't draw the circuit table: ${String(error).slice(0, 200)}`)),
  );
  return Response.json({ type: 5 });
}

async function factionLeaders(env: Env, interaction: Interaction, sub: Option, ctx: ExecutionContext): Promise<Response> {
  const typed = String(option(sub.options, "faction")?.value ?? "").trim();
  const season = String(option(sub.options, "season")?.value ?? circuitSeason(new Date().toISOString()));
  ctx.waitUntil(
    (async () => {
      // BCP's spelling, whatever case the member typed.
      const stored = await env.DB.prepare("SELECT faction FROM bcp_results WHERE faction = ? COLLATE NOCASE LIMIT 1").bind(typed).first<{ faction: string }>();
      const name = stored?.faction ?? typed;
      const standings = await factionStandings(env, name, season);
      if (standings.length === 0) {
        return followUp(interaction, `No SCD members have played ${discordText(name)} at a scored event in ${season}.`);
      }
      const content = `**Top ${discordText(name)} · SCD Circuit ${season}**\nTop ${factionLeaderCount} SCD members by their best ${countedEvents} ${discordText(name)} events. \`/bcp faction\` shows your own.`;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      await imageReply(interaction, content, await factionPng(env, season, name, standings), `scd-${slug}-${season}.png`);
    })().catch((error) => followUp(interaction, `Couldn't draw the faction table: ${String(error).slice(0, 200)}`)),
  );
  return Response.json({ type: 5 });
}

// Commands anyone can run before claiming, and commands that post publicly.
const claimFree = new Set(["claim", "unclaim", "help"]);
const publicCommands = new Set(["events", "list", "circuit", "faction-leaders"]);

export async function handleInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  if (!env.DISCORD_PUBLIC_KEY || !(await verifySignature(request, body, env.DISCORD_PUBLIC_KEY))) {
    return new Response("Bad signature", { status: 401 });
  }
  const interaction = JSON.parse(body) as Interaction;
  if (interaction.type === 1) return Response.json({ type: 1 });
  const sub = interaction.data?.name === "bcp" ? interaction.data.options?.[0] : undefined;
  if (!sub) return reply("Unknown command.", ephemeral);
  if (interaction.type === 4 && sub.name === "claim") return autocomplete(env, sub);
  if (interaction.type === 4 && sub.name === "list") return listAutocomplete(env, sub);
  if (interaction.type === 4 && (sub.name === "faction" || sub.name === "faction-leaders")) return factionAutocomplete(env, sub);
  if (interaction.type !== 2) return new Response(null, { status: 400 });
  if (!claimFree.has(sub.name)) {
    const claimed = await env.DB.prepare("SELECT 1 FROM bcp_claims WHERE discord_user_id = ?").bind(userId(interaction)).first();
    if (!claimed) return reply(`<@${userId(interaction)}> link your BCP name first: run \`/bcp claim\` and pick yourself.`, ephemeral);
  }
  if (publicCommands.has(sub.name) && env.BCP_CHANNEL_ID && interaction.channel_id !== env.BCP_CHANNEL_ID) {
    return reply(`Use \`/bcp ${sub.name}\` in <#${env.BCP_CHANNEL_ID}>.`, ephemeral);
  }
  switch (sub.name) {
    case "claim": return claim(env, interaction, sub);
    case "unclaim": return unclaim(env, interaction, sub);
    case "events": return events(env);
    case "track": return track(env, interaction, sub, ctx);
    case "circuit": return circuit(env, interaction, sub, ctx);
    case "list": return list(env, interaction, sub, ctx);
    case "help": return help();
    case "profile": return profile(env, interaction, sub);
    case "faction": return faction(env, interaction, sub);
    case "faction-leaders": return factionLeaders(env, interaction, sub, ctx);
    default: return reply("Unknown command.", ephemeral);
  }
}
