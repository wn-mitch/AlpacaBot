import { describe, expect, it } from "vitest";
import { buildRecap, optimizeLineup, projectedFantasyPoints, renderReport, sanitizeLabel, validateReportContent } from "../src/fantasy-reports";
import type { SleeperLeague, SleeperPlayer, SleeperRoster } from "../src/sleeper";

const players = new Map<string, SleeperPlayer>([
  ["qb", { player_id: "qb", fantasy_positions: ["QB"], full_name: "Quarterback" }],
  ["rb", { player_id: "rb", fantasy_positions: ["RB"], full_name: "Runner" }],
  ["wr", { player_id: "wr", fantasy_positions: ["WR"], full_name: "Receiver" }],
  ["te", { player_id: "te", fantasy_positions: ["TE"], full_name: "Tight End" }],
]);

const SCORE_SEPARATOR = " - ";
const ZERO_WIDTH_DISPLAY_CHARACTER = /[\u200d\ufe0e\ufe0f]|\p{Mark}/u;
const EXTENDED_PICTOGRAPHIC_CHARACTER = /\p{Extended_Pictographic}/u;

function textCodeBlockLines(content: string, blockNumber: number): string[] {
  const block = content.split("```text\n")[blockNumber];
  if (block === undefined) {
    throw new Error(`Missing text code block ${blockNumber}`);
  }
  return block.split("\n```")[0].split("\n");
}

function separatorDisplayColumn(line: string, separator = SCORE_SEPARATOR): number {
  const separatorIndex = line.indexOf(separator);
  if (separatorIndex < 0) {
    throw new Error(`Missing separator ${separator}`);
  }

  let columns = 0;
  for (const character of line.slice(0, separatorIndex)) {
    if (ZERO_WIDTH_DISPLAY_CHARACTER.test(character)) {
      continue;
    }
    columns += EXTENDED_PICTOGRAPHIC_CHARACTER.test(character) ? 2 : 1;
  }
  return columns;
}

