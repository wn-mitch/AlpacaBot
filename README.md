# AlpacaBot

[![Bot Testing](https://github.com/ChangedNameTo/AlpacaBot/actions/workflows/bot_testing.yml/badge.svg)](https://github.com/ChangedNameTo/AlpacaBot/actions/workflows/bot_testing.yml)

Cloudflare Worker that sends scheduled Discord event notifications, attendance threads, and Sleeper fantasy-football reports.

## Local development

1. Run `npm ci`.
2. Copy `.dev.vars.example` to `.dev.vars` and set a non-production Discord bot token, dedicated event bindings, a fantasy channel, and a current Sleeper league ID.
3. Run `npm run typecheck` and `npm test`.
4. Start the Worker with `npx wrangler dev --local`.

The cron runs every 5 minutes; hourly jobs act only at minute 0. The Worker needs `DISCORD_BOT_TOKEN`, `PICKLEBALL_CHANNEL_ID`, `PICKLEBALL_ROLE_ID`, `TRIVIA_CHANNEL_ID`, `TRIVIA_ROLE_ID`, `BOARD_GAME_CHANNEL_ID`, `FANTASY_CHANNEL_ID`, and `SLEEPER_LEAGUE_ID`. `BOARD_GAME_ROLE_ID` is optional. Fantasy reports use the `AI` Workers AI binding, which is configured as a remote binding while the rest of local development remains local.

The Discord bot needs `VIEW_CHANNEL` and `SEND_MESSAGES` in the selected fantasy channel. Fantasy reports are plain messages with emoji headings and fenced code blocks; all allowed mentions are disabled.

## BCP tournaments and SCD Circuit

Every 30 minutes the Worker reads the SCD server's Discord scheduled events and tracks any whose description or location links a Best Coast Pairings event. Mods can track others with `/bcp track <link>`. From 12 hours before an event starts, it polls BCP every 5 minutes. When BCP has published a whole round, it posts that round's pairings in `BCP_CHANNEL_ID` with claimed members bolded and records entering the round. When the event ends, it posts members' final placings and the circuit standings. It never mentions anyone. Only BCP's anonymous public API is used, except for army lists. `/bcp list` shows a player's list to the requester only, using the owner's BCP sign-in: run `node scripts/bcp-login.ts` after signing in to bestcoastpairings.com in Chrome to copy it into the `BCP_REFRESH_TOKEN` secret. If BCP rejects it, the bot alerts `BCP_ALERT_CHANNEL_ID` once a day. Lists hidden by the organizer stay hidden.

Members run `/bcp claim`, which autocompletes from tracked rosters, to link their Discord account to their BCP name. Each BCP name can be claimed by only one member; mods (Manage Server or Manage Events) can `/bcp unclaim` anyone. Every command except claim, unclaim and help requires a claimed name, and events, list and circuit only run in `BCP_CHANNEL_ID`. `/bcp help` lists the commands and `/bcp profile` shows your counted events, both privately; `/bcp events` lists upcoming events and which members are signed up; `/bcp circuit` shows standings.

SCD Circuit seasons run July 1 to June 30; the first, 2026-27, starts June 23, 2026 so ATC counts. Each event pays `100 × pct² × (1 + log₁₀(players ÷ 10)) × √(rounds ÷ 3)`, where pct = (players finished ahead of + 1) ÷ players, and a member's best 4 events count. A 3-round RTT of 10 or fewer players is the 100-point baseline; squaring pct keeps placing more important than event size. Team events (BCP `teamEvent`) are posted but not scored. Results are stored for every entrant, so members who claim later still get points for past events.

Setup: create the D1 database with `npx wrangler d1 create alpacabot-bcp`, put its ID in `wrangler.jsonc`, and run `npx wrangler d1 migrations apply alpacabot-bcp --remote`. Set `SCD_GUILD_ID` and `BCP_CHANNEL_ID` as variables and `DISCORD_PUBLIC_KEY` as a secret. Set the application's Interactions Endpoint URL to `https://<worker>/interactions`, then register the commands with `DISCORD_BOT_TOKEN=… DISCORD_APPLICATION_ID=… node scripts/register-commands.ts <guild-id>`.

Discord doesn't return ended scheduled events, so past events are backfilled from BCP links posted in the server: `DISCORD_BOT_TOKEN=… node scripts/bcp-backfill.ts 2026-06-23 > backfill.sql`, then `npx wrangler d1 execute alpacabot-bcp --remote --file backfill.sql`. Backfilled events never post.

## Schedule

All times use `America/New_York`. Pickleball, trivia, and board-game announcements post at their configured local hours and create attendance threads at 18:00 where configured. The Sunday pickleball ticket reminder has no attendance roll-up.

Fantasy reports run Tuesday 08:00 (recap and awards), Tuesday 18:00 (waivers), Wednesday 08:00 (power rankings and standings), Thursday 19:00 (matchup preview and predictions), Sunday 08:00 (injury watch), Sunday 16:00 and 20:00 (score updates), and Monday 08:00 (score update). The following top of the hour retries a pre-send failure with the same idempotency key.

At the season rollover, update `SLEEPER_LEAGUE_ID` to the new league only after that league is in season. Reports skip inactive leagues and season mismatches.

## Deployment

Set `DISCORD_BOT_TOKEN` with `npx wrangler secret put DISCORD_BOT_TOKEN`. Set `FANTASY_CHANNEL_ID` and `SLEEPER_LEAGUE_ID` as Worker environment variables, authenticate Wrangler for the remote `AI` binding, then add `CLOUDFLARE_API_TOKEN` as a GitHub Actions secret with only the account's Workers edit permissions. Pushes to `main` run typecheck and tests before `wrangler deploy`.
