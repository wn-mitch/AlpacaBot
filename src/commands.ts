// Slash command definitions, registered per guild by scripts/register-commands.ts.
// Kept import-free so Node can load it directly.
export const commands = [
  {
    name: "bcp",
    description: "SCD tournament tracking on Best Coast Pairings",
    options: [
      {
        type: 1, name: "claim", description: "Link your Discord account to your BCP name",
        options: [{ type: 3, name: "name", description: "Your name on BCP", required: true, autocomplete: true }],
      },
      {
        type: 1, name: "unclaim", description: "Remove a BCP link (mods can remove anyone's)",
        options: [{ type: 6, name: "member", description: "Member to unlink (default: you)" }],
      },
      { type: 1, name: "help", description: "List the /bcp commands (only you see it)" },
      {
        type: 1, name: "profile", description: "Your SCD Circuit events this season (only you see it)",
        options: [{ type: 3, name: "season", description: "Season, such as 2026-27" }],
      },
      { type: 1, name: "events", description: "Upcoming SCD calendar events and who's signed up" },
      {
        type: 1, name: "track", description: "Track a BCP event that isn't on the calendar (mods)",
        options: [{ type: 3, name: "link", description: "BCP event link", required: true }],
      },
      {
        type: 1, name: "list", description: "Post a player's army list from a tracked event in a thread",
        options: [{ type: 3, name: "player", description: "Player and event", required: true, autocomplete: true }],
      },
      {
        type: 1, name: "circuit", description: "SCD Circuit standings (seasons start July 1)",
        options: [{ type: 3, name: "season", description: "Season, such as 2026-27" }],
      },
    ],
  },
] as const;
