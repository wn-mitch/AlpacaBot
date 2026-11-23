# AlpacaBot

[![Bot Testing](https://github.com/ChangedNameTo/AlpacaBot/actions/workflows/bot_testing.yml/badge.svg)](https://github.com/ChangedNameTo/AlpacaBot/actions/workflows/bot_testing.yml)

Cloudflare Worker that sends scheduled Discord event notifications, attendance threads, and Sleeper fantasy-football reports.

## Local development

1. Run `npm ci`.
2. Copy `.dev.vars.example` to `.dev.vars` and set a non-production Discord bot token, dedicated event bindings, a fantasy channel, and a current Sleeper league ID.
3. Run `npm run typecheck` and `npm test`.
4. Start the Worker with `npx wrangler dev --local`.

The Worker needs `DISCORD_BOT_TOKEN`, `PICKLEBALL_CHANNEL_ID`, `PICKLEBALL_ROLE_ID`, `TRIVIA_CHANNEL_ID`, `TRIVIA_ROLE_ID`, `BOARD_GAME_CHANNEL_ID`, `FANTASY_CHANNEL_ID`, and `SLEEPER_LEAGUE_ID`. `BOARD_GAME_ROLE_ID` is optional. Fantasy reports use the `AI` Workers AI binding, which is configured as a remote binding while the rest of local development remains local.

The Discord bot needs `VIEW_CHANNEL` and `SEND_MESSAGES` in the selected fantasy channel. Fantasy reports are plain messages with emoji headings and fenced code blocks; all allowed mentions are disabled.

## Schedule

All times use `America/New_York`. Pickleball, trivia, and board-game announcements post at their configured local hours and create attendance threads at 18:00 where configured. The Sunday pickleball ticket reminder has no attendance roll-up.

Fantasy reports run Tuesday 08:00 (recap and awards), Tuesday 18:00 (waivers), Wednesday 08:00 (power rankings and standings), Thursday 19:00 (matchup preview and predictions), Sunday 08:00 (injury watch), Sunday 16:00 and 20:00 (score updates), and Monday 08:00 (score update). The following top of the hour retries a pre-send failure with the same idempotency key.

At the season rollover, update `SLEEPER_LEAGUE_ID` to the new league only after that league is in season. Reports skip inactive leagues and season mismatches.

## Deployment

Set `DISCORD_BOT_TOKEN` with `npx wrangler secret put DISCORD_BOT_TOKEN`. Set `FANTASY_CHANNEL_ID` and `SLEEPER_LEAGUE_ID` as Worker environment variables, authenticate Wrangler for the remote `AI` binding, then add `CLOUDFLARE_API_TOKEN` as a GitHub Actions secret with only the account's Workers edit permissions. Pushes to `main` run typecheck and tests before `wrangler deploy`.
