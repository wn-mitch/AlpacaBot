// Registers /bcp in one guild: node scripts/register-commands.ts <guild-id>
// Reads DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID from the environment.
import { commands } from "../src/commands.ts";

const guildId = process.argv[2];
const { DISCORD_BOT_TOKEN: token, DISCORD_APPLICATION_ID: appId } = process.env;
if (!guildId || !token || !appId) {
  console.error("usage: DISCORD_BOT_TOKEN=… DISCORD_APPLICATION_ID=… node scripts/register-commands.ts <guild-id>");
  process.exit(1);
}
const response = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});
console.log(response.status, (await response.text()).slice(0, 500));
if (!response.ok) process.exit(1);
