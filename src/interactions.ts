import { bcpEventIds, bcpEventUrl, circuitMessage, circuitSeason, discordText, fetchArmyList, fetchEvent, listSections } from "./bcp";
import { bcpAccessToken } from "./bcp-auth";
import { circuitStandings, trackEvent } from "./bcp-bot";
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
    `SELECT bcp_user_id, name FROM bcp_roster WHERE name LIKE ?1 ESCAPE '\\'
     GROUP BY bcp_user_id ORDER BY name LIMIT 25`,
  )
    .bind(`%${query.replace(/[\\%_]/g, "\\$&")}%`)
    .all<{ bcp_user_id: string; name: string }>();
  return Response.json({
    type: 8,
    data: { choices: results.map((row) => ({ name: row.name.slice(0, 100), value: row.bcp_user_id })) },
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
     ON CONFLICT (discord_user_id) DO UPDATE SET bcp_user_id = ?2, bcp_name = ?3, claimed_at = ?4`,
  )
    .bind(member, bcpUserId, entrant.name, new Date().toISOString())
    .run();
  return reply(`You're linked to **${discordText(entrant.name)}** on BCP. Your pairings and results will post in the event channel.`, ephemeral);
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
    const members = row.members ? row.members.split("|").sort().map(discordText).join(", ") : "no claimed members yet";
    return `- **[${discordText(row.name)}](<${bcpEventUrl(row.bcp_id)}>)** · ${when}\n  - Signed up: ${members}`;
  });
  return reply(`**Upcoming SCD events**\nRegister on BCP, then use \`/bcp claim\` once so the bot knows you.\n\n${lines.join("\n")}`.slice(0, 2_000));
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

function help(): Response {
  const lines = commands[0].options.map((sub) => `\`/bcp ${sub.name}\` · ${sub.description}`);
  return reply(`**AlpacaBot BCP commands**\n${lines.join("\n")}\n\nStart with \`/bcp claim\` so your pairings and results show up in bold.`, ephemeral);
}

async function circuit(env: Env, sub: Option): Promise<Response> {
  const season = String(option(sub.options, "season")?.value ?? circuitSeason(new Date().toISOString()));
  return reply(circuitMessage(season, await circuitStandings(env, season)));
}

// Commands anyone can run before claiming, and commands that post publicly.
const claimFree = new Set(["claim", "unclaim", "help"]);
const publicCommands = new Set(["events", "list", "circuit"]);

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
    case "circuit": return circuit(env, sub);
    case "list": return list(env, interaction, sub, ctx);
    case "help": return help();
    default: return reply("Unknown command.", ephemeral);
  }
}
