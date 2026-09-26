/**
 * score-exhaustive.ts
 *
 * Every pair, in every font. Release 2 re-scored the pairs the March run had found, in the fonts where it found them,
 * so its coverage was March's: pairs March never compared (and whole groups of characters, such as the Greek and
 * Cyrillic capitals, that were never in the signature bank) could not appear, even when a font draws the two with the
 * same glyph. audit-glyph-identity.ts showed the result: 24% of the (pair, font) cases where two characters are
 * identical were in the release.
 *
 * This compares every pair of characters in the set, in every font that draws both, with release 2's measurement
 * (compareGeometric on the box signature under ALIKE, and on the baseline-anchored em signature under EM_ALIKE).
 * Signatures are computed here from the fonts, so nothing depends on what an earlier bank or run contained. The
 * baseline-anchored test takes the lower distance of two horizontal centrings, on the advance (release 2) and on the
 * ink (see normalizeToEmFrame): on the advance alone, identical outlines with different side bearings failed EM_ALIKE
 * (g and ɡ in STSong); on the ink alone, 1 and I stop lining up. On calibrate-em.ts's labelled pairs, the lower of the
 * two keeps and flags exactly what the advance alone does at 0.2.
 *
 * The set: every measured character outside Han (Han against the rest is a separate pass), every uppercase form of
 * those that has one, and the ASCII letters and digits. Pairs from the same script are compared too, and flagged.
 *
 * Usage:
 *   CV_BANK=... npx tsx scripts/score-exhaustive.ts [--fonts N]      (N limits the fonts, for timing)
 *
 * Output: data/output/exhaustive-pairs.jsonl, one row per pair alike in at least one font, with every font's distances
 * and the counts of fonts (and text fonts) that draw both.
 */

import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { compareGeometric, type CompactBankTarget } from "../src/signature-bank.js";
import { SignaturePool } from "../src/signature-pool.js";
import { DISPLAY_FONTS } from "../src/display-fonts.js";
import { loadBankFor } from "../src/bank-load.js";
import { loadFont, extractGlyphPath, getFontMetrics, normalizeToGrid, normalizeToEmFrame, emFrame } from "../src/glyph-path.js";
import { systemFontPaths } from "../src/glyph-box.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "data/output/exhaustive-pairs.jsonl");
const NUM_ANGLES = 36, RAYS = 50, GRID = 128;
const ALIKE = 0.5, EM_ALIKE = 0.2; // rescore-pairs.ts
const limit = process.argv.includes("--fonts") ? parseInt(process.argv[process.argv.indexOf("--fonts") + 1]!, 10) : Infinity;

const compact = (s: { counts: number[]; positions: number[]; angles: number[]; pingDistances: number[]; pingMax: number[] },
  advanceWidth: number): CompactBankTarget => {
  const t: CompactBankTarget = { advanceWidth, counts: Uint8Array.from(s.counts) };
  if (s.positions.length) t.positions = Uint8Array.from(s.positions);
  if (s.angles.length) t.angles = Uint8Array.from(s.angles);
  if (s.pingDistances.length) t.pingDistances = Uint8Array.from(s.pingDistances);
  if (s.pingMax.length) t.pingMax = Uint8Array.from(s.pingMax);
  return t;
};

