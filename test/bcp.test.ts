import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { circuitPoints, circuitSeason, listSections } from "../src/bcp";
import { bcpAccessToken } from "../src/bcp-auth";
import { circuitStandings, runBcp } from "../src/bcp-bot";
import type { Env } from "../src/events";
import { handleInteraction } from "../src/interactions";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const player = (id: string, first: string, last: string, faction: string) => ({
  user: { id, firstName: first, lastName: last },
  faction,
});

// Four players: Ken (claimed member), Jack, Max, Bye-holder Sam.
const ken = player("ken", "Ken", "Edwards", "Death Guard");
const jack = player("jack", "Jack", "Murphy", "Dark Angels");
const max = player("max", "Max", "Berlove", "Necrons");
const sam = player("sam", "Sam", "Solo", "Orks");

const round1 = [
  { table: 2, published: true, isDone: true, player1: ken, player2: jack, player1Game: { result: 2 }, player2Game: { result: 0 } },
  { table: 1, published: true, isDone: true, player1: max, player2: null, player1Game: { result: 2 } },
  { table: 3, published: true, isDone: true, player1: null, player2: sam, player2Game: { result: 2 } },
];
const round2 = [
  { table: 1, published: true, isDone: false, player1: ken, player2: max },
  { table: 2, published: true, isDone: false, player1: jack, player2: sam },
];

function bcpServer(state: { currentRound: number; ended: boolean; round2Published?: boolean; teamEvent?: boolean }) {
  const posts: { url: string; body: { content: string } }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "discord.com") {
      if (url.pathname.endsWith("/scheduled-events")) {
        return json([{ description: "https://www.bestcoastpairings.com/event/EVT1" }, { description: "Placeholder" }]);
      }
      posts.push({ url: url.pathname, body: JSON.parse(String(init?.body)) });
      return json({ id: `m${posts.length}` });
    }
    if (url.pathname === "/v1/events/EVT1") {
      return json({ name: "Whole Hog GT", eventDate: "2026-12-05T14:00:00.000Z", numberOfRounds: 3, ...state, hidePlacings: false });
    }
    if (url.pathname === "/v1/events/EVT1/players") {
      const placed = url.searchParams.get("placings") === "true";
      return json({
        active: [ken, jack, max, sam].map((p, index) => ({
          userId: p.user.id,
          user: p.user,
          faction: { name: p.faction },
          placing: placed ? [2, 3, 1, 4][index] : null,
        })),
      });
    }
    if (url.pathname === "/v1/events/EVT1/pairings") {
      const round = url.searchParams.get("round");
      if (round === "1") return json({ active: round1 });
      if (round === "2") return json({ active: round2.map((p) => ({ ...p, published: state.round2Published !== false })) });
    }
    throw new Error(`unexpected request ${url}`);
  });
  return { fetcher: fetcher as unknown as typeof fetch, posts };
}

const botEnv = { ...env, DISCORD_BOT_TOKEN: "token", SCD_GUILD_ID: "scd", BCP_CHANNEL_ID: "event-discussion" } as Env;
const syncTime = Date.parse("2026-12-05T13:30:00Z");
const pollTime = Date.parse("2026-12-05T13:35:00Z");

async function seedClaim(discordId: string, bcpId: string, name: string) {
  await env.DB.prepare("INSERT INTO bcp_claims VALUES (?, ?, ?, ?)").bind(discordId, bcpId, name, "2026-12-01").run();
}

