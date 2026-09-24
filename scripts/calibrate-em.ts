/**
 * calibrate-em.ts
 *
 * Tests baseline-anchored signatures (normalizeToEmFrame + a fixed em frame) against pairs whose answer is known, in
 * the common text fonts plus Roboto:
 *   - ASCII letters and digits (development set): distinct except TR39's own ASCII mappings and 0/o;
 *   - held out: Latin lowercase against Cyrillic and Greek lowercase, where TR39's mappings are the lookalikes.
 * No size gate: size and position are inside the distance. Reports, for each distance cut, how many lookalikes are
 * kept and how many distinct pairs are flagged, using the release rule (alike in at least 3 fonts, or all that render
 * both if fewer, and at least 5% of them).
 *
 * Usage:
 *   npx tsx scripts/calibrate-em.ts
 */

import fs from "node:fs";
import path from "node:path";
import { SignaturePool } from "../src/signature-pool.js";
import { loadFont, extractGlyphPath, normalizeToEmFrame, emFrame } from "../src/glyph-path.js";
import { compareGeometric, type CompactBankTarget } from "../src/signature-bank.js";

/** compareGeometric, but averaging each angle over the rays that hit at least one of the two glyphs. */
function compareActive(a: CompactBankTarget, b: CompactBankTarget, numAngles: number, raysPerAngle: number): number {
  let offA = 0, offB = 0, meanSum = 0, maxAngle = 0;
  for (let ai = 0; ai < numAngles; ai++) {
    let sum = 0, active = 0;
    for (let ri = 0; ri < raysPerAngle; ri++) {
      const i = ai * raysPerAngle + ri, cA = a.counts[i]!, cB = b.counts[i]!, m = Math.min(cA, cB);
      if (cA || cB) active++;
      let ray = Math.abs(cA - cB);
      if (m > 0) {
        let pos = 0, ang = 0, pd = 0, pm = 0;
        for (let p = 0; p < m; p++) {
          pos += Math.abs(a.positions![offA + p]! - b.positions![offB + p]!);
          ang += Math.abs(a.angles![offA + p]! - b.angles![offB + p]!);
          pd += Math.abs(a.pingDistances![offA + p]! - b.pingDistances![offB + p]!);
          pm += Math.abs(a.pingMax![offA + p]! - b.pingMax![offB + p]!);
        }
        ray += 3 * (pos + 0.3 * (ang + pd + pm)) / (255 * m);
      }
      sum += ray; offA += cA; offB += cB;
    }
    const mean = active ? sum / active : 0;
    meanSum += mean; if (mean > maxAngle) maxAngle = mean;
  }
  return 0.5 * (meanSum / numAngles) + 0.5 * maxAngle;
}
import { systemFontPaths } from "../src/glyph-box.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FONTS = ["Roboto", "Arial", "Helvetica", "Helvetica Neue", "Times New Roman", "Georgia", "Verdana", "Tahoma",
  "Trebuchet MS", "Courier New", "Menlo", "Monaco", "Avenir", "Avenir Next", "Futura", "Gill Sans", "Optima",
  "Baskerville", "Palatino", "Charter", "Iowan Old Style", "American Typewriter", "Cochin", "Didot", "Rockwell",
  "Hoefler Text"];

const ascii = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz|"];
const latin = [..."abcdefghijklmnopqrstuvwxyz"];
const other = [0x3b1, 0x3ca, 0x430, 0x460, 0x500, 0x530].reduce<string[]>((acc, v, i, arr) =>
  i % 2 ? acc : acc.concat(Array.from({ length: arr[i + 1]! - v }, (_, k) => String.fromCodePoint(v + k))), []);

function skeletonMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of fs.readFileSync(path.join(ROOT, "data/input/confusables.txt"), "utf8").split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const [s, t] = line.split(";").map((x) => x.trim());
    if (s!.includes(" ")) continue;
    m.set(String.fromCodePoint(parseInt(s!, 16)), t!.split(" ").map((h) => String.fromCodePoint(parseInt(h, 16))).join(""));
  }
  return m;
}