async function main() {
  const release = path.join(ROOT, "data/release", fs.readdirSync(path.join(ROOT, "data/release")).sort().at(-1)!);
  const measured = gunzipSync(fs.readFileSync(path.join(release, "characters.jsonl.gz"))).toString().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).filter((c) => c.script !== "Han");
  const set = new Set<number>(measured.map((c) => parseInt(c.codepoint.slice(2), 16)));
  for (const ch of "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") set.add(ch.codePointAt(0)!);
  for (const cp of [...set]) {
    const up = String.fromCodePoint(cp).toUpperCase();
    if ([...up].length === 1 && up.codePointAt(0) !== cp) set.add(up.codePointAt(0)!);
  }
  const cps = [...set].sort((a, b) => a - b);
  const index = new Map(cps.map((cp, i) => [cp, i]));
  const n = cps.length;
  console.error(`${n} characters, ${(n * (n - 1)) / 2} pairs`);

  const bankA = (await loadBankFor(new Set([0x61]))).get(0x61)!;
  const paths = systemFontPaths();
  const fonts = [...bankA.keys()].filter((f) => paths.has(f)).sort().slice(0, limit);
  console.error(`${fonts.length} fonts`);

  // Per pair: fonts that draw both (all, and text), and the fonts where alike with both distances
  const both = new Uint16Array(n * n), bothText = new Uint16Array(n * n);
  const alike = new Map<number, [string, number, number][]>();
  const pool = new SignaturePool();
  const started = Date.now();
  let done = 0;
  for (const family of fonts) {
    const font = loadFont(paths.get(family)!);
    if (!font) continue;
    const metrics = getFontMetrics(font);
    const text = !DISPLAY_FONTS.has(family);
    const have: number[] = [];
    const sigs = new Map<number, { box: CompactBankTarget; em: CompactBankTarget; ink: CompactBankTarget }>();
    const jobs: Promise<void>[] = [];
    for (const cp of cps) {
      let g;
      try { if (font.glyphForCodePoint(cp).id === 0) continue; g = extractGlyphPath(font, cp); } catch { continue; }
      if (!g) continue;
      const gg = g;
      jobs.push(Promise.all([
        pool.compute(normalizeToGrid(gg, metrics, GRID), undefined, NUM_ANGLES, RAYS, GRID),
        pool.compute(normalizeToEmFrame(gg, font.unitsPerEm, GRID), emFrame(GRID), NUM_ANGLES, RAYS, GRID),
        pool.compute(normalizeToEmFrame(gg, font.unitsPerEm, GRID, "ink"), emFrame(GRID), NUM_ANGLES, RAYS, GRID),
      ]).then(([box, em, ink]) => {
        sigs.set(cp, { box: compact(box, gg.advanceWidth), em: compact(em, gg.advanceWidth), ink: compact(ink, gg.advanceWidth) });
        have.push(cp);
      }));
    }
    await Promise.all(jobs);
    have.sort((a, b) => a - b);
    let found = 0;
    for (let i = 0; i < have.length; i++) {
      const a = have[i]!, sa = sigs.get(a)!, ia = index.get(a)!;
      for (let j = i + 1; j < have.length; j++) {
        const b = have[j]!, sb = sigs.get(b)!, k = ia * n + index.get(b)!;
        both[k]++;
        if (text) bothText[k]++;
        // Cheap first: the baseline-anchored test fails for most pairs
        let e = compareGeometric(sa.em, sb.em, NUM_ANGLES, RAYS);
        if (e >= EM_ALIKE) e = Math.min(e, compareGeometric(sa.ink, sb.ink, NUM_ANGLES, RAYS));
        if (e >= EM_ALIKE) continue;
        const d = compareGeometric(sa.box, sb.box, NUM_ANGLES, RAYS);
        if (d >= ALIKE) continue;
        (alike.get(k) ?? alike.set(k, []).get(k)!).push([family, Math.round(d * 10000) / 10000, Math.round(e * 10000) / 10000]);
        found++;
      }
    }
    const mins = (Date.now() - started) / 60000;
    console.error(`  ${++done}/${fonts.length} ${family}: ${have.length} characters, ${found} alike (${mins.toFixed(1)} min)`);
  }
  await pool.close();

  const out = fs.createWriteStream(OUT);
  const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  for (const [k, list] of alike) {
    const a = cps[Math.floor(k / n)]!, b = cps[k % n]!;
    const textAlike = list.filter(([f]) => !DISPLAY_FONTS.has(f)).length;
    out.write(JSON.stringify({
      a: hex(a), b: hex(b), method: "same font",
      sameScript: sameScript(a, b),
      fontsRenderingBoth: both[k], fontsAlike: list.length, share: Math.round((list.length / both[k]!) * 10000) / 10000,
      textFontsRenderingBoth: bothText[k], textFontsAlike: textAlike,
      textShare: bothText[k] ? Math.round((textAlike / bothText[k]!) * 10000) / 10000 : 0,
      alike: Object.fromEntries(list.sort((p, q) => p[1] - q[1]).map(([f, d, e]) => [f, [d, e]])),
    }) + "\n");
  }
  out.end();
  console.error(`${alike.size} pairs alike in at least one font -> ${OUT}`);
}

// Two characters share a script when their Unicode Script property is the same (Common and Inherited never count)
const SCRIPTS = ["Latin", "Greek", "Cyrillic", "Armenian", "Hebrew", "Arabic", "Devanagari", "Bengali", "Thai", "Georgian",
  "Hiragana", "Katakana", "Hangul", "Cherokee", "Lisu", "Canadian_Aboriginal", "Ethiopic", "Tifinagh", "Coptic", "Gothic"];
function scriptOf(cp: number): string {
  const ch = String.fromCodePoint(cp);
  for (const s of SCRIPTS) if (new RegExp(`\\p{Script=${s}}`, "u").test(ch)) return s;
  return "Other";
}
function sameScript(a: number, b: number): boolean {
  const sa = scriptOf(a);
  return sa !== "Other" && sa === scriptOf(b);
}

main();