beforeEach(async () => {
  await env.DB.batch(
    ["bcp_circuit_images", "bcp_auth", "bcp_posts", "bcp_results", "bcp_claims", "bcp_roster", "bcp_events"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});

describe("circuit scoring", () => {
  it("weights finishing position over field size and event length", () => {
    // A 3-round RTT of 10 or fewer players is the 100-point baseline.
    expect(circuitPoints(1, 8, 3)).toBe(100);
    // 1 + log₁₀(3) = 1.4771, √(5/3) = 1.2910 → 190.7
    expect(circuitPoints(1, 30, 5)).toBe(190.7);
    // 1 + log₁₀(17.5) = 2.2430, √(8/3) = 1.6330 → 366.3
    expect(circuitPoints(1, 175, 8)).toBe(366.3);
    // 70th of 175 beat 105: (106/175)² × 366.3 = 134.4, less than winning the 30-player GT.
    expect(circuitPoints(70, 175, 8)).toBe(134.4);
    // 2nd of 4 at a 3-round RTT: (3/4)² × 100
    expect(circuitPoints(2, 4, 3)).toBe(56.3);
  });

  it("starts a season on July 1, except the first starts with ATC on June 23, 2026", () => {
    expect(circuitSeason("2026-06-22T18:00:00Z")).toBe("2025-26");
    expect(circuitSeason("2026-06-26T12:00:00Z")).toBe("2026-27");
    expect(circuitSeason("2027-06-26T12:00:00Z")).toBe("2026-27");
    expect(circuitSeason("2026-07-01T18:00:00Z")).toBe("2026-27");
    expect(circuitSeason("2027-01-16T14:00:00Z")).toBe("2026-27");
  });
});

describe("BCP event posts", () => {
  it("picks up calendar events and posts each round once, bolding claimed members", async () => {
    const server = bcpServer({ currentRound: 2, ended: false });
    await seedClaim("discord-ken", "ken", "Ken Edwards");

    await runBcp(syncTime, botEnv, server.fetcher);
    await runBcp(pollTime, botEnv, server.fetcher);

    expect(server.posts).toHaveLength(1);
    const { content } = server.posts[0].body;
    expect(content).toContain("**Whole Hog GT · Round 2**");
    expect(content).toContain("Table 1 | **Ken Edwards** (1-0-0, Death Guard) vs Max Berlove (1-0-0, Necrons)");
    // Jack vs Sam has no member, and Sam's bye-side record must not be lost.
    expect(content).not.toContain("Jack Murphy");
    expect(server.posts[0].url).toBe("/api/v10/channels/event-discussion/messages");
  });

  it("waits until BCP publishes the whole round", async () => {
    const server = bcpServer({ currentRound: 2, ended: false, round2Published: false });
    await seedClaim("discord-ken", "ken", "Ken Edwards");

    await runBcp(syncTime, botEnv, server.fetcher);

    expect(server.posts).toHaveLength(0);
  });

  it("posts final results and circuit standings, counting only the best four events", async () => {
    await seedClaim("discord-ken", "ken", "Ken Edwards");
    const old = env.DB.prepare("INSERT INTO bcp_events (bcp_id, name, starts_at, status) VALUES (?, ?, ?, 'final')");
    const result = env.DB.prepare("INSERT INTO bcp_results VALUES (?, 'ken', 'Ken Edwards', NULL, 1, '5-0-0', ?, ?)");
    await env.DB.batch([
      ...["A", "B", "C", "D", "E"].map((id) => old.bind(id, id, "2026-09-01T00:00:00Z")),
      ...[10, 20, 30, 40].map((points, index) => result.bind("ABCD"[index], points, "2026-27")),
      result.bind("E", 99, "2025-26"),
    ]);
    const server = bcpServer({ currentRound: 2, ended: true });

    await runBcp(syncTime, botEnv, server.fetcher);
    await runBcp(pollTime, botEnv, server.fetcher);

    const contents = server.posts.map((post) => post.body.content);
    expect(contents).toHaveLength(2);
    // Ken placed 2nd of 4 at a 3-round event: (3/4)² × 100 = 56.3.
    expect(contents[0]).toContain("2. **Ken Edwards** — 1-0-0 · Death Guard · 56.3 circuit pts");
    // Best four of 10, 20, 30, 40, 56.3 → 146.3; last season's 99 is excluded.
    expect(contents[1]).toContain("**SCD Circuit 2026-27**");
    expect(contents[1]).toContain("1. **Ken Edwards** — 146.3 pts (5 events)");
    const status = await env.DB.prepare("SELECT status FROM bcp_events WHERE bcp_id = 'EVT1'").first<{ status: string }>();
    expect(status?.status).toBe("final");
  });

  it("posts team event results without scoring them", async () => {
    await seedClaim("discord-ken", "ken", "Ken Edwards");
    const server = bcpServer({ currentRound: 2, ended: true, teamEvent: true });

    await runBcp(syncTime, botEnv, server.fetcher);
    await runBcp(pollTime, botEnv, server.fetcher);

    expect(server.posts[0].body.content).toMatch(/^2\. \*\*Ken Edwards\*\* — 1-0-0 · Death Guard$/m);
    expect(server.posts[0].body.content).not.toContain("circuit pts");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM bcp_results").first()).toEqual({ n: 0 });
  });
});

describe("/bcp interactions", () => {
  async function signedRequest(keys: CryptoKeyPair, body: unknown) {
    const text = JSON.stringify(body);
    const timestamp = "1700000000";
    const signature = new Uint8Array(
      await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + text)),
    );
    const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return new Request("https://bot/interactions", {
      method: "POST",
      headers: { "X-Signature-Ed25519": hex(signature), "X-Signature-Timestamp": timestamp },
      body: text,
    });
  }

  async function setup() {
    const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
    const publicKey = Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO bcp_events (bcp_id, name, starts_at) VALUES ('EVT1', 'Whole Hog GT', '2026-12-05T14:00:00Z')"),
      env.DB.prepare("INSERT INTO bcp_roster VALUES ('EVT1', 'ken', 'Ken Edwards', 'LIST1')"),
    ]);
    return { keys, interactionEnv: { ...botEnv, DISCORD_PUBLIC_KEY: publicKey } as Env };
  }

  const claim = (discordId: string, value: string) => ({
    type: 2, token: "t", application_id: "app",
    member: { user: { id: discordId }, permissions: "0" },
    data: { name: "bcp", options: [{ name: "claim", options: [{ name: "name", value }] }] },
  });

  async function send(keys: CryptoKeyPair, interactionEnv: Env, body: unknown) {
    const ctx = createExecutionContext();
    const response = await handleInteraction(await signedRequest(keys, body), interactionEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("rejects unsigned requests", async () => {
    const { interactionEnv } = await setup();
    const response = await handleInteraction(
      new Request("https://bot/interactions", { method: "POST", body: JSON.stringify({ type: 1 }) }),
      interactionEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(401);
  });

  it("links a member to a BCP name and refuses a second member claiming it", async () => {
    const { keys, interactionEnv } = await setup();

    const first = await (await send(keys, interactionEnv, claim("discord-ken", "ken"))).json<{ data: { content: string } }>();
    const second = await (await send(keys, interactionEnv, claim("discord-imposter", "ken"))).json<{ data: { content: string } }>();

    expect(first.data.content).toContain("linked to **Ken Edwards**");
    expect(second.data.content).toContain("already claimed by <@discord-ken>");
    const owner = await env.DB.prepare("SELECT discord_user_id FROM bcp_claims WHERE bcp_user_id = 'ken'").first();
    expect(owner).toEqual({ discord_user_id: "discord-ken" });
  });

  it("lets one member claim two BCP accounts and counts both in the circuit", async () => {
    const { keys, interactionEnv } = await setup();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO bcp_roster VALUES ('EVT1', 'ken-new', 'Ken Edwards', NULL)"),
      env.DB.prepare("INSERT INTO bcp_results VALUES ('EVT1', 'ken', 'Ken Edwards', NULL, 1, '5-0-0', 40, '2026-27')"),
      env.DB.prepare("INSERT INTO bcp_results VALUES ('EVT1', 'ken-new', 'Ken Edwards', NULL, 1, '5-0-0', 30, '2026-27')"),
    ]);

    await send(keys, interactionEnv, claim("discord-ken", "ken"));
    await send(keys, interactionEnv, claim("discord-ken", "ken-new"));

    const { results } = await env.DB.prepare("SELECT bcp_user_id FROM bcp_claims WHERE discord_user_id = 'discord-ken' ORDER BY 1").all();
    expect(results).toEqual([{ bcp_user_id: "ken" }, { bcp_user_id: "ken-new" }]);
    expect(await circuitStandings(env as Env, "2026-27")).toMatchObject([{ discordUserId: "discord-ken", points: 70, events: 2 }]);
  });

  it("autocompletes claim names from tracked rosters", async () => {
    const { keys, interactionEnv } = await setup();
    const response = await send(keys, interactionEnv, {
      ...claim("discord-ken", "edw"),
      type: 4,
    });
    expect(await response.json()).toEqual({ type: 8, data: { choices: [{ name: "Ken Edwards · Whole Hog GT", value: "ken" }] } });
  });

  it("posts a signed-in army list in sections in a thread on the public reply", async () => {
    const { keys, interactionEnv } = await setup();
    await seedClaim("discord-ken", "ken", "Ken Edwards");
    await env.DB.prepare("INSERT INTO bcp_auth VALUES ('access', 'bcp-token', ?)").bind(Date.now() + 3_600_000).run();
    const listText = Array.from({ length: 12 }, (_, i) => `Unit ${i}\n${"x".repeat(300)}`).join("\n\n");
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push([url, init]);
      if (url.endsWith("/v1/events/EVT1")) return json({ name: "Whole Hog GT", eventDate: "2026-12-05T14:00:00Z", hideLists: false });
      if (url.endsWith("/v1/armylists/LIST1")) return json({ armyListText: listText });
      if (url.includes("/messages/@original")) return json({ id: "reply-msg" });
      if (url.endsWith("/channels/event-discussion/messages/reply-msg/threads")) return json({ id: "thread" });
      if (url.endsWith("/channels/thread/messages")) return json({ id: "section" });
      throw new Error(`unexpected ${url}`);
    }));

    const response = await send(keys, interactionEnv, {
      type: 2, token: "tok", application_id: "app", channel_id: "event-discussion", member: { user: { id: "discord-ken" }, permissions: "0" },
      data: { name: "bcp", options: [{ name: "list", options: [{ name: "player", value: "EVT1:ken" }] }] },
    });
    vi.unstubAllGlobals();

    expect(await response.json()).toEqual({ type: 5 });
    const listCall = calls.find(([url]) => url.includes("/armylists/"));
    expect(new Headers(listCall?.[1]?.headers).get("Authorization")).toBe("Bearer bcp-token");
    const sections = calls.filter(([url]) => url.endsWith("/channels/thread/messages")).map(([, init]) => JSON.parse(String(init?.body)).content as string);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((section) => section.length <= 2_000 && section.startsWith("```"))).toBe(true);
    // Every unit lands whole in exactly one section, in order.
    expect(sections.join("").match(/Unit \d+/g)).toEqual(Array.from({ length: 12 }, (_, i) => `Unit ${i}`));
  });

  it("tells unclaimed members to claim first, and keeps public commands in the BCP channel", async () => {
    const { keys, interactionEnv } = await setup();
    const circuit = (discordId: string, channel: string) => ({
      type: 2, token: "t", application_id: "app", channel_id: channel, member: { user: { id: discordId }, permissions: "0" },
      data: { name: "bcp", options: [{ name: "circuit" }] },
    });
    const body = async (r: Response) => (await r.json<{ data: { content: string; flags: number } }>()).data;

    const unclaimed = await body(await send(keys, interactionEnv, circuit("newbie", "event-discussion")));
    expect(unclaimed.flags).toBe(64);
    expect(unclaimed.content).toContain("<@newbie>");
    expect(unclaimed.content).toContain("/bcp claim");

    await seedClaim("discord-ken", "ken", "Ken Edwards");
    const elsewhere = await body(await send(keys, interactionEnv, circuit("discord-ken", "general")));
    expect(elsewhere).toMatchObject({ flags: 64, content: "Use `/bcp circuit` in <#event-discussion>." });
    vi.stubGlobal("fetch", vi.fn(async () => json({ id: "reply" })));
    const here = await send(keys, interactionEnv, circuit("discord-ken", "event-discussion"));
    vi.unstubAllGlobals();
    expect(await here.json()).toEqual({ type: 5 });
  });

  it("posts the circuit as a cached table image with best event and most played faction", async () => {
    const { keys, interactionEnv } = await setup();
    await seedClaim("discord-ken", "ken", "Ken Edwards");
    const ev = env.DB.prepare("INSERT INTO bcp_events (bcp_id, name, starts_at, status) VALUES (?, ?, '2026-09-01T00:00:00Z', 'final')");
    const res = env.DB.prepare("INSERT INTO bcp_results VALUES (?, ?, 'x', ?, ?, '3-0-0', ?, '2026-27')");
    await env.DB.batch([
      ...["A", "B", "C"].map((id) => ev.bind(id, id)),
      // Ken won B, but A (2nd) scored more points (90 vs 80), so A is his best event.
      res.bind("A", "ken", "Orks", 2, 90), res.bind("A", "x1", null, 1, 0), res.bind("A", "x2", null, 3, 0),
      res.bind("B", "ken", "Necrons", 1, 80), res.bind("B", "x1", null, 2, 0),
      res.bind("C", "ken", "Necrons", 3, 10), res.bind("C", "x1", null, 1, 0), res.bind("C", "x2", null, 2, 0),
    ]);
    expect(await circuitStandings(env as Env, "2026-27")).toEqual([
      { discordUserId: "discord-ken", name: "Ken Edwards", points: 180, events: 3, bestEvent: "A", bestPlacing: 2, bestField: 3, faction: "Necrons" },
    ]);

    const patches: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      patches.push(init?.body as FormData);
      return json({ id: "reply" });
    }));
    const command = {
      type: 2, token: "t", application_id: "app", channel_id: "event-discussion", member: { user: { id: "discord-ken" }, permissions: "0" },
      data: { name: "bcp", options: [{ name: "circuit" }] },
    };
    await send(keys, interactionEnv, command);
    await send(keys, interactionEnv, command);
    vi.unstubAllGlobals();

    expect(patches).toHaveLength(2);
    expect(JSON.parse(String(patches[0].get("payload_json"))).content).toContain("`100 × pct²");
    const png = new Uint8Array(await (patches[0].get("files[0]") as Blob).arrayBuffer());
    expect([...png.slice(1, 4)].map((byte) => String.fromCharCode(byte)).join("")).toBe("PNG");
    // The second request reuses the stored image instead of drawing a new one.
    expect(new Uint8Array(await (patches[1].get("files[0]") as Blob).arrayBuffer())).toEqual(png);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM bcp_circuit_images").first()).toEqual({ n: 1 });
  });

  it("lists each event with its members as bullets, by name not mention", async () => {
    const { keys, interactionEnv } = await setup();
    await seedClaim("discord-ken", "ken", "Ken Edwards");
    const response = await send(keys, interactionEnv, {
      type: 2, token: "t", application_id: "app", channel_id: "event-discussion", member: { user: { id: "discord-ken" }, permissions: "0" },
      data: { name: "bcp", options: [{ name: "events" }] },
    });
    const { content } = (await response.json<{ data: { content: string } }>()).data;
    expect(content).toMatch(/\*\*\[Whole Hog GT\]\(<[^>]+>\)\*\* · <t:\d+:D>\n- Ken Edwards/);
    expect(content).not.toMatch(/<@\d*\w*>/);
  });

  it("shows a member's season privately, marking the best four as counted", async () => {
    const { keys, interactionEnv } = await setup();
    await seedClaim("discord-ken", "ken", "Ken Edwards");
    const ev = env.DB.prepare("INSERT INTO bcp_events (bcp_id, name, starts_at, status) VALUES (?, ?, '2026-09-01T00:00:00Z', 'final')");
    const res = env.DB.prepare("INSERT INTO bcp_results VALUES (?, 'ken', 'Ken Edwards', NULL, 1, '5-0-0', ?, ?)");
    await env.DB.batch([
      ...["A", "B", "C", "D", "E", "F"].map((id) => ev.bind(id, `Event ${id}`)),
      ...[10, 50, 20, 40, 30].map((points, i) => res.bind("ABCDE"[i], points, "2026-27")),
      res.bind("F", 99, "2025-26"),
    ]);
    const response = await send(keys, interactionEnv, {
      type: 2, token: "t", application_id: "app", channel_id: "general", member: { user: { id: "discord-ken" }, permissions: "0" },
      data: { name: "bcp", options: [{ name: "profile" }] },
    });
    const { data } = await response.json<{ data: { content: string; flags: number } }>();
    expect(data.flags).toBe(64);
    // Best four of 10, 50, 20, 40, 30 = 140; last season's 99 is excluded.
    expect(data.content).toContain("**140.0 pts** from your best 4 of 5 events");
    expect(data.content).toMatch(/✅ \*\*\[Event B\]/);
    expect(data.content).toContain("Event A](<https://www.bestcoastpairings.com/event/A>) · 1/1 · 5-0-0 · 10.0 pts (not counted)");
    expect(data.content).not.toContain("Event F");
  });

  it("lists every /bcp command privately", async () => {
    const { keys, interactionEnv } = await setup();
    const response = await send(keys, interactionEnv, {
      type: 2, token: "t", application_id: "app", member: { user: { id: "someone" }, permissions: "0" },
      data: { name: "bcp", options: [{ name: "help" }] },
    });
    const { data } = await response.json<{ data: { content: string; flags: number } }>();
    expect(data.flags).toBe(64);
    for (const name of ["claim", "unclaim", "events", "track", "list", "circuit", "help"]) expect(data.content).toContain(`/bcp ${name}`);
  });

  it("lets only mods unclaim someone else", async () => {
    const { keys, interactionEnv } = await setup();
    await seedClaim("discord-ken", "ken", "Ken Edwards");
    const unclaim = (permissions: string) => ({
      type: 2, token: "t", application_id: "app",
      member: { user: { id: "someone" }, permissions },
      data: { name: "bcp", options: [{ name: "unclaim", options: [{ name: "member", value: "discord-ken" }] }] },
    });

    await send(keys, interactionEnv, unclaim("0"));
    expect(await env.DB.prepare("SELECT 1 FROM bcp_claims").first()).not.toBeNull();
    await send(keys, interactionEnv, unclaim(String(1n << 5n)));
    expect(await env.DB.prepare("SELECT 1 FROM bcp_claims").first()).toBeNull();
  });
});

