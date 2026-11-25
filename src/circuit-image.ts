import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import interBold from "../assets/Inter-Bold.ttf";
import interRegular from "../assets/Inter-Regular.ttf";
import type { FactionStanding, Standing } from "./bcp";
import type { Env } from "./events";

// Bump when a layout changes so cached images are redrawn.
const layoutVersion = 4;
const rowHeight = 34;
const top = 96;
const medals = ["#f0b232", "#c0c6cf", "#d08a4f"];
// How many members the faction leaderboard shows.
export const factionLeaderCount = 3;

interface Column {
  title: string;
  x: number;
  anchor: "start" | "end";
  bold?: boolean;
}

let ready: Promise<void> | undefined;

const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// GW events lead with a generic "Warhammer 40,000 Grand Tournament:" that hides which one it was.
const eventName = (name: string) => name.replace(/^Warhammer 40,?000 Grand Tournament:\s*/i, "");
const ordinal = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
};
const bestEvent = (row: { bestEvent: string; bestPlacing: number; bestField: number }) =>
  `${clip(eventName(row.bestEvent), 34)} (${ordinal(row.bestPlacing)}/${row.bestField})`;

// A dark ranked table; the first column is the rank, and the top three get medal colors.
function tableSvg(width: number, title: string, subtitle: string, columns: readonly Column[], rows: readonly string[][]): string {
  const height = top + rows.length * rowHeight + 24;
  const cell = (x: number, y: number, anchor: string, text: string, style: string) =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" ${style}>${escape(text)}</text>`;
  const header = columns
    .map((column) => cell(column.x, top - 12, column.anchor, column.title, `fill="#949ba4" font-size="13" font-weight="700"`))
    .join("");
  const body = rows.map((values, index) => {
    const y = top + index * rowHeight;
    const text = `fill="#f2f3f5" font-size="16"`;
    const band = index % 2 === 0 ? `<rect x="12" y="${y}" width="${width - 24}" height="${rowHeight}" rx="6" fill="#2b2d31"/>` : "";
    return (
      band +
      values
        .map((value, column) => {
          const { x, anchor, bold } = columns[column];
          const style = column === 0 && index < 3 ? `fill="${medals[index]}" font-size="16" font-weight="700"` : bold ? `${text} font-weight="700"` : text;
          return cell(x, y + 22, anchor, value, style);
        })
        .join("")
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter">
<rect width="100%" height="100%" fill="#1e1f22"/>
${cell(24, 44, "start", title, `fill="#f2f3f5" font-size="26" font-weight="700"`)}
${cell(width - 24, 44, "end", subtitle, `fill="#949ba4" font-size="14"`)}
${header}
${body.join("\n")}
</svg>`;
}

export function circuitSvg(season: string, standings: readonly Standing[]): string {
  const columns: Column[] = [
    { title: "#", x: 24, anchor: "start" },
    { title: "Name", x: 72, anchor: "start", bold: true },
    { title: "Pts", x: 400, anchor: "end", bold: true },
    { title: "Events", x: 480, anchor: "end" },
    { title: "Best event", x: 510, anchor: "start" },
    { title: "Most played", x: 940, anchor: "start" },
  ];
  const rows = standings.map((row, index) => [
    String(index + 1),
    clip(row.name, 26),
    row.points.toFixed(1),
    String(row.events),
    bestEvent(row),
    clip(row.faction ?? "—", 24),
  ]);
  return tableSvg(1200, `SCD Circuit ${season}`, `${standings.length} members · best 4 events count`, columns, rows);
}

export function factionSvg(season: string, faction: string, standings: readonly FactionStanding[]): string {
  const columns: Column[] = [
    { title: "#", x: 24, anchor: "start" },
    { title: "Name", x: 72, anchor: "start", bold: true },
    { title: "Pts", x: 400, anchor: "end", bold: true },
    { title: "Events", x: 480, anchor: "end" },
    { title: "Record", x: 580, anchor: "end" },
    { title: "Best event", x: 610, anchor: "start" },
  ];
  const rows = standings.slice(0, factionLeaderCount).map((row, index) => [
    String(index + 1),
    clip(row.name, 26),
    row.points.toFixed(1),
    String(row.events),
    row.record,
    bestEvent(row),
  ]);
  const players = `${standings.length} SCD player${standings.length === 1 ? "" : "s"}`;
  return tableSvg(1060, `${clip(faction, 28)} · ${season}`, `${players} · best 4 events count`, columns, rows);
}

async function renderPng(svg: string): Promise<Uint8Array> {
  ready ??= initWasm(resvgWasm);
  await ready;
  const resvg = new Resvg(svg, {
    font: { fontBuffers: [new Uint8Array(interRegular), new Uint8Array(interBold)], defaultFontFamily: "Inter", loadSystemFonts: false },
    fitTo: { mode: "zoom", value: 2 },
  });
  try {
    return resvg.render().asPng();
  } finally {
    resvg.free();
  }
}

// Standings only change when an event finalizes or someone claims, so each image is
// kept under its key and redrawn only when the rows it shows differ.
async function cachedPng(env: Env, key: string, rows: unknown, svg: () => string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([layoutVersion, rows])));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const cached = await env.DB.prepare("SELECT png FROM bcp_circuit_images WHERE season = ? AND hash = ?").bind(key, hash).first<{ png: ArrayBuffer | number[] }>();
  if (cached) return new Uint8Array(cached.png);
  const png = await renderPng(svg());
  await env.DB.prepare("INSERT OR REPLACE INTO bcp_circuit_images (season, hash, png) VALUES (?, ?, ?)").bind(key, hash, png).run();
  return png;
}

export const circuitPng = (env: Env, season: string, standings: readonly Standing[]) =>
  cachedPng(env, season, standings, () => circuitSvg(season, standings));

// Keyed by season and faction, so each faction keeps its own latest image.
export const factionPng = (env: Env, season: string, faction: string, standings: readonly FactionStanding[]) =>
  cachedPng(env, `${season}:${faction}`, [faction, standings], () => factionSvg(season, faction, standings));
