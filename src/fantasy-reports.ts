import type {
  SleeperLeague,
  SleeperMatchup,
  SleeperPlayer,
  SleeperProjection,
  SleeperRoster,
  SleeperTrend,
  SleeperUser,
} from "./sleeper";

export interface LineupAssignment {
  playerId: string;
  slot: string;
  points: number;
}

export interface LineupResult {
  total: number;
  assignments: readonly LineupAssignment[];
}

export interface ReportFact {
  id: string;
  text: string;
}

export interface ReportCommentary {
  summary: string;
  highlights: readonly { factId: string; text: string }[];
}

export interface ReportData {
  content: string;
  facts: readonly ReportFact[];
  projectionSnapshot?: Readonly<Record<string, number>>;
}

const basePositions: Record<string, true> = {
  QB: true,
  RB: true,
  WR: true,
  TE: true,
  K: true,
  DEF: true,
};
const inactiveSlots: Record<string, true> = {
  BN: true,
  IR: true,
  TAXI: true,
};
const flexPositions: Record<string, readonly string[]> = {
  FLEX: ["RB", "WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  WRRB_FLEX: ["WR", "RB"],
  REC_FLEX: ["WR", "TE"],
};
export function sanitizeLabel(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? fallback)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/`/g, "'")
    .trim();
  return Array.from(cleaned).slice(0, 40).join("") || fallback;
}

export function rosterLabel(roster: SleeperRoster, users: ReadonlyMap<string, SleeperUser>): string {
  const user = roster.owner_id ? users.get(roster.owner_id) : undefined;
  return sanitizeLabel(user?.metadata?.team_name ?? user?.display_name ?? user?.username, `Roster ${roster.roster_id}`);
}

export function playerLabel(playerId: string, players: ReadonlyMap<string, SleeperPlayer>): string {
  const player = players.get(playerId);
  return sanitizeLabel(player?.full_name ?? [player?.first_name, player?.last_name].filter(Boolean).join(" "), `Player ${playerId}`);
}

export function projectedFantasyPoints(projection: SleeperProjection, scoring: Readonly<Record<string, number>>): number {
  return Object.entries(projection.stats).reduce((total, [stat, value]) => total + value * (scoring[stat] ?? 0), 0);
}

function eligible(
  playerId: string,
  slot: string,
  players: ReadonlyMap<string, SleeperPlayer>,
): boolean {
  if (playerId === "0") return false;

  const positions = players.get(playerId)?.fantasy_positions ?? [];
  if (Object.hasOwn(basePositions, slot)) {
    return positions.includes(slot);
  }
  return (flexPositions[slot] ?? []).some((position) =>
    positions.includes(position),
  );
}

export function optimizeLineup(
  playerIds: readonly string[],
  slots: readonly string[],
  pointsByPlayer: Readonly<Record<string, number>>,
  players: ReadonlyMap<string, SleeperPlayer>,
): LineupResult {
  const activeSlots = slots.filter(
    (slot) => !Object.hasOwn(inactiveSlots, slot),
  );
  if (
    activeSlots.some(
      (slot) =>
        !Object.hasOwn(basePositions, slot) &&
        !Object.hasOwn(flexPositions, slot),
    )
  ) {
    throw new Error("Unknown starting roster slot");
  }

  const candidates = playerIds.filter((id) => id !== "0");
  let bestTotal = 0;
  let best: LineupAssignment[] = [];

  const visit = (
    slotIndex: number,
    used: Set<string>,
    total: number,
    assignments: LineupAssignment[],
  ): void => {
    if (slotIndex >= activeSlots.length) {
      if (total > bestTotal) {
        bestTotal = total;
        best = [...assignments];
      }
      return;
    }

    const slot = activeSlots[slotIndex];
    visit(slotIndex + 1, used, total, assignments);
    for (const playerId of candidates) {
      if (used.has(playerId) || !eligible(playerId, slot, players)) {
        continue;
      }

      const points = pointsByPlayer[playerId] ?? 0;
      used.add(playerId);
      assignments.push({ playerId, slot, points });
      visit(slotIndex + 1, used, total + points, assignments);
      assignments.pop();
      used.delete(playerId);
    }
  };

  visit(0, new Set(), 0, []);
  return { total: bestTotal, assignments: best };
}

function fixed(value: number): string { return value.toFixed(2); }

const ZERO_WIDTH_DISPLAY_CHARACTER = /[\u200d\ufe0e\ufe0f]|\p{Mark}/u;
const EXTENDED_PICTOGRAPHIC_CHARACTER = /\p{Extended_Pictographic}/u;

function displayColumns(value: string): number {
  let columns = 0;
  for (const character of value) {
    if (ZERO_WIDTH_DISPLAY_CHARACTER.test(character)) {
      continue;
    }
    columns += EXTENDED_PICTOGRAPHIC_CHARACTER.test(character) ? 2 : 1;
  }
  return columns;
}

function padStartColumns(value: string, targetWidth: number): string {
  const padding = Math.max(0, targetWidth - displayColumns(value));
  return `${" ".repeat(padding)}${value}`;
}

function record(roster: SleeperRoster): string {
  const wins = roster.settings.wins ?? 0;
  const losses = roster.settings.losses ?? 0;
  const ties = roster.settings.ties ?? 0;
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}
function pointsFor(roster: SleeperRoster): number { return (roster.settings.fpts ?? 0) + (roster.settings.fpts_decimal ?? 0) / 100; }
interface ReportSection {
  heading?: string;
  lines: readonly string[];
}

export function validateReportContent(content: string): string {
  if (!content.trim()) throw new Error("Fantasy report content is required");
  if (Array.from(content).length > 2_000) throw new Error("Fantasy report exceeds Discord message limit");
  return content;
}

export function addCommentary(content: string, commentary: ReportCommentary): string {
  const highlights = commentary.highlights.length
    ? `\n\n✨ **Highlights**\n${commentary.highlights.map((item) => `• ${item.text}`).join("\n")}`
    : "";
  const decorated = `${content}\n\n💬 **Commentary**\n${commentary.summary}${highlights}`;
  try {
    return validateReportContent(decorated);
  } catch {
    return content;
  }
}

export function renderReport(
  title: string,
  sections: readonly ReportSection[],
  commentary?: ReportCommentary,
): string {
  const body = sections
    .map(({ heading, lines }) => {
      const headingLine = heading ? `${heading}\n` : "";
      return `${headingLine}\`\`\`text\n${lines.join("\n\n")}\n\`\`\``;
    })
    .join("\n\n");
  const content = validateReportContent(`${title}\n\n${body}`);
  return commentary ? addCommentary(content, commentary) : content;
}

