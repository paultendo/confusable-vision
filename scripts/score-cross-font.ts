/**
 * score-cross-font.ts
 *
 * Lookalikes across fonts. A browser draws a character its page font lacks in a fallback font, next to Latin in the
 * page font, so a rare-script character is read against Latin from a different typeface. Within-font scoring cannot
 * see that.
 *
 * Distances across fonts are larger for everything: the same letter in two text fonts has a median release 2
 * distance near 1.0, where different letters sit near 1.8. So the test is relative. Character x in font F looks like
 * ASCII target t in reference font R when both
 *   - its shape distance to t@R is no larger than the median distance from t@R to t in the other reference fonts, and
 *   - its size and baseline gap to t@R (tops, bottoms, ink width, in em) is no larger than the same median for t;
 * that is, x@F is at least as close to t@R as t usually is to itself in another typeface. Two further conditions keep
 * an outlier reference font (a slab-serif Courier i, a serif Times E, far from the same letter elsewhere) from
 * stretching that floor until any complex glyph fits:
 *   - t is the nearest of the 62 ASCII letters and digits to x@F in R, so a reader would take x for t and not another
 *     letter, and
 *   - the distance is no more than GLOBAL_CAP, the median distance between the same letter in two text fonts.
 * A pair's share is the fraction of (F, R) combinations, F a text font rendering x and R a reference font, where it holds.
 *
 * Usage:
 *   npx tsx scripts/score-cross-font.ts <pairs.json> <out.jsonl>     pairs.json: [["U+13AA","U+0041"], ...] (x, t)
 *   npx tsx scripts/score-cross-font.ts --validate <out.jsonl>       Latin lowercase against Cyrillic and Greek
 *   --fallback-only   skip x when a reference font renders it (the page font would draw it, so within-font applies)
 */

import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { compareGeometric, type CompactBankTarget } from "../src/signature-bank.js";
import { DISPLAY_FONTS } from "../src/display-fonts.js";
import { boxGap, glyphBox } from "../src/glyph-box.js";
import { loadBankFor } from "../src/bank-load.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const BANK_PATH = path.join(ROOT, "data/output/signature-bank.jsonl.gz");
const NUM_ANGLES = 36;
const RAYS_PER_ANGLE = 50;

/** Common text faces a page is likely to be set in; Roboto is the Latin face on Android and much of the web. */
export const REFERENCE_FONTS = [
  "Roboto", "Arial", "Helvetica", "Helvetica Neue", "Times New Roman", "Georgia", "Verdana", "Tahoma", "Trebuchet MS",
  "Courier New", "Menlo", "Monaco", "Avenir", "Avenir Next", "Futura", "Gill Sans", "Optima", "Baskerville",
  "Palatino", "Charter", "Iowan Old Style",
];

/** Median release 2 distance between the same ASCII letter in two common text fonts (docs/metric-calibration.md). */
export const GLOBAL_CAP = 0.98;
const ASCII = [...Array.from({ length: 10 }, (_, i) => 0x30 + i), ...Array.from({ length: 26 }, (_, i) => 0x41 + i),
  ...Array.from({ length: 26 }, (_, i) => 0x61 + i)];

const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : Infinity;
};


async function main() {
  const validate = process.argv[2] === "--validate";
  const args = process.argv.slice(2).filter((a) => a !== "--fallback-only");
  const fallbackOnly = process.argv.includes("--fallback-only");
  const outPath = args[1]!;
  let pairs: [number, number][];
  if (validate) {
    const latin = Array.from({ length: 26 }, (_, i) => 0x61 + i);
    const other = [...Array.from({ length: 0x3ca - 0x3b1 }, (_, i) => 0x3b1 + i),
      ...Array.from({ length: 0x460 - 0x430 }, (_, i) => 0x430 + i), ...Array.from({ length: 0x530 - 0x500 }, (_, i) => 0x500 + i)];
    pairs = other.flatMap((x) => latin.map((t) => [x, t] as [number, number]));
  } else {
    pairs = (JSON.parse(fs.readFileSync(args[0]!, "utf8")) as [string, string][])
      .map(([x, t]) => [parseInt(x.slice(2), 16), parseInt(t.slice(2), 16)]);
  }
  const bank = await loadBankFor(new Set([...pairs.flat(), ...ASCII]));
  console.error(`${pairs.length} pairs; ${bank.size} code points found in the bank`);

  // The floor for each (target, reference font): how far the target usually is from itself in other reference fonts
  const floor = new Map<string, { shape: number; size: number }>();
  const floorFor = (t: number, r: string) => {
    const key = `${t}|${r}`;
    if (floor.has(key)) return floor.get(key)!;
    const ft = bank.get(t)!;
    const tr = ft.get(r), br = glyphBox(r, t);
    const shapes: number[] = [], sizes: number[] = [];
    for (const r2 of REFERENCE_FONTS) {
      if (r2 === r || !ft.has(r2) || !tr || !br) continue;
      const b2 = glyphBox(r2, t);
      if (!b2) continue;
      shapes.push(compareGeometric(ft.get(r2)!, tr, NUM_ANGLES, RAYS_PER_ANGLE));
      sizes.push(boxGap(b2, br));
    }
    const f = { shape: median(shapes), size: median(sizes) };
    floor.set(key, f);
    return f;
  };

  // Is t the nearest ASCII letter or digit to this glyph in reference font R?
  const nearestIs = (sx: CompactBankTarget, t: number, R: string, d: number) => {
    for (const u of ASCII) {
      if (u === t) continue;
      const su = bank.get(u)?.get(R);
      if (su && compareGeometric(sx, su, NUM_ANGLES, RAYS_PER_ANGLE) < d) return false;
    }
    return true;
  };

  const out = fs.openSync(outPath, "w");
  let n = 0;
  for (const [x, t] of pairs) {
    const fx = bank.get(x), ft = bank.get(t);
    if (!fx || !ft) continue;
    if (fallbackOnly && REFERENCE_FONTS.some((r) => fx.has(r))) continue;
    let combos = 0, alike = 0;
    const alikeIn: string[] = [];
    for (const [F, sx] of fx) {
      if (DISPLAY_FONTS.has(F)) continue;
      const bx = glyphBox(F, x);
      if (!bx) continue;
      for (const R of REFERENCE_FONTS) {
        if (R === F) continue;
        const st = ft.get(R), bt = glyphBox(R, t);
        if (!st || !bt) continue;
        combos++;
        const fl = floorFor(t, R);
        const d = compareGeometric(sx, st, NUM_ANGLES, RAYS_PER_ANGLE);
        if (boxGap(bx, bt) <= fl.size && d <= fl.shape && d <= GLOBAL_CAP && nearestIs(sx, t, R, d)) {
          alike++;
          if (alikeIn.length < 6) alikeIn.push(`${F} vs ${R}`);
        }
      }
    }
    if (++n % 200 === 0) console.error(`  ${n}/${pairs.length}`);
    if (!combos) continue;
    fs.writeSync(out, JSON.stringify({ x: hex(x), t: hex(t), combos, alike,
      share: Math.round((alike / combos) * 10000) / 10000, alikeIn }) + "\n");
  }
  fs.closeSync(out);
  console.error("done");
}

main();
