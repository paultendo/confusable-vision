/**
 * calibrate-rs.ts
 *
 * calibrate-em.ts's check, on the signatures the release pipeline actually uses (native/cv-pairs: box on the glyph's own
 * box after normalizeToGrid, baseline-anchored on the em frame centred on the advance and on the ink), in the faces the
 * font catalogue loads, for either measurement: the union of the contours (default) or every contour edge
 * (CV_LEGACY=1, the TypeScript's). calibrate-em.ts computed its box signatures from the em-normalised outline instead,
 * whose ping distances scale differently.
 *
 * Pairs whose answer is known, in the same 26 common text fonts:
 *   - ASCII letters and digits (development set): distinct except TR39's own ASCII mappings and 0/o;
 *   - held out: Latin lowercase against Cyrillic and Greek lowercase, where TR39's mappings are the lookalikes.
 * For each cut, how many lookalikes are kept and how many distinct pairs are flagged, under the release rule (alike in
 * at least 3 fonts, or all that render both if fewer, and at least 5% of them), with "alike" either the em distance
 * (lower of the two centrings) under the cut, or that and the box distance under 0.5 (the rule score-all.ts applies).
 *
 * Usage: npx tsx scripts/calibrate-rs.ts [--legacy] [--cuts 0.15,0.2,0.25]
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadFace } from "../src/font-catalogue.js";
import { extractGlyphPath, getFontMetrics, normalizeToGrid, normalizeToEmFrame, emFrame } from "../src/glyph-path.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const NATIVE = process.env.CV_PAIRS ?? path.join(ROOT, "native/cv-pairs/target/release/cv-pairs");
const TMP = path.join(ROOT, "data/output/sig-tmp");
const legacy = process.argv.includes("--legacy");
const cuts = (process.argv.includes("--cuts") ? process.argv[process.argv.indexOf("--cuts") + 1]! : "0.15,0.2,0.25").split(",").map(Number);
const FONTS = ["Roboto", "Arial", "Helvetica", "Helvetica Neue", "Times New Roman", "Georgia", "Verdana", "Tahoma",
  "Trebuchet MS", "Courier New", "Menlo", "Monaco", "Avenir", "Avenir Next", "Futura", "Gill Sans", "Optima",
  "Baskerville", "Palatino", "Charter", "Iowan Old Style", "American Typewriter", "Cochin", "Didot", "Rockwell",
  "Hoefler Text"];
const ascii = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz|"];
const latin = [..."abcdefghijklmnopqrstuvwxyz"];
const other = [0x3b1, 0x3ca, 0x430, 0x460, 0x500, 0x530].reduce<string[]>((acc, v, i, arr) =>
  i % 2 ? acc : acc.concat(Array.from({ length: arr[i + 1]! - v }, (_, k) => String.fromCodePoint(v + k))), []);
const chars = [...new Set([...ascii, ...latin, ...other])];

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

function encodeOutline(segs: any[], fr?: { minX: number; minY: number; maxX: number; maxY: number }): Buffer {
  const n = segs.reduce((k, sg) => k + 1 + 8 * (sg.type === "line" ? 4 : sg.type === "quadratic" ? 6 : 8), 0);
  const b = Buffer.alloc(1 + (fr ? 32 : 0) + 4 + n);
  let o = 0;
  b[o++] = fr ? 1 : 0;
  if (fr) for (const v of [fr.minX, fr.minY, fr.maxX, fr.maxY]) { b.writeDoubleLE(v, o); o += 8; }
  b.writeUInt32LE(segs.length, o); o += 4;
  for (const sg of segs) {
    b[o++] = sg.type === "line" ? 0 : sg.type === "quadratic" ? 1 : 2;
    for (const p of (sg.type === "line" ? [sg.p0, sg.p1] : sg.type === "quadratic" ? [sg.p0, sg.p1, sg.p2] : [sg.p0, sg.p1, sg.p2, sg.p3])) { b.writeDoubleLE(p.x, o); b.writeDoubleLE(p.y, o + 8); o += 16; }
  }
  return b;
}

// Per font: every pair's box distance and em distance (lower of the two centrings)
const dist = new Map<string, [number, number][]>(); // "a|b" (chars) -> per font [box, em]
fs.mkdirSync(TMP, { recursive: true });
for (const family of FONTS) {
  const font: any = loadFace(family);
  if (!font) { console.error(`no font ${family}`); continue; }
  const m = getFontMetrics(font);
  const head = Buffer.alloc(8 + 16 + 36 * 16);
  head.write("CVG1", 0, "latin1"); head.writeUInt32LE(36, 8); head.writeUInt32LE(50, 12); head.writeDoubleLE(128, 16);
  for (let i = 0; i < 36; i++) { const a = (i * Math.PI) / 36; head.writeDoubleLE(Math.cos(a), 24 + i * 16); head.writeDoubleLE(Math.sin(a), 32 + i * 16); }
  const parts: Buffer[] = [head];
  let n = 0;
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    if (!font.glyphForCodePoint(cp).id) continue;
    const g = extractGlyphPath(font, cp);
    if (!g) continue;
    const c = Buffer.alloc(4); c.writeUInt32LE(cp, 0);
    parts.push(c, encodeOutline(normalizeToGrid(g, m, 128)), encodeOutline(normalizeToEmFrame(g, font.unitsPerEm, 128), emFrame(128)),
      encodeOutline(normalizeToEmFrame(g, font.unitsPerEm, 128, "ink"), emFrame(128)));
    n++;
  }
  head.writeUInt32LE(n, 4);
  const file = path.join(TMP, "calibrate.bin");
  fs.writeFileSync(file, Buffer.concat(parts));
  const r = spawnSync(NATIVE, [file, "--all-distances"], { env: { ...process.env, ...(legacy ? { CV_LEGACY: "1" } : {}) }, maxBuffer: 1 << 30 });
  for (const line of r.stdout.toString().trim().split("\n")) {
    const [a, b, box, adv, ink] = line.split(" ");
    const [ca, cb] = [String.fromCodePoint(parseInt(a!, 16)), String.fromCodePoint(parseInt(b!, 16))];
    const d: [number, number] = [Number(box), Math.min(Number(adv), Number(ink))];
    for (const k of [ca + cb, cb + ca]) (dist.get(k) ?? dist.set(k, []).get(k)!).push(d);
  }
  fs.rmSync(file);
}

const sk = skeletonMap();
const same = (a: string, b: string) => (sk.get(a) ?? a) === (sk.get(b) ?? b);
const sets = {
  ASCII: { pairs: ascii.flatMap((a, i) => ascii.slice(i + 1).map((b) => [a, b] as [string, string])), extra: [["0", "o"]] },
  "held-out": { pairs: latin.flatMap((a) => other.map((b) => [a, b] as [string, string])), extra: [] as string[][] },
};
console.log(`measurement: ${legacy ? "every contour edge (legacy)" : "union of the contours"}`);
for (const rule of ["em", "em + box < 0.5"]) for (const cut of cuts) {
  const out: string[] = [];
  for (const [name, { pairs, extra }] of Object.entries(sets)) {
    const isPos = (a: string, b: string) => same(a, b) || extra.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    const passes = (a: string, b: string) => {
      const ds = dist.get(a + b) ?? [];
      const alike = ds.filter(([box, em]) => em < cut && (rule === "em" || box < 0.5)).length;
      return ds.length > 0 && alike >= Math.min(3, ds.length) && alike / ds.length >= 0.05;
    };
    const pos = pairs.filter(([a, b]) => isPos(a, b));
    const missed = pos.filter(([a, b]) => !passes(a, b)).map(([a, b]) => a + b);
    const flagged = pairs.filter(([a, b]) => !isPos(a, b) && passes(a, b)).map(([a, b]) => a + b);
    out.push(`${name} kept ${pos.length - missed.length}/${pos.length} missed [${missed.join(" ")}] false ${flagged.length} [${flagged.slice(0, 12).join(" ")}]`);
  }
  console.log(`  ${rule}, cut ${cut}: ${out.join(" | ")}`);
}
