/**
 * platform-bank.ts
 *
 * Signatures for each character in the font a platform actually draws it with. Whether two characters look alike is
 * a question about how they look where people see them, so a count of fonts is not enough: what matters is each
 * character's default font (SF for Latin in the macOS address bar, Thonburi for Thai, Noto Sans NKo for NKo; Roboto
 * and Noto on Android).
 *
 * Input is one JSON line per character with its font and outline, in font units and fontkit's command format:
 *   {"cp","family","drawable","unitsPerEm","ascent","descent","advance","commands"}
 * from scripts/macos-fallback.swift (CoreText's own fallback choice and outline) or scripts/android-outlines.ts.
 *
 * Writes a side bank of signatures labelled "<platform>:<family>" and a map from character to that font and its glyph
 * box in em units.
 *
 * Usage:
 *   npx tsx scripts/platform-bank.ts <platform> <outlines.jsonl>
 *
 * Output: data/output/signature-bank-<platform>.jsonl.gz, data/output/platform-<platform>.json
 */

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { commandsToSegments, computeBBox, normalizeToGrid } from "../src/glyph-path.js";
import { computeEnrichedSignature } from "../src/raycasting.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const [platform, inputPath] = process.argv.slice(2);
if (!platform || !inputPath) {
  console.error("usage: npx tsx scripts/platform-bank.ts <platform> <outlines.jsonl>");
  process.exit(2);
}

async function main() {
  const lines: string[] = [JSON.stringify({ type: "meta", generatedAt: new Date().toISOString(), platform,
    source: path.basename(inputPath!) })];
  const map: Record<string, { font: string; box: Record<string, number> }> = {};
  let done = 0, skipped = 0;
  const rl = createInterface({ input: fs.createReadStream(inputPath!), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (!r.drawable || !r.commands?.length) { skipped++; continue; }
    const segments = commandsToSegments(r.commands.map(([command, ...args]: [string, ...number[]]) => ({ command, args })));
    if (!segments.length) { skipped++; continue; }
    const bbox = computeBBox(segments);
    const glyph = { segments, advanceWidth: r.advance, bbox };
    const metrics = { unitsPerEm: r.unitsPerEm, ascender: r.ascent, descender: r.descent };
    const sig = computeEnrichedSignature(normalizeToGrid(glyph, metrics, 128), 36, 50, 128);
    const label = `${platform}:${r.family}`;
    const entry: Record<string, unknown> = { font: label, advanceWidth: r.advance, segmentCount: segments.length, counts: sig.counts };
    if (sig.positions.length) entry.positions = sig.positions;
    if (sig.angles.length) entry.angles = sig.angles;
    if (sig.pingDistances.length) entry.pingDistances = sig.pingDistances;
    if (sig.pingMax.length) entry.pingMax = sig.pingMax;
    lines.push(JSON.stringify({ type: "entry", cp: r.cp, entries: [entry] }));
    const em = r.unitsPerEm;
    map[`U+${r.cp}`] = { font: label, box: { xMin: bbox.minX / em, yMin: bbox.minY / em, xMax: bbox.maxX / em,
      yMax: bbox.maxY / em, advance: r.advance / em } };
    if (++done % 5000 === 0) console.error(`  ${done}`);
  }
  fs.writeFileSync(path.join(ROOT, `data/output/signature-bank-${platform}.jsonl.gz`), gzipSync(lines.join("\n") + "\n"));
  fs.writeFileSync(path.join(ROOT, `data/output/platform-${platform}.json`), JSON.stringify(map) + "\n");
  console.error(`${done} characters drawn in their ${platform} default font; ${skipped} not drawable`);
}

main();