function matchupGroups(matchups: readonly SleeperMatchup[]): Map<string, SleeperMatchup[]> {
  const groups = new Map<string, SleeperMatchup[]>();
  for (const matchup of matchups) {
    const key = matchup.matchup_id === null ? `bye:${matchup.roster_id}` : `matchup:${matchup.matchup_id}`;
    const group = groups.get(key) ?? [];
    group.push(matchup);
    groups.set(key, group);
  }
  for (const group of groups.values()) if (group.length > 2) throw new Error("Matchup has more than two rosters");
  return groups;
}

function usersById(users: readonly SleeperUser[]): ReadonlyMap<string, SleeperUser> { return new Map(users.map((user) => [user.user_id, user])); }
function rosterById(rosters: readonly SleeperRoster[]): ReadonlyMap<number, SleeperRoster> { return new Map(rosters.map((roster) => [roster.roster_id, roster])); }

export function buildPreview(
  leg: number,
  _occurrenceKey: string,
  league: SleeperLeague,
  rosters: readonly SleeperRoster[],
  users: readonly SleeperUser[],
  matchups: readonly SleeperMatchup[],
  projections: ReadonlyMap<string, SleeperProjection>,
  players: ReadonlyMap<string, SleeperPlayer>,
  commentary?: ReportCommentary,
): ReportData {
  const userMap = usersById(users);
  const rosterMap = rosterById(rosters);
  const projected: Record<string, number> = {};
  const lines: string[] = [];
  const facts: ReportFact[] = [];
  for (const roster of rosters) {
    const points: Record<string, number> = {};
    let complete = true;
    for (const playerId of roster.starters) {
      if (playerId === "0") continue;
      const projection = projections.get(playerId);
      if (!projection) {
        complete = false;
        break;
      }
      points[playerId] = projectedFantasyPoints(projection, league.scoring_settings);
    }
    if (complete) {
      projected[String(roster.roster_id)] = optimizeLineup(
        roster.players,
        league.roster_positions,
        points,
        players,
      ).total;
    }
  }
  for (const [key, group] of matchupGroups(matchups)) {
    if (group.length === 1) {
      const matchup = group[0];
      const roster = rosterMap.get(matchup.roster_id);
      if (!roster) {
        throw new Error("Matchup references unknown roster");
      }

      const label = rosterLabel(roster, userMap);
      const value = projected[String(roster.roster_id)];
      const projection =
        value === undefined
          ? "projection unavailable"
          : `projected ${fixed(value)}`;
      const text = `${label} (bye) — ${projection}`;
      lines.push(`${label}\n  ${record(roster)} | ${projection}\n  BYE`);
      facts.push({ id: `matchup:${key}`, text });
      continue;
    }

    const first = rosterMap.get(group[0].roster_id);
    const second = rosterMap.get(group[1].roster_id);
    if (!first || !second) {
      throw new Error("Matchup references unknown roster");
    }

    const firstLabel = rosterLabel(first, userMap);
    const secondLabel = rosterLabel(second, userMap);
    const firstValue = projected[String(first.roster_id)];
    const secondValue = projected[String(second.roster_id)];
    const projectionsAvailable =
      firstValue !== undefined && secondValue !== undefined;
    let prediction = "prediction unavailable";
    let firstProjection = "projection unavailable";
    let secondProjection = "projection unavailable";

    if (projectionsAvailable) {
      const predictedWinner =
        firstValue >= secondValue ? firstLabel : secondLabel;
      prediction = `${predictedWinner} predicted to win`;
      firstProjection = fixed(firstValue);
      secondProjection = fixed(secondValue);
    }

    const text = `${firstLabel} ${record(first)} ${firstProjection} vs ${secondLabel} ${record(second)} ${secondProjection} — ${prediction}`;
    const firstDisplay = projectionsAvailable
      ? `projected ${firstProjection}`
      : firstProjection;
    const secondDisplay = projectionsAvailable
      ? `projected ${secondProjection}`
      : secondProjection;
    lines.push(
      `${firstLabel}\n  ${record(first)} | ${firstDisplay}\nvs ${secondLabel}\n  ${record(second)} | ${secondDisplay}\nPick: ${prediction}`,
    );
    facts.push({ id: `matchup:${group[0].matchup_id}`, text });
  }
  return {
    content: renderReport(`🏈 **Week ${leg} Matchup Preview**`, [{ heading: "🔮 **Matchups**", lines }], commentary),
    facts,
    projectionSnapshot: projected,
  };
}

