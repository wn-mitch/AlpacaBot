import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import interBold from "../assets/Inter-Bold.ttf";
import interRegular from "../assets/Inter-Regular.ttf";
import type { Standing } from "./bcp";
import type { Env } from "./events";

// Bump when the layout changes so cached images are redrawn.
const layoutVersion = 1;
const width = 960;
const rowHeight = 34;
const top = 96;
const columns = [
  { title: "#", x: 24, anchor: "start" },
  { title: "Name", x: 72, anchor: "start" },
  { title: "Pts", x: 450, anchor: "end" },
  { title: "Events", x: 540, anchor: "end" },
  { title: "Best", x: 650, anchor: "end" },
  { title: "Most played", x: 690, anchor: "start" },
] as const;
const medals = ["#f0b232", "#c0c6cf", "#d08a4f"];

let ready: Promise<void> | undefined;

const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const ordinal = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
};

export function circuitSvg(season: string, standings: readonly Standing[]): string {
  const height = top + standings.length * rowHeight + 24;
  const cell = (x: number, y: number, anchor: string, text: string, style: string) =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" ${style}>${escape(text)}</text>`;
  const header = columns
    .map((column) => cell(column.x, top - 12, column.anchor, column.title, `fill="#949ba4" font-size="13" font-weight="700"`))
    .join("");
  const rows = standings.map((row, index) => {
    const y = top + index * rowHeight;
    const baseline = y + 22;
    const text = `fill="#f2f3f5" font-size="16"`;
    const values = [
      String(index + 1),
      clip(row.name, 30),
      row.points.toFixed(1),
      String(row.events),
      `${ordinal(row.bestPlacing)} / ${row.bestField}`,
      clip(row.faction ?? "—", 26),
    ];
    const band = index % 2 === 0 ? `<rect x="12" y="${y}" width="${width - 24}" height="${rowHeight}" rx="6" fill="#2b2d31"/>` : "";
    return (
      band +
      values
        .map((value, column) => {
          const { x, anchor } = columns[column];
          const style = column === 0 && index < 3 ? `fill="${medals[index]}" font-size="16" font-weight="700"` : column <= 2 ? `${text} font-weight="700"` : text;
          return cell(x, baseline, anchor, value, style);
        })
        .join("")
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter">
<rect width="100%" height="100%" fill="#1e1f22"/>
${cell(24, 44, "start", `SCD Circuit ${season}`, `fill="#f2f3f5" font-size="26" font-weight="700"`)}
${cell(width - 24, 44, "end", `${standings.length} members · best 4 events count`, `fill="#949ba4" font-size="14"`)}
${header}
${rows.join("\n")}
</svg>`;
}

export async function renderCircuitPng(season: string, standings: readonly Standing[]): Promise<Uint8Array> {
  ready ??= initWasm(resvgWasm);
  await ready;
  const resvg = new Resvg(circuitSvg(season, standings), {
    font: { fontBuffers: [new Uint8Array(interRegular), new Uint8Array(interBold)], defaultFontFamily: "Inter", loadSystemFonts: false },
    fitTo: { mode: "zoom", value: 2 },
  });
  try {
    return resvg.render().asPng();
  } finally {
    resvg.free();
  }
}

// Standings only change when an event finalizes or someone claims, so the PNG is
// kept per season and redrawn only when the rows it shows differ.
export async function circuitPng(env: Env, season: string, standings: readonly Standing[]): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([layoutVersion, standings])));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const cached = await env.DB.prepare("SELECT png FROM bcp_circuit_images WHERE season = ? AND hash = ?").bind(season, hash).first<{ png: ArrayBuffer | number[] }>();
  if (cached) return new Uint8Array(cached.png);
  const png = await renderCircuitPng(season, standings);
  await env.DB.prepare("INSERT OR REPLACE INTO bcp_circuit_images (season, hash, png) VALUES (?, ?, ?)").bind(season, hash, png).run();
  return png;
}
