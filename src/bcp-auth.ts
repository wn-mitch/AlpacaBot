import { postReport } from "./discord";
import type { Env } from "./events";
import { reportNonce } from "./fantasy";

// BCP signs in through a hosted page, so the bot keeps the owner's refresh token
// (BCP_REFRESH_TOKEN, captured by scripts/bcp-login.ts) and mints hourly access
// tokens from it. The refresh token does not rotate and lasts at least 90 days.
const tokenUrl = "https://newprod-api.bestcoastpairings.com/oauth/token";
const earlyRefreshMs = 5 * 60 * 1_000;

export async function bcpAccessToken(env: Env, fetcher: typeof fetch): Promise<string> {
  const cached = await env.DB.prepare("SELECT value, expires_at FROM bcp_auth WHERE key = 'access'")
    .first<{ value: string; expires_at: number }>();
  if (cached && cached.expires_at - earlyRefreshMs > Date.now()) return cached.value;
  if (!env.BCP_REFRESH_TOKEN) throw new Error("BCP_REFRESH_TOKEN is not set");

  const response = await fetcher(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "client-id": "web-app" },
    body: JSON.stringify({ refresh_token: env.BCP_REFRESH_TOKEN, grant_type: "refresh_token" }),
  });
  if (!response.ok) {
    await alertExpired(env, fetcher, response.status);
    throw new Error(`BCP token refresh failed with ${response.status}`);
  }
  const { accessToken } = await response.json<{ accessToken?: string }>();
  if (!accessToken) throw new Error("BCP token refresh returned no access token");
  const { exp } = JSON.parse(atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp: number };
  await env.DB.prepare(
    "INSERT INTO bcp_auth (key, value, expires_at) VALUES ('access', ?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?1, expires_at = ?2",
  )
    .bind(accessToken, exp * 1_000)
    .run();
  return accessToken;
}

// Rejected refresh tokens alert the mod channel at most once a day.
async function alertExpired(env: Env, fetcher: typeof fetch, status: number): Promise<void> {
  if (!env.BCP_ALERT_CHANNEL_ID || status < 400 || status >= 500) return;
  const key = `auth-expired:${new Date().toISOString().slice(0, 10)}`;
  const claimed = await env.DB.prepare("INSERT INTO bcp_posts (post_key, posted_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
    .bind(key, new Date().toISOString())
    .run();
  if (claimed.meta.changes !== 1) return;
  await postReport(
    fetcher,
    env.DISCORD_BOT_TOKEN,
    env.BCP_ALERT_CHANNEL_ID,
    await reportNonce(key),
    "⚠️ AlpacaBot's BCP sign-in expired, so `/bcp list` is off. Sign in to bestcoastpairings.com in Chrome on your Mac and run `node scripts/bcp-login.ts`. Pairings and results keep working.",
  );
}