function weeklyAllPlay(matchups: readonly SleeperMatchup[]): Map<number, { wins: number; games: number }> {
  const active = matchups.filter((matchup) => matchup.matchup_id !== null);
  const result = new Map<number, { wins: number; games: number }>();
  for (const matchup of active) {
    let wins = 0;
    for (const other of active) if (other.roster_id !== matchup.roster_id) wins += matchup.points > other.points ? 1 : matchup.points === other.points ? 0.5 : 0;
    result.set(matchup.roster_id, { wins, games: Math.max(0, active.length - 1) });
  }
  return result;
}

export interface RankingRow { roster: SleeperRoster; allPlayPct: number; powerScore: number; pointsFor: number; recordPct: number }
export function calculateRankings(rosters: readonly SleeperRoster[], matchupsByWeek: readonly (readonly SleeperMatchup[])[]): RankingRow[] {
  const allPlayWins = new Map<number, number>(); const allPlayGames = new Map<number, number>();
  for (const matchups of matchupsByWeek) {
    const weekly = weeklyAllPlay(matchups);
    for (const [rosterId, result] of weekly) {
      allPlayWins.set(rosterId, (allPlayWins.get(rosterId) ?? 0) + result.wins);
      allPlayGames.set(rosterId, (allPlayGames.get(rosterId) ?? 0) + result.games);
    }
  }
  const points = rosters.map(pointsFor); const denominator = Math.max(1, rosters.length - 1);
  const rows = rosters.map((roster, index) => {
    const games = (roster.settings.wins ?? 0) + (roster.settings.losses ?? 0) + (roster.settings.ties ?? 0);
    const allGames = allPlayGames.get(roster.roster_id) ?? 0;
    const lower = points.filter((value) => value < points[index]).length;
    const equal = points.filter((value) => value === points[index]).length;
    const percentile = rosters.length === 1 ? 1 : (lower + 0.5 * (equal - 1)) / denominator;
    const recordPct = games ? ((roster.settings.wins ?? 0) + 0.5 * (roster.settings.ties ?? 0)) / games : 0;
    const allPlayPct = allGames ? (allPlayWins.get(roster.roster_id) ?? 0) / allGames : 0;
    const powerScore = 100 * (0.5 * allPlayPct + 0.3 * percentile + 0.2 * recordPct);
    return { roster, allPlayPct, powerScore, pointsFor: points[index], recordPct };
  });
  return rows.sort((a, b) => b.powerScore - a.powerScore || b.pointsFor - a.pointsFor || a.roster.roster_id - b.roster.roster_id);
}