async function main() {
  const pool = new SignaturePool();
  const paths = systemFontPaths();
  const chars = [...new Set([...ascii, ...latin, ...other])];
  const sigs = new Map<string, Map<string, CompactBankTarget>>(); // char -> font -> baseline-anchored signature
  const boxSigs = new Map<string, Map<string, CompactBankTarget>>(); // char -> font -> signature on the glyph's own box
  const jobs: Promise<void>[] = [];
  for (const family of FONTS) {
    const file = paths.get(family);
    const font = file ? loadFont(file) : null;
    if (!font) { console.error(`no font ${family}`); continue; }
    for (const ch of chars) {
      const g = extractGlyphPath(font, ch.codePointAt(0)!);
      if (!g) continue;
      const segs = normalizeToEmFrame(g, font.unitsPerEm, 128);
      const put = (store: Map<string, Map<string, CompactBankTarget>>) => (s: any) => {
        let m = store.get(ch);
        if (!m) store.set(ch, (m = new Map()));
        m.set(family, { advanceWidth: g.advanceWidth, counts: Uint8Array.from(s.counts), positions: Uint8Array.from(s.positions),
          angles: Uint8Array.from(s.angles), pingDistances: Uint8Array.from(s.pingDistances), pingMax: Uint8Array.from(s.pingMax) });
      };
      jobs.push(pool.compute(segs, emFrame(128)).then(put(sigs)));
      jobs.push(pool.compute(segs).then(put(boxSigs)));
    }
  }
  await Promise.all(jobs);
  await pool.close();
  console.error(`${jobs.length} signatures`);

  const sk = skeletonMap();
  const same = (a: string, b: string) => (sk.get(a) ?? a) === (sk.get(b) ?? b);
  const sets = {
    ASCII: { pairs: ascii.flatMap((a, i) => ascii.slice(i + 1).map((b) => [a, b] as [string, string])), extra: [["0", "o"]] },
    "held-out": { pairs: latin.flatMap((a) => other.map((b) => [a, b] as [string, string])), extra: [] as string[][] },
  };
  const distances = new Map<string, number[]>();
  const shapeDistances = new Map<string, number[]>();
  for (const { pairs } of Object.values(sets)) {
    for (const [a, b] of pairs) {
      const fa = sigs.get(a), fb = sigs.get(b);
      if (!fa || !fb) continue;
      const ds: number[] = [], ss: number[] = [];
      for (const [f, s] of fa) {
        const t = fb.get(f); if (!t) continue;
        ds.push((process.env.ACTIVE ? compareActive : compareGeometric)(s, t, 36, 50));
        ss.push(compareGeometric(boxSigs.get(a)!.get(f)!, boxSigs.get(b)!.get(f)!, 36, 50));
      }
      distances.set(a + b, ds); shapeDistances.set(a + b, ss);
    }
  }
  for (const cut of (process.env.CUTS ?? "0.1,0.15,0.2,0.25,0.35,0.5").split(",").map(Number)) {
    console.log(`distance below ${cut}:`);
    for (const [name, { pairs, extra }] of Object.entries(sets)) {
      const isPos = (a: string, b: string) => same(a, b) || extra.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
      const passes = (a: string, b: string) => {
        const ds = distances.get(a + b) ?? [], ss = shapeDistances.get(a + b) ?? [];
        const alike = ds.filter((d, i) => d < cut && (!process.env.COMBINED || ss[i]! < 0.5)).length;
        return ds.length > 0 && alike >= Math.min(3, ds.length) && alike / ds.length >= 0.05;
      };
      const pos = pairs.filter(([a, b]) => isPos(a, b));
      const kept = pos.filter(([a, b]) => passes(a, b)).map(([a, b]) => a + b);
      const missed = pos.filter(([a, b]) => !passes(a, b)).map(([a, b]) => a + b);
      const flagged = pairs.filter(([a, b]) => !isPos(a, b) && passes(a, b)).map(([a, b]) => a + b);
      console.log(`  ${name}: kept ${kept.length}/${pos.length} missed [${missed.join(" ")}]; false ${flagged.length} [${flagged.slice(0, 14).join(" ")}]`);
    }
  }
}

main();
