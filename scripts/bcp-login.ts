// Copies the BCP sign-in from Chrome into the Worker's BCP_REFRESH_TOKEN secret.
// Sign in at bestcoastpairings.com in Chrome first, then: node scripts/bcp-login.ts
// The token is read from Chrome's local storage, checked against BCP, and piped
// straight to `wrangler secret put`; it is never printed or written to disk.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClassicLevel } from "classic-level";

const profile = process.argv[2] ?? "Default";
const source = join(homedir(), "Library/Application Support/Google/Chrome", profile, "Local Storage/leveldb");
const copy = mkdtempSync(join(tmpdir(), "bcp-login-"));
let refreshToken: string | undefined;
try {
  // Chrome holds a lock on its own copy while running.
  cpSync(source, copy, { recursive: true });
  rmSync(join(copy, "LOCK"), { force: true });
  const db = new ClassicLevel<Buffer, Buffer>(copy, { keyEncoding: "buffer", valueEncoding: "buffer" });
  const key = Buffer.from("_https://www.bestcoastpairings.com\x00\x01AuthIdentityServiceProvider.web-app.refreshToken");
  const value = await db.get(key).catch(() => undefined);
  await db.close();
  // Chrome prefixes each value with 0 for UTF-16 or 1 for Latin-1.
  if (value) refreshToken = value.subarray(1).toString(value[0] === 0 ? "utf16le" : "latin1");
} finally {
  rmSync(copy, { recursive: true, force: true });
}
if (!refreshToken) {
  console.error(`No BCP sign-in found in Chrome profile "${profile}". Sign in at bestcoastpairings.com and retry.`);
  process.exit(1);
}

const check = await fetch("https://newprod-api.bestcoastpairings.com/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/json", "client-id": "web-app" },
  body: JSON.stringify({ refresh_token: refreshToken, grant_type: "refresh_token" }),
});
if (!check.ok) {
  console.error(`BCP rejected Chrome's sign-in (${check.status}). Sign in again and retry.`);
  process.exit(1);
}

const put = spawnSync("npx", ["wrangler", "secret", "put", "BCP_REFRESH_TOKEN"], { input: refreshToken, stdio: ["pipe", "inherit", "inherit"] });
process.exit(put.status ?? 1);