export function buildPowerRankings(leg: number, _occurrenceKey: string, rosters: readonly SleeperRoster[], users: readonly SleeperUser[], matchups: readonly (readonly SleeperMatchup[])[], commentary?: ReportCommentary): ReportData {
  const rows = calculateRankings(rosters, matchups);
  const userMap = usersById(users);
  const rankingLines = rows.map((row, index) => `${index + 1}. ${rosterLabel(row.roster, userMap)}\n   composite ${fixed(row.powerScore)}`);
  const standingsLines = [...rows]
    .sort((a, b) => b.recordPct - a.recordPct || b.pointsFor - a.pointsFor || a.roster.roster_id - b.roster.roster_id)
    .map((row, index) => `${index + 1}. ${rosterLabel(row.roster, userMap)}\n   ${record(row.roster)} | ${fixed(row.pointsFor)} PF`);
  const facts = rows.map((row) => ({ id: `roster:${row.roster.roster_id}`, text: `${rosterLabel(row.roster, userMap)} composite ${fixed(row.powerScore)}` }));
  return {
    content: renderReport(
      `📈 **Week ${leg} Power Rankings & Standings**`,
      [
        { heading: "⚡ **Power Rankings**", lines: rankingLines },
        { heading: "📋 **Standings**", lines: standingsLines },
      ],
      commentary,
    ),
    facts,
  };
}

export function buildScoreUpdate(leg: number, kindLabel: string, _occurrenceKey: string, rosters: readonly SleeperRoster[], users: readonly SleeperUser[], matchups: readonly SleeperMatchup[]): ReportData {
  const map = usersById(users);
  const rosterMap = rosterById(rosters);
  const lines: string[] = [];
  const facts: ReportFact[] = [];
  for (const [key, group] of matchupGroups(matchups)) {
    if (group.length === 1) {
      const roster = rosterMap.get(group[0].roster_id);
      if (!roster) throw new Error("Matchup references unknown roster");
      lines.push(`${rosterLabel(roster, map)}\n  ${fixed(group[0].points)} | BYE`);
      continue;
    }
    const a = rosterMap.get(group[0].roster_id);
    const b = rosterMap.get(group[1].roster_id);
    if (!a || !b) throw new Error("Matchup references unknown roster");
    const margin = fixed(Math.abs(group[0].points - group[1].points));
    const text = `${rosterLabel(a, map)} ${fixed(group[0].points)} vs ${rosterLabel(b, map)} ${fixed(group[1].points)} — margin ${margin}`;
    lines.push(`${rosterLabel(a, map)}\n  ${fixed(group[0].points)}\nvs ${rosterLabel(b, map)}\n  ${fixed(group[1].points)}\nmargin ${margin}`);
    facts.push({ id: `matchup:${key}`, text });
  }
  return {
    content: renderReport(`🏟️ **Week ${leg} Score Update — ${kindLabel}**`, [{ heading: "📊 **Current Scores**", lines }]),
    facts,
  };
}

