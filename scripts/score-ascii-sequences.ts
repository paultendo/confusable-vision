/**
 * score-ascii-sequences.ts
 *
 * ASCII lookalikes, including sequences that pass for one letter: rn for m, vv for w, cl for d. Domain names are
 * lowercase letters, digits and hyphens, so the search is systematic over that alphabet rather than a hand-picked
 * list: every letter and digit against every other, and every two-character sequence against every single one.
 *
 * Each string is laid out as it would be set in text (the font's kerning and ligatures, extractSequencePath) and
 * measured exactly as release 2 measures a character (rescore-pairs.ts): a box-relative signature for shape, compared
 * with compareGeometric() under ALIKE, and a baseline-anchored signature in the em frame under EM_ALIKE, so size and
 * position in running text count. A pair is alike in a font only when both hold; it passes when it meets the release's
 * same-font thresholds (src/thresholds.ts). The fonts are the release's: those the signature bank measured for the
 * letter a.
 *
 * Before scoring, the single characters are recomputed and compared with the bank's own signatures, so the measurement
 * here is shown to be the release's.
 *
 * Usage:
 *   npx tsx scripts/score-ascii-sequences.ts
 *
 * Output: data/output/ascii-sequences.jsonl (every pair alike in at least one text font, with a `passes` flag)
 */

import fs from "node:fs";
import path from "node:path";
import { compareGeometric, type CompactBankTarget } from "../src/signature-bank.js";
import { SignaturePool } from "../src/signature-pool.js";
import { DISPLAY_FONTS } from "../src/display-fonts.js";
import { loadBankFor } from "../src/bank-load.js";
import { loadFont, extractGlyphPath, extractSequencePath, getFontMetrics, normalizeToGrid, normalizeToEmFrame, emFrame } from "../src/glyph-path.js";
import { systemFontPaths } from "../src/glyph-box.js";
import { passes } from "../src/thresholds.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "data/output/ascii-sequences.jsonl");
const NUM_ANGLES = 36, RAYS = 50, GRID = 128;
const ALIKE = 0.5, EM_ALIKE = 0.2; // rescore-pairs.ts

const SINGLES = [..."abcdefghijklmnopqrstuvwxyz0123456789"];
const PAIRS = SINGLES.flatMap((x) => SINGLES.map((y) => x + y));

const compact = (s: { counts: number[]; positions: number[]; angles: number[]; pingDistances: number[]; pingMax: number[] },
  advanceWidth: number): CompactBankTarget => {
  const t: CompactBankTarget = { advanceWidth, counts: Uint8Array.from(s.counts) };
  if (s.positions.length) t.positions = Uint8Array.from(s.positions);
  if (s.angles.length) t.angles = Uint8Array.from(s.angles);
  if (s.pingDistances.length) t.pingDistances = Uint8Array.from(s.pingDistances);
  if (s.pingMax.length) t.pingMax = Uint8Array.from(s.pingMax);
  return t;
};

type Sigs = { box: CompactBankTarget; em: CompactBankTarget };

async function main() {
  // The release's fonts: every font the bank measured for "a"
  const bankA = (await loadBankFor(new Set([0x61]))).get(0x61)!;
  const paths = systemFontPaths();
  const fonts = [...bankA.keys()].filter((f) => paths.has(f)).sort();
  console.error(`${fonts.length} fonts (${fonts.filter((f) => !DISPLAY_FONTS.has(f)).length} text) of ${bankA.size} in the bank`);

  // Outlines are laid out here; the signatures are computed on every core but one (SignaturePool)
  const pool = new SignaturePool();
  const sigs = new Map<string, Map<string, Sigs>>(); // font -> string -> signatures
  let done = 0;
  for (const family of fonts) {
    const jobs: Promise<void>[] = []; // one font at a time, so only its outlines are held
    const font = loadFont(paths.get(family)!);
    if (!font) continue;
    const metrics = getFontMetrics(font);
    const m = new Map<string, Sigs>();
    sigs.set(family, m);
    for (const text of [...SINGLES, ...PAIRS]) {
      const g = text.length === 1 ? extractGlyphPath(font, text.codePointAt(0)!) : extractSequencePath(font, text);
      if (!g) continue;
      jobs.push(Promise.all([
        pool.compute(normalizeToGrid(g, metrics, GRID), undefined, NUM_ANGLES, RAYS, GRID),
        pool.compute(normalizeToEmFrame(g, font.unitsPerEm, GRID), emFrame(GRID), NUM_ANGLES, RAYS, GRID),
      ]).then(([box, em]) => {
        m.set(text, { box: compact(box, g.advanceWidth), em: compact(em, g.advanceWidth) });
      }));
    }
    await Promise.all(jobs);
    console.error(`  ${++done}/${fonts.length} ${family}`);
  }
  await pool.close();
  // The same measurement as the release: "a" here against the bank's "a" in each font
  let check = 0, checked = 0;
  for (const [family, m] of sigs) {
    const mine = m.get("a"), theirs = bankA.get(family);
    if (mine && theirs) { check = Math.max(check, compareGeometric(mine.box, theirs, NUM_ANGLES, RAYS)); checked++; }
  }
  console.error(`self-check: largest distance from the bank's own signature for "a" across ${checked} fonts: ${check.toFixed(4)}`);
  if (check > 0.01) { console.error("signatures differ from the bank's; not scoring"); process.exit(1); }

  const out = fs.createWriteStream(OUT);
  let alikeRows = 0, passing = 0;
  const sources = [...SINGLES, ...PAIRS];
  for (const b of SINGLES) {
    for (const a of sources) {
      if (a === b) continue;
      if (a.length === 1 && a > b) continue; // single against single: each pair once
      let both = 0, bothText = 0;
      const alike: [string, number][] = [];
      for (const [family, m] of sigs) {
        const sa = m.get(a), sb = m.get(b);
        if (!sa || !sb) continue;
        both++;
        const text = !DISPLAY_FONTS.has(family);
        if (text) bothText++;
        if (compareGeometric(sa.em, sb.em, NUM_ANGLES, RAYS) >= EM_ALIKE) continue;
        const d = compareGeometric(sa.box, sb.box, NUM_ANGLES, RAYS);
        if (d < ALIKE) alike.push([family, Math.round(d * 10000) / 10000]);
      }
      const alikeText = alike.filter(([f]) => !DISPLAY_FONTS.has(f));
      if (!alikeText.length) continue;
      alike.sort((p, q) => p[1] - q[1]);
      const row = {
        a, b, method: "same font",
        fontsRenderingBoth: both, fontsAlike: alike.length, share: Math.round((alike.length / both) * 10000) / 10000,
        textFontsRenderingBoth: bothText, textFontsAlike: alikeText.length,
        textShare: bothText ? Math.round((alikeText.length / bothText) * 10000) / 10000 : 0,
        alikeFonts: Object.fromEntries(alike),
        closestFonts: alike.filter(([f]) => !DISPLAY_FONTS.has(f)).slice(0, 5).map(([f]) => f),
      };
      const ok = passes(row);
      out.write(JSON.stringify({ ...row, passes: ok }) + "\n");
      alikeRows++;
      if (ok) passing++;
    }
  }
  out.end();
  console.error(`${alikeRows} pairs alike in at least one text font, ${passing} pass the release thresholds -> ${OUT}`);
}

main();
