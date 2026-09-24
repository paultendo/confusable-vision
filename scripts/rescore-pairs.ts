/**
 * rescore-pairs.ts
 *
 * Release 2 scoring of every discovered pair. Three changes from the March run, each found by testing against pairs
 * whose answer is known (docs/metric-calibration.md):
 *
 *   1. compareGeometric() in place of compareEnrichedArrays(): shape differences count linearly and carry weight,
 *      so a straight stem against a curve (D against O) no longer passes as alike.
 *   2. Size and baseline: box signatures are drawn across each glyph's own box, so they ignore size and height. In running
 *      text every character sits at one size on one baseline, so a font only counts when the two glyphs' tops and
 *      text every character sits at one size on one baseline, so a font also needs the two glyphs' baseline-anchored
 *      signatures (compute-em-signatures.ts: one em frame, one scale, the baseline on one row) within EM_ALIKE. On the
 *      labelled pairs this kept more lookalikes than tolerances on tops, bottoms and widths, with no false match, and
 *      needs no hand-set tolerance. Where no anchored signature exists, the box gate (HEIGHT_TOLERANCE, WIDTH_TOLERANCE)
 *      is the fallback.
 *   3. The share of fonts: a pair is judged against every font that renders both characters, not only the fonts
 *      where it happened to be found alike, so a quirk of a few typefaces (small capitals, all-caps faces) stays one.
 *
 * compareGeometric() is never smaller than the March distance, so a pair the March run ruled out (distance above
 * 2.0, or widths more than 15% apart) stays ruled out: only discovered pairs, in the fonts where they were found,
 * need re-scoring.
 *
 * Usage:
 *   npx tsx scripts/rescore-pairs.ts <discoveries.jsonl>... > data/output/rescored-pairs.jsonl
 */

import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { compareGeometric, type CompactBankTarget } from "../src/signature-bank.js";
import { DISPLAY_FONTS } from "../src/display-fonts.js";
import { loadBankFor } from "../src/bank-load.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const BANK_PATH = path.join(ROOT, "data/output/signature-bank.jsonl.gz");
const BOXES_PATH = path.join(ROOT, "data/output/glyph-boxes.jsonl");
const NUM_ANGLES = 36;
const RAYS_PER_ANGLE = 50;
export const ALIKE = 0.5;
export const EM_ALIKE = 0.2;
export const HEIGHT_TOLERANCE = 0.12;
export const WIDTH_TOLERANCE = 0.25;

type Box = { yMin: number; yMax: number; xMin: number; xMax: number };

async function lines(file: string, gz = false) {
  const input = gz ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  return createInterface({ input, crlfDelay: Infinity });
}

async function main() {
  const found = new Map<string, Set<string>>(); // "A|B" -> fonts where the March scoring found the pair
  const cps = new Set<number>();
  for (const file of process.argv.slice(2)) {
    for await (const line of await lines(file)) {
      if (!line.startsWith('{"type":"discovery"')) continue;
      const o = JSON.parse(line);
      const [a, b] = [o.sourceCodepoint.slice(2), o.targetCodepoint.slice(2)].sort();
      const key = `${a}|${b}`;
      let fonts = found.get(key);
      if (!fonts) found.set(key, (fonts = new Set()));
      fonts.add(o.font);
      cps.add(parseInt(a, 16));
      cps.add(parseInt(b, 16));
    }
  }
  console.error(`${found.size} pairs over ${cps.size} code points`);

  const loaded = await loadBankFor(cps);
  const bank = new Map<string, Map<string, CompactBankTarget>>();
  for (const [cp, fonts] of loaded) bank.set(cp.toString(16).toUpperCase().padStart(4, "0"), fonts);

  // Baseline-anchored signatures, by code point and font
  const em = new Map<string, Map<string, CompactBankTarget>>();
  const emPath = path.join(ROOT, "data/output/em-signatures.jsonl.gz");
  if (fs.existsSync(emPath)) {
    for await (const line of await lines(emPath, true)) {
      if (!line.startsWith('{"type":"entry"')) continue;
      const o = JSON.parse(line);
      const fonts = new Map<string, CompactBankTarget>();
      for (const e of o.entries) fonts.set(e.font, { advanceWidth: e.advanceWidth, counts: Uint8Array.from(e.counts),
        positions: e.positions && Uint8Array.from(e.positions), angles: e.angles && Uint8Array.from(e.angles),
        pingDistances: e.pingDistances && Uint8Array.from(e.pingDistances), pingMax: e.pingMax && Uint8Array.from(e.pingMax) });
      em.set(o.cp, fonts);
    }
  }
  console.error(`${em.size} code points with baseline-anchored signatures`);

  const boxes = new Map<string, Box>();
  for await (const line of await lines(BOXES_PATH)) {
    if (!line.startsWith("{")) continue;
    const b = JSON.parse(line);
    boxes.set(`${b.cp}|${b.font}`, b);
  }
  const sameSize = (a: string, b: string, font: string) => {
    const x = boxes.get(`${a}|${font}`), y = boxes.get(`${b}|${font}`);
    if (!x || !y) return false;
    const wa = x.xMax - x.xMin, wb = y.xMax - y.xMin;
    return Math.max(Math.abs(x.yMax - y.yMax), Math.abs(x.yMin - y.yMin)) <= HEIGHT_TOLERANCE &&
      Math.abs(wa - wb) <= WIDTH_TOLERANCE * Math.max(wa, wb);
  };

  let done = 0;
  for (const [key, fonts] of found) {
    const [a, b] = key.split("|") as [string, string];
    const fa = bank.get(a), fb = bank.get(b);
    if (!fa || !fb) continue;
    let both = 0;
    let bothText = 0;
    for (const f of fa.keys()) {
      if (!fb.has(f)) continue;
      both++;
      if (!DISPLAY_FONTS.has(f)) bothText++;
    }
    const alike: [string, number][] = [];
    for (const font of fonts) {
      const ta = fa.get(font), tb = fb.get(font);
      if (!ta || !tb) continue;
      const ea = em.get(a)?.get(font), eb = em.get(b)?.get(font);
      if (ea && eb) {
        if (compareGeometric(ea, eb, NUM_ANGLES, RAYS_PER_ANGLE) >= EM_ALIKE) continue;
      } else if (!sameSize(a, b, font)) continue;
      const d = compareGeometric(ta, tb, NUM_ANGLES, RAYS_PER_ANGLE);
      if (d < ALIKE) alike.push([font, Math.round(d * 10000) / 10000]);
    }
    if (++done % 50000 === 0) console.error(`  scored ${done}/${found.size}`);
    if (alike.length === 0) continue;
    alike.sort((p, q) => p[1] - q[1]);
    const ds = alike.map(([, d]) => d);
    const alikeText = alike.filter(([f]) => !DISPLAY_FONTS.has(f)).length;
    process.stdout.write(JSON.stringify({
      a: `U+${a}`, b: `U+${b}`,
      fontsRenderingBoth: both,
      fontsAlike: alike.length,
      share: Math.round((alike.length / both) * 10000) / 10000,
      textFontsRenderingBoth: bothText,
      textFontsAlike: alikeText,
      textShare: bothText ? Math.round((alikeText / bothText) * 10000) / 10000 : 0,
      alikeFonts: Object.fromEntries(alike),
      meanDistanceWhereAlike: Math.round((ds.reduce((s, d) => s + d, 0) / ds.length) * 10000) / 10000,
      fontsAtZero: ds.filter((d) => d === 0).length,
      closestFonts: alike.slice(0, 5).map(([f]) => f),
    }) + "\n");
  }
  console.error("done");
}

main();