export function buildInjuryWatch(leg: number, _occurrenceKey: string, rosters: readonly SleeperRoster[], users: readonly SleeperUser[], players: ReadonlyMap<string, SleeperPlayer>): ReportData {
  const map = usersById(users);
  const lines: string[] = [];
  const facts: ReportFact[] = [];
  for (const roster of rosters) {
    const flagged = roster.starters
      .filter((id) => id !== "0")
      .map((id) => [id, players.get(id)] as const)
      .filter(([, player]) => player?.injury_status);
    if (flagged.length) {
      const text = `${rosterLabel(roster, map)} — ${flagged.map(([id, player]) => `${playerLabel(id, players)} (${sanitizeLabel(player?.injury_status ?? undefined, "unknown")})`).join(", ")}`;
      lines.push(`${rosterLabel(roster, map)}\n  ${flagged.map(([id, player]) => `${playerLabel(id, players)} (${sanitizeLabel(player?.injury_status ?? undefined, "unknown")})`).join("\n  ")}`);
      facts.push({ id: `roster:${roster.roster_id}`, text });
    }
  }
  if (!lines.length) lines.push("All clear: no starting players have an injury designation.");
  return {
    content: renderReport(`🚑 **Week ${leg} Starter Injury Watch**`, [{ heading: "🩺 **Flagged Starters**", lines }]),
    facts,
  };
}