describe("fantasy report calculations", () => {
  it("uses custom scoring and rounds only for display consumers", () => {
    expect(projectedFantasyPoints({ player_id: "qb", fantasy_positions: ["QB"], stats: { pass_yd: 250, pass_td: 2, pts_ppr: 99 } }, { pass_yd: 0.1, pass_td: 6 })).toBe(37);
  });

  it.each([
    [["QB", "RB", "FLEX"], { qb: 10, rb: 8, wr: 12, te: 2 }, 30],
    [["SUPER_FLEX", "FLEX"], { qb: 10, rb: 8, wr: 12, te: 2 }, 22],
    [["REC_FLEX"], { qb: 10, rb: 8, wr: 12, te: 2 }, 12],
  ] as const)("optimizes supported slots", (slots, points, total) => {
    expect(optimizeLineup(["qb", "rb", "wr", "te"], slots, points, players).total).toBe(total);
  });

  it("ignores placeholders and reserve slots and rejects unknown starters", () => {
    expect(optimizeLineup(["rb", "0"], ["RB", "BN", "IR"], { rb: -2 }, players).total).toBe(0);
    expect(() => optimizeLineup(["rb"], ["MYSTERY"], { rb: 2 }, players)).toThrow("Unknown starting roster slot");
  });

  it("sanitizes controls, code fences, and long labels", () => {
    expect(sanitizeLabel(" @everyone\n**te`am** ", "fallback")).toBe("@everyone**te'am**");
    expect(sanitizeLabel(undefined, "fallback")).toBe("fallback");
  });

  it("enforces Discord plain-message limits", () => {
    expect(() => validateReportContent("x".repeat(2001))).toThrow("message limit");
  });

  it("renders emoji-accented plain messages with code blocks", () => {
    const content = renderReport("🏆 **Recap**", [{ heading: "🏈 **Final Scores**", lines: ["Alpha\n  10.00", "Beta\n  8.00"] }]);
    expect(content).toContain("🏆 **Recap**");
    expect(content).toContain("🏈 **Final Scores**\n```text");
    expect(content).toContain("Alpha\n  10.00\n\nBeta");
  });

  it("renders the compact final-score and trophy format", () => {
    const league: SleeperLeague = {
      league_id: "league",
      status: "in_season",
      season: "2025",
      scoring_settings: {},
      roster_positions: ["SUPER_FLEX"],
      settings: { leg: 17, last_scored_leg: 17 },
      total_rosters: 2,
    };
    const rosters: SleeperRoster[] = [
      { roster_id: 1, owner_id: "one", players: ["qb"], starters: ["qb"], settings: { wins: 1, losses: 0 } },
      { roster_id: 2, owner_id: "two", players: ["rb"], starters: ["rb"], settings: { wins: 0, losses: 1 } },
    ];
    const report = buildRecap(
      17,
      "fantasy:weekly-recap:test",
      league,
      rosters,
      [
        { user_id: "one", display_name: "Long Team Name One" },
        { user_id: "two", display_name: "Long Team Name Two" },
      ],
      [
        { roster_id: 1, matchup_id: 1, points: 120, starters: ["qb"], starters_points: { qb: 120 }, players_points: { qb: 120 } },
        { roster_id: 2, matchup_id: 1, points: 100, starters: ["rb"], starters_points: { rb: 100 }, players_points: { rb: 100 } },
      ],
      players,
    );
    expect(report.content).toContain("🏁 **Final Score Update — Week 17**");
    expect(report.content).toContain("```text\nLong Team Name One 120.00 - 100.00 Long Team Name Two");
    const trophyCards = textCodeBlockLines(report.content, 2).join("\n").split("\n\n");
    expect(trophyCards).toHaveLength(10);
    expect(trophyCards.every((card) => card.split("\n").length === 2)).toBe(true);
    expect(trophyCards).toContain("👑 High score 👑\nLong Team Name One with 120.00 points");
    expect(trophyCards).toContain("😱 Blow out 😱\nLong Team Name One blew out Long Team Name Two by 20.00 points");
    expect(trophyCards).toContain("🤡 Worst Manager 🤡\nLong Team Name One left 0.00 points on their bench, scoring 100.00% of their optimal score.");
    expect(report.content).not.toContain("embeds");
  });

  it("aligns Unicode score rows and awards lucky and unlucky only to actual winners and losers", () => {
    const league: SleeperLeague = {
      league_id: "league",
      status: "in_season",
      season: "2025",
      scoring_settings: {},
      roster_positions: ["SUPER_FLEX"],
      settings: { leg: 17, last_scored_leg: 17 },
      total_rosters: 4,
    };
    const rosters: SleeperRoster[] = [
      { roster_id: 1, owner_id: "one", players: ["qb"], starters: ["qb"], settings: {} },
      { roster_id: 2, owner_id: "two", players: ["rb"], starters: ["rb"], settings: {} },
      { roster_id: 3, owner_id: "three", players: ["wr"], starters: ["wr"], settings: {} },
      { roster_id: 4, owner_id: "four", players: ["te"], starters: ["te"], settings: {} },
    ];
    const report = buildRecap(
      17,
      "fantasy:weekly-recap:awards",
      league,
      rosters,
      [
        { user_id: "one", display_name: "Lu\u0301cky Winner" },
        { user_id: "two", display_name: "Low Loser" },
        { user_id: "three", display_name: "🏈️ Unlucky Loser" },
        { user_id: "four", display_name: "High Winner" },
      ],
      [
        { roster_id: 1, matchup_id: 1, points: 90, starters: ["qb"], starters_points: { qb: 90 }, players_points: { qb: 90 } },
        { roster_id: 2, matchup_id: 1, points: 80, starters: ["rb"], starters_points: { rb: 80 }, players_points: { rb: 80 } },
        { roster_id: 3, matchup_id: 2, points: 100, starters: ["wr"], starters_points: { wr: 100 }, players_points: { wr: 100 } },
        { roster_id: 4, matchup_id: 2, points: 110, starters: ["te"], starters_points: { te: 110 }, players_points: { te: 110 } },
      ],
      players,
      { projectedPointsByRoster: { "1": 100, "2": 70, "3": 120, "4": 95 } },
    );
    const scoreLines = textCodeBlockLines(report.content, 1);
    expect(new Set(scoreLines.map((line) => separatorDisplayColumn(line))).size).toBe(1);
    expect(scoreLines).toEqual([
      "    Lúcky Winner  90.00 -  80.00 Low Loser",
      "🏈️ Unlucky Loser 100.00 - 110.00 High Winner",
    ]);
    const trophyCards = textCodeBlockLines(report.content, 2).join("\n").split("\n\n");
    expect(trophyCards).toHaveLength(10);
    expect(trophyCards.every((card) => card.split("\n").length === 2)).toBe(true);
    expect(trophyCards).toContain("👑 High score 👑\nHigh Winner with 110.00 points");
    expect(trophyCards).toContain("💩 Low score 💩\nLow Loser with 80.00 points");
    expect(trophyCards).toContain("🍀 Lucky 🍀\nLúcky Winner was 1-2 against the league, but still got the win");
    expect(trophyCards).toContain("😡 Unlucky 😡\n🏈️ Unlucky Loser was 2-1 against the league, but still took an L");
    expect(trophyCards).toContain("📈 Overachiever 📈\nHigh Winner was 15.00 points over their projection");
    expect(trophyCards).toContain("📉 Underachiever 📉\n🏈️ Unlucky Loser was 20.00 points under their projection");
  });
});
