/**
 * add-font-to-bank.ts
 *
 * Signatures for a font outside /System/Library/Fonts (such as Roboto, the Latin face Android and much of the web use),
 * in the signature bank's own line format, written to a side bank that the scoring scripts read alongside the main one.
 * Uses the same computeEnrichedSignature() as the bank builder; for Arial and Georgia it reproduces the bank's entries
 * exactly.
 *
 * Every letter, mark and number the font covers is included.
 *
 * Usage:
 *   npx tsx scripts/add-font-to-bank.ts <font-file> <family> <out.jsonl.gz>
 */

import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { loadFont, extractGlyphPath, getFontMetrics, normalizeToGrid } from "../src/glyph-path.js";
import { computeEnrichedSignature } from "../src/raycasting.js";

const [file, family, outPath] = process.argv.slice(2);
if (!file || !family || !outPath) {
  console.error("usage: npx tsx scripts/add-font-to-bank.ts <font-file> <family> <out.jsonl.gz>");
  process.exit(2);
}

const font = loadFont(file)!;
const metrics = getFontMetrics(font);
const lines: string[] = [JSON.stringify({ type: "meta", generatedAt: new Date().toISOString(), font: family, source: file,
  gridSize: 128, numAngles: 36, raysPerAngle: 50 })];
let n = 0;
for (const cp of (font as any).characterSet as number[]) {
  if (!/^[\p{L}\p{M}\p{N}]$/u.test(String.fromCodePoint(cp))) continue;
  const glyph = font.glyphForCodePoint(cp);
  if (!glyph || glyph.id === 0) continue;
  const g = extractGlyphPath(font, cp);
  if (!g) continue;
  const sig = computeEnrichedSignature(normalizeToGrid(g, metrics, 128), 36, 50, 128);
  const entry: Record<string, unknown> = { font: family, glyphId: glyph.id, advanceWidth: g.advanceWidth,
    segmentCount: g.segments.length, counts: sig.counts };
  if (sig.positions.length) entry.positions = sig.positions;
  if (sig.angles.length) entry.angles = sig.angles;
  if (sig.pingDistances.length) entry.pingDistances = sig.pingDistances;
  if (sig.pingMax.length) entry.pingMax = sig.pingMax;
  lines.push(JSON.stringify({ type: "entry", cp: cp.toString(16).toUpperCase().padStart(4, "0"), entries: [entry] }));
  n++;
}
fs.writeFileSync(outPath, gzipSync(lines.join("\n") + "\n"));
// Register the family so glyph boxes can find the file
const registry = new URL("../data/output/side-bank-fonts.json", import.meta.url).pathname;
const known = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, "utf8")) : {};
known[family] = path.resolve(file);
fs.writeFileSync(registry, JSON.stringify(known, null, 2) + "\n");
console.log(`${n} signatures for ${family} -> ${outPath}`);