export function buildRecap(
  leg: number,
  _occurrenceKey: string,
  league: SleeperLeague,
  rosters: readonly SleeperRoster[],
  users: readonly SleeperUser[],
  matchups: readonly SleeperMatchup[],
  players: ReadonlyMap<string, SleeperPlayer>,
  previewSnapshot?: ProjectionSnapshotLike,
  commentary?: ReportCommentary,
): ReportData {
  const userMap = usersById(users);
  const rosterMap = rosterById(rosters);
  const groups = matchupGroups(matchups);
  function labelFor(rosterId: number): string {
    const roster = rosterMap.get(rosterId);
    if (!roster) throw new Error("Matchup references unknown roster");
    return rosterLabel(roster, userMap);
  }

  const scoreRows: { left: string; right: string }[] = [];
  const headToHead = [...groups.values()].filter((group) => group.length === 2);
  for (const group of groups.values()) {
    const first = group[0];
    const left = `${labelFor(first.roster_id)} ${fixed(first.points).padStart(6)}`;
    if (group.length === 1) {
      scoreRows.push({ left, right: "BYE" });
      continue;
    }
    const second = group[1];
    const right = `${fixed(second.points).padStart(6)} ${labelFor(second.roster_id)}`;
    scoreRows.push({ left, right });
  }
  const leftColumnWidth = Math.max(0, ...scoreRows.map(({ left }) => displayColumns(left)));
  const scoreLines = scoreRows.map(({ left, right }) => `${padStartColumns(left, leftColumnWidth)} - ${right}`);

  interface Trophy {
    id: string;
    icon: string;
    name: string;
    result: string;
  }
  interface ManagerEfficiency {
    matchup: SleeperMatchup;
    actual: number;
    optimal: number;
    efficiency: number;
  }
  const trophies: Trophy[] = [];
  function addTrophy(id: string, icon: string, name: string, result: string): void {
    trophies.push({ id, icon, name, result });
  }
  const highest = matchups.length ? [...matchups].sort((a, b) => b.points - a.points || a.roster_id - b.roster_id)[0] : undefined;
  const lowest = matchups.length ? [...matchups].sort((a, b) => a.points - b.points || a.roster_id - b.roster_id)[0] : undefined;
  addTrophy("high-score", "👑", "High score", highest ? `${labelFor(highest.roster_id)} with ${fixed(highest.points)} points` : "Not awarded this week.");
  addTrophy("low-score", "💩", "Low score", lowest ? `${labelFor(lowest.roster_id)} with ${fixed(lowest.points)} points` : "Not awarded this week.");

  const margins = headToHead
    .filter((group) => group[0].points !== group[1].points)
    .map((group) => {
      const winner = group[0].points > group[1].points ? group[0] : group[1];
      const loser = winner === group[0] ? group[1] : group[0];
      return { winner, loser, margin: winner.points - loser.points };
    });
  const blowout = [...margins].sort((a, b) => b.margin - a.margin || a.winner.roster_id - b.winner.roster_id)[0];
  const closeWin = [...margins].sort((a, b) => a.margin - b.margin || a.winner.roster_id - b.winner.roster_id)[0];
  addTrophy("blowout", "😱", "Blow out", blowout ? `${labelFor(blowout.winner.roster_id)} blew out ${labelFor(blowout.loser.roster_id)} by ${fixed(blowout.margin)} points` : "Not awarded this week.");
  addTrophy("close-win", "😅", "Close win", closeWin ? `${labelFor(closeWin.winner.roster_id)} barely beat ${labelFor(closeWin.loser.roster_id)} by ${fixed(closeWin.margin)} points` : "Not awarded this week.");

  const winners = new Set(margins.map((result) => result.winner.roster_id));
  const losers = new Set(margins.map((result) => result.loser.roster_id));
  const allPlay = weeklyAllPlay(matchups);
  const lucky = [...allPlay.entries()]
    .filter(([rosterId, result]) => winners.has(rosterId) && result.games > 0 && result.wins / result.games < 0.5)
    .sort((a, b) => a[1].wins - b[1].wins || a[0] - b[0])[0];
  const unlucky = [...allPlay.entries()]
    .filter(([rosterId, result]) => losers.has(rosterId) && result.games > 0 && result.wins / result.games > 0.5)
    .sort((a, b) => b[1].wins - a[1].wins || a[0] - b[0])[0];
  function allPlayRecord(rosterId: number): string {
    const target = matchups.find((matchup) => matchup.roster_id === rosterId);
    if (!target) throw new Error("All-play record references unknown roster");
    let wins = 0;
    let losses = 0;
    let ties = 0;
    for (const other of matchups) {
      if (other.roster_id === rosterId || other.matchup_id === null) continue;
      if (target.points > other.points) wins++;
      else if (target.points < other.points) losses++;
      else ties++;
    }
    return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
  }
  addTrophy("lucky", "🍀", "Lucky", lucky ? `${labelFor(lucky[0])} was ${allPlayRecord(lucky[0])} against the league, but still got the win` : "Not awarded this week.");
  addTrophy("unlucky", "😡", "Unlucky", unlucky ? `${labelFor(unlucky[0])} was ${allPlayRecord(unlucky[0])} against the league, but still took an L` : "Not awarded this week.");

  const efficiencies: ManagerEfficiency[] = [];
  for (const matchup of matchups) {
    const roster = rosterMap.get(matchup.roster_id);
    if (!roster) throw new Error("Matchup references unknown roster");
    const optimal = optimizeLineup(roster.players, league.roster_positions, matchup.players_points, players).total;
    const actual = Object.values(matchup.starters_points).reduce((sum, value) => sum + value, 0) || matchup.points;
    if (optimal > 0) {
      efficiencies.push({ matchup, actual, optimal, efficiency: actual / optimal });
    }
  }
  const best = [...efficiencies].sort((a, b) => b.efficiency - a.efficiency || a.matchup.roster_id - b.matchup.roster_id)[0];
  const worst = [...efficiencies].sort((a, b) => a.efficiency - b.efficiency || a.matchup.roster_id - b.matchup.roster_id)[0];

  if (previewSnapshot) {
    const deltas = matchups
      .map((matchup) => ({ matchup, delta: matchup.points - (previewSnapshot.projectedPointsByRoster[String(matchup.roster_id)] ?? NaN) }))
      .filter((item) => Number.isFinite(item.delta));
    const over = [...deltas].sort((a, b) => b.delta - a.delta || a.matchup.roster_id - b.matchup.roster_id)[0];
    const under = [...deltas].sort((a, b) => a.delta - b.delta || a.matchup.roster_id - b.matchup.roster_id)[0];
    addTrophy("overachiever", "📈", "Overachiever", over ? `${labelFor(over.matchup.roster_id)} was ${fixed(Math.abs(over.delta))} points ${over.delta >= 0 ? "over" : "under"} their projection` : "Not awarded this week.");
    addTrophy("underachiever", "📉", "Underachiever", under ? `${labelFor(under.matchup.roster_id)} was ${fixed(Math.abs(under.delta))} points ${under.delta >= 0 ? "over" : "under"} their projection` : "Not awarded this week.");
  } else {
    addTrophy("overachiever", "📈", "Overachiever", "Not available; no locked preview snapshot.");
    addTrophy("underachiever", "📉", "Underachiever", "Not available; no locked preview snapshot.");
  }

  addTrophy("best-manager", "🤖", "Best Manager", best ? `${labelFor(best.matchup.roster_id)} scored ${fixed(best.efficiency * 100)}% of their optimal score!` : "Not awarded this week.");
  addTrophy("worst-manager", "🤡", "Worst Manager", worst ? `${labelFor(worst.matchup.roster_id)} left ${fixed(Math.max(0, worst.optimal - worst.actual))} points on their bench, scoring ${fixed(worst.efficiency * 100)}% of their optimal score.` : "Not awarded this week.");

  const facts = trophies.map((trophy) => ({ id: `award:${trophy.id}`, text: `${trophy.name}: ${trophy.result}` }));
  const trophyCards = trophies.map(
    (trophy) => `${trophy.icon} ${trophy.name} ${trophy.icon}\n${trophy.result}`,
  );
  return {
    content: renderReport(
      `🏁 **Final Score Update — Week ${leg}**`,
      [
        { lines: [scoreLines.join("\n")] },
        { heading: "🏆 **Trophies of the week**", lines: trophyCards },
      ],
      commentary,
    ),
    facts,
  };
}
export interface ProjectionSnapshotLike {
  projectedPointsByRoster: Readonly<Record<string, number>>;
}