describe("listSections", () => {
  it("splits an oversized section by lines and never exceeds the limit", () => {
    const text = `Header\n\n${Array.from({ length: 80 }, (_, i) => `line ${i} ${"y".repeat(40)}`).join("\n")}`;
    const sections = listSections(text);
    expect(sections.every((section) => section.length <= 2_000)).toBe(true);
    expect(sections.join("").match(/line \d+/g)).toHaveLength(80);
  });
});

describe("BCP sign-in", () => {
  const jwt = (exp: number) => `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.y`;
  const authEnv = { ...botEnv, BCP_REFRESH_TOKEN: "refresh", BCP_ALERT_CHANNEL_ID: "alerts" } as Env;

  it("mints one access token and reuses it until it nears expiry", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const fetcher = vi.fn(async () => json({ accessToken: jwt(exp) })) as unknown as typeof fetch;

    expect(await bcpAccessToken(authEnv, fetcher)).toBe(jwt(exp));
    expect(await bcpAccessToken(authEnv, fetcher)).toBe(jwt(exp));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body))).toEqual({ refresh_token: "refresh", grant_type: "refresh_token" });
  });

  it("alerts once a day when BCP rejects the refresh token", async () => {
    const posts: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("discord.com")) {
        posts.push(JSON.parse(String(init?.body)).content);
        return json({ id: "alert" });
      }
      return json({ message: "Refresh Token has expired" }, 400);
    }) as unknown as typeof fetch;

    await expect(bcpAccessToken(authEnv, fetcher)).rejects.toThrow("400");
    await expect(bcpAccessToken(authEnv, fetcher)).rejects.toThrow("400");

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("scripts/bcp-login.ts");
  });
});