export interface WaiverRecommendation {
  playerId: string;
  rosterId: number;
  gain: number;
  trendCount: number;
}

export interface WaiverReport {
  leagueWide: readonly WaiverRecommendation[];
  byRoster: ReadonlyMap<number, WaiverRecommendation>;
}

function compareWaiverRecommendations(
  first: WaiverRecommendation,
  second: WaiverRecommendation,
): number {
  return (
    second.gain - first.gain ||
    second.trendCount - first.trendCount ||
    first.playerId.localeCompare(second.playerId) ||
    first.rosterId - second.rosterId
  );
}

export function calculateWaivers(
  league: SleeperLeague,
  rosters: readonly SleeperRoster[],
  projections: ReadonlyMap<string, SleeperProjection>,
  trends: readonly SleeperTrend[],
  players: ReadonlyMap<string, SleeperPlayer>,
): WaiverReport {
  const rostered = new Set(rosters.flatMap((roster) => roster.players));
  const trendMap = new Map(
    trends.map((trend) => [trend.player_id, trend.count]),
  );
  const pointsByPlayer: Record<string, number> = {};
  for (const projection of projections.values()) {
    pointsByPlayer[projection.player_id] = projectedFantasyPoints(
      projection,
      league.scoring_settings,
    );
  }

  const currentLineups = rosters.map((roster) => ({
    roster,
    total: optimizeLineup(
      roster.players,
      league.roster_positions,
      pointsByPlayer,
      players,
    ).total,
  }));
  const recommendations: WaiverRecommendation[] = [];

  for (const [playerId] of projections) {
    if (rostered.has(playerId) || !players.has(playerId)) {
      continue;
    }

    for (const current of currentLineups) {
      const projected = optimizeLineup(
        [...current.roster.players, playerId],
        league.roster_positions,
        pointsByPlayer,
        players,
      ).total;
      recommendations.push({
        playerId,
        rosterId: current.roster.roster_id,
        gain: Math.max(0, projected - current.total),
        trendCount: trendMap.get(playerId) ?? 0,
      });
    }
  }

  recommendations.sort(compareWaiverRecommendations);
  const positiveRecommendations = recommendations.filter(
    (recommendation) => recommendation.gain > 0,
  );

  const bestByPlayer = new Map<string, WaiverRecommendation>();
  for (const recommendation of positiveRecommendations) {
    if (!bestByPlayer.has(recommendation.playerId)) {
      bestByPlayer.set(recommendation.playerId, recommendation);
    }
  }
  const leagueWide = [...bestByPlayer.values()].slice(0, 10);

  const byRoster = new Map<number, WaiverRecommendation>();
  for (const recommendation of positiveRecommendations) {
    if (!byRoster.has(recommendation.rosterId)) {
      byRoster.set(recommendation.rosterId, recommendation);
    }
  }

  return { leagueWide, byRoster };
}

export function buildWaivers(leg: number, _occurrenceKey: string, rosters: readonly SleeperRoster[], users: readonly SleeperUser[], players: ReadonlyMap<string, SleeperPlayer>, waivers: WaiverReport, commentary?: ReportCommentary): ReportData {
  const map = usersById(users);
  const top = waivers.leagueWide.map((item, index) => {
    const fit = rosters.find((roster) => roster.roster_id === item.rosterId);
    if (!fit) throw new Error("Waiver recommendation references unknown roster");
    return `${index + 1}. ${playerLabel(item.playerId, players)}\n   gain +${fixed(item.gain)}${item.trendCount ? ` | ${item.trendCount} adds` : ""}\n   best fit: ${rosterLabel(fit, map)}`;
  });
  const fits = rosters.map((roster) => {
    const item = waivers.byRoster.get(roster.roster_id);
    return item
      ? `${rosterLabel(roster, map)}\n  ${playerLabel(item.playerId, players)} | +${fixed(item.gain)}`
      : `${rosterLabel(roster, map)}\n  no positive upgrade`;
  });
  const facts = waivers.leagueWide.map((item) => ({ id: `player:${item.playerId}`, text: `${playerLabel(item.playerId, players)} +${fixed(item.gain)}` }));
  return {
    content: renderReport(
      `🧤 **Week ${leg} Waiver Wire**`,
      [
        { heading: "🔥 **Top Available Players**", lines: top.length ? top : ["No positive upgrades available."] },
        { heading: "🎯 **Best Fit by Roster**", lines: fits },
      ],
      commentary,
    ),
    facts,
  };
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function generateCommentary(ai: Ai, occurrenceKey: string, reportFacts: readonly ReportFact[]): Promise<ReportCommentary | undefined> {
  if (reportFacts.reduce((total, fact) => total + fact.text.length, 0) > 12_000) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(occurrenceKey));
  const seed = parseInt(Array.from(new Uint8Array(digest)).slice(0, 4).map((byte) => byte.toString(16).padStart(2, "0")).join(""), 16);
  const result: unknown = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: JSON.stringify(reportFacts) }],
    response_format: { type: "json_schema", json_schema: { type: "object", properties: { summary: { type: "string" }, highlights: { type: "array", items: { type: "object", properties: { factId: { type: "string" }, text: { type: "string" } }, required: ["factId", "text"] } } }, required: ["summary", "highlights"] } },
    max_tokens: 600,
    temperature: 0.5,
    seed,
  });
  let candidate: Record<string, unknown> | undefined;
  if (isObjectValue(result)) {
    if (isObjectValue(result.response)) candidate = result.response;
    else if (typeof result.response === "string") {
      try { const parsed: unknown = JSON.parse(result.response); if (isObjectValue(parsed)) candidate = parsed; } catch { return undefined; }
    } else candidate = result;
  }
  if (!candidate || typeof candidate.summary !== "string" || Array.from(candidate.summary).length > 4096 || !Array.isArray(candidate.highlights)) return undefined;
  const factIds = new Set(reportFacts.map((fact) => fact.id));
  const highlights: { factId: string; text: string }[] = [];
  for (const item of candidate.highlights) {
    if (!isObjectValue(item) || typeof item.factId !== "string" || typeof item.text !== "string" || Array.from(item.text).length > 1024 || !factIds.has(item.factId)) return undefined;
    highlights.push({ factId: item.factId, text: item.text });
  }
  return { summary: candidate.summary, highlights };
}
