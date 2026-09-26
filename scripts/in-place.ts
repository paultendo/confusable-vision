/**
 * in-place.ts
 *
 * The judgement stage: does a candidate lookalike pass for the letter (or two-letter sequence) where people read it?
 * Each candidate from a score-all run (alike in at least one font or font combination) is set in short snippets in
 * real contexts (the system font at address-bar size, common web and mail fonts at body size) through Core Text, which
 * picks the fallback face as the platform does, and the lookalike is compared with the genuine letter four ways:
 *
 *   1. topology: the same pieces and holes, once gaps narrower than the display resolves are closed (open against
 *      closed strokes; rn/m-style merging by size, kerning or tracking). Rasterised at four times the display's own
 *      resolution; a gap closes when it is under one device pixel.
 *   2. counter shape: no hole square (area over bounding box at least 0.95) where the letter's is round, or the
 *      reverse (𐊧 against B); finer differences vary too much between designs of one letter to count.
 *   3. glyph distance at actual size and baseline (em frame, each on its ink centre) no greater than that of the
 *      accepted confusables in the same context (0/O, 1/l, I/l, which confusables.txt maps together; an anchor counts
 *      only where the context draws both at the same height and position): the median for the strict tier, the
 *      least alike for the broad tier. The anchors move with the context.
 *   6. weight: mean stroke thickness within WEIGHT_RATIO of the letter's (bold stands out).
 *   7. edges and corners, read by side as a reader reads left to right: how much the left and right edges wander over
 *      the middle rows (mirrored letters, straight stems against curves), and, for the strict tier, how closely the ink
 *      reaches each corner of its box (O against D, ⊔ against u, 𐊧 against B).
 *   5. order: a right-to-left lookalike must not rearrange its neighbours.
 *   4. spacing and extent: the gaps to the neighbouring letters within FIT_SPACE em a side of the genuine letter's,
 *      and the ink's top and bottom within INK_TOLERANCE em, its width within WIDTH_TOLERANCE.
 *
 * Tuned 26 Sep 2026 on the examples judged by eye (Paul's eight and the rendered samples): every pair Paul called
 * alike (𐤠 𐋎 A, 𖭯 L, ᨡ a, ᱠ b, ᥒ n) kept, 𐊧 B rejected, 26 of 27 judged unlike rejected.
 *
 * The verdict for each pair is measured, and anyone rerunning this gets the same answers. The four tests and their
 * tolerances were chosen by judgement, against the examples above; the anchors make the cut-off relative to pairs
 * everyone accepts.
 *
 * Usage: npx tsx scripts/in-place.ts [--run all-pairs-v8] [--limit N] [--only "x t"]
 * Output: data/output/<run>.in-place.jsonl, per candidate and context the four measurements and whether each passes.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commandsToSegments } from "../src/glyph-path.js";
import { parseCommands } from "../src/coretext.js";
import { fontCatalogue } from "../src/font-catalogue.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const RUN = arg("--run") ?? "all-pairs-v8";
const LIMIT = arg("--limit") ? Number(arg("--limit")) : Infinity;
const PAIRS_BIN = process.env.CV_PAIRS ?? path.join(ROOT, "native/cv-pairs/target/release/cv-pairs");
const TMP = path.join(ROOT, "data/output/sig-tmp");
/** Where a lookalike is read: the system font at address-bar size; common web and mail fonts at body size. */
export const CONTEXTS: { family: string; size: number }[] = [
  { family: "System Font", size: 13 }, { family: "Helvetica", size: 16 }, { family: "Arial", size: 16 },
  { family: "Times New Roman", size: 16 }, { family: "Georgia", size: 16 }];
const DPRS = [1, 2];
const FIT_SPACE = 0.12;
const SQUARENESS_SLACK = 0.03;
/** Ink extent (top, bottom, width) within this many em of the genuine letter's. */
const INK_TOLERANCE = 0.12;
/** Ink width within this many em: wider, since accepted confusables differ in width by design (0 is narrower than O). */
const WIDTH_TOLERANCE = 0.2;
/** Mean stroke thickness within this ratio of the letter's either way (bold stands out). */
const COUNTER_TOLERANCE = Number(process.env.COUNTER_TOLERANCE ?? 0.25);
const WEIGHT_RATIO = Number(process.env.WEIGHT_RATIO ?? 1.25);
/** Corner reach: each corner of the ink's box reached as closely as the letter's, within this many em (O against D
 * about 0.11; the taper at the foot of Arabic alef against l about 0.035). Strict: every corner; broad: all but one. */
const CORNER_TOLERANCE = 0.06;
/** Edge curvature, per side (both tiers): how much the left and right edges wander over the middle rows, within this of
 * the letter's (mirrored letters: 0.22 to 0.29; lookalikes judged alike: at most 0.12 in some context). */
const EDGE_TOLERANCE = 0.12;
/** Slant (strict tier): the ink's sideways drift per unit height within this of the letter's (italic is about 0.2). */
const SHEAR_TOLERANCE = 0.08;
/** (Stems, both tiers: a vertical ink run at least half the box's height, by third of the box; the lookalike's must be
 * where the letter's are: Y's stem against V's point.) */
const curvature = (p: number[]) => { const a = p.slice(2, 14); const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
/** A counter at or above this squareness reads as square; square against round is a difference (𐊧 against B). */
const SQUARE = 0.95;
const ANCHORS: [string, string][] = [["0", "O"], ["1", "l"], ["I", "l"]];
const REF_FONTS = ["Roboto", "Arial", "Helvetica", "Helvetica Neue", "Times New Roman", "Georgia", "Verdana", "Tahoma", "Trebuchet MS",
  "Avenir", "Avenir Next", "Futura", "Gill Sans", "Optima", "Baskerville", "Palatino", "Charter", "Iowan Old Style", "System Font",
  "Noto Sans", "Noto Serif", "DejaVu Sans", "DejaVu Serif"];
const GRID = 128, ABOVE = 1.1, BELOW = 0.3, SCALE = GRID / (ABOVE + BELOW);

// ---------- Core Text layout (scripts/ct-layout.swift --paths) ----------

function swiftTool(name: string): string {
  const src = path.join(ROOT, `scripts/${name}.swift`), bin = path.join(ROOT, `data/output/bin/${name}`);
  if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "inherit" });
  }
  return bin;
}
type Glyph = { x: number; adv: number; face: string; segs: any[]; minX: number; maxX: number };
type Line = { glyphs: Glyph[]; faces: string };
function layout(family: string, size: number, strings: string[]): Line[] {
  const e: any = fontCatalogue().get(family);
  const who = family === "System Font" ? ["System Font"] : e?.file && !/^\/(System|Library)\//.test(e.file) ? [e.postscriptName, e.file] : [e.postscriptName];
  const out = execFileSync(process.env.CT_LAYOUT ?? swiftTool("ct-layout"), [...who, "--paths", "--size", String(size)], { input: strings.join("\n") + "\n", maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "ignore"] })
    .toString().trimEnd().split("\n");
  return out.map((line) => {
    const [, , faces = "", field = ""] = line.split("\t");
    const glyphs = field ? field.split(" | ").map((part) => {
      const colon = part.indexOf(":");
      const [x, adv, face] = part.slice(0, colon).trim().split(",");
      const segs = commandsToSegments(parseCommands(part.slice(colon + 1).trim()));
      const xs = segs.flatMap((sg: any) => Object.entries(sg).filter(([k]) => k !== "type").map(([, v]: any) => v.x));
      return { x: Number(x), adv: Number(adv), face: face!, segs, minX: xs.length ? Math.min(...xs) : NaN, maxX: xs.length ? Math.max(...xs) : NaN };
    }).sort((a, b) => a.x - b.x) : [];
    return { glyphs, faces };
  });
}

/** The snippet a candidate is read in: neighbours of the target's kind either side. */
const neighbours = (t: string): [string, string] => /^[0-9]+$/.test(t) ? ["2", "5"] : t === t.toUpperCase() && t !== t.toLowerCase() ? ["A", "N"] : ["a", "n"];

// ---------- Topology and counter shape (raster at four times the display resolution) ----------

function flatten(segs: any[]): [number, number, number, number][] {
  const edges: [number, number, number, number][] = [];
  const at = (sg: any, t: number) => {
    const m = 1 - t;
    if (sg.type === "line") return [sg.p0.x * m + sg.p1.x * t, sg.p0.y * m + sg.p1.y * t];
    if (sg.type === "quadratic") return [m * m * sg.p0.x + 2 * m * t * sg.p1.x + t * t * sg.p2.x, m * m * sg.p0.y + 2 * m * t * sg.p1.y + t * t * sg.p2.y];
    return [m ** 3 * sg.p0.x + 3 * m * m * t * sg.p1.x + 3 * m * t * t * sg.p2.x + t ** 3 * sg.p3.x, m ** 3 * sg.p0.y + 3 * m * m * t * sg.p1.y + 3 * m * t * t * sg.p2.y + t ** 3 * sg.p3.y];
  };
  for (const sg of segs) {
    const n = sg.type === "line" ? 1 : 8;
    let prev = at(sg, 0);
    for (let k = 1; k <= n; k++) { const p = at(sg, k / n); edges.push([prev[0]!, prev[1]!, p[0]!, p[1]!]); prev = p; }
  }
  return edges;
}

/** The outline cut to lo <= x < hi (em), as line segments: each contour clipped against the two sides in turn
 * (Sutherland-Hodgman), so a stroke crossing the cut ends in a straight edge along it, as the cut shape's side. */
function clipSegs(segs: any[], lo: number, hi: number): any[] {
  const contours: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (const [ax, ay, bx, by] of flatten(segs)) {
    const last = cur.at(-1);
    if (!last || Math.abs(last[0] - ax) > 1e-9 || Math.abs(last[1] - ay) > 1e-9) { if (cur.length > 2) contours.push(cur); cur = [[ax, ay]]; }
    cur.push([bx, by]);
  }
  if (cur.length > 2) contours.push(cur);
  const side = (poly: [number, number][], inside: (x: number) => boolean, at: number) => {
    const out: [number, number][] = [];
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k]!, q = poly[(k + 1) % poly.length]!;
      const pin = inside(p[0]), qin = inside(q[0]);
      if (pin) out.push(p);
      if (pin !== qin) { const t = (at - p[0]) / (q[0] - p[0]); out.push([at, p[1] + t * (q[1] - p[1])]); }
    }
    return out;
  };
  const out: any[] = [];
  for (const c of contours) {
    let poly = c;
    if (isFinite(lo)) poly = side(poly, (x) => x >= lo, lo);
    if (isFinite(hi) && poly.length) poly = side(poly, (x) => x < hi, hi);
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k]!, q = poly[(k + 1) % poly.length]!;
      if (p[0] !== q[0] || p[1] !== q[1]) out.push({ type: "line", p0: { x: p[0], y: p[1] }, p1: { x: q[0], y: q[1] } });
    }
  }
  return out;
}

export type Topology = { pieces: number; holes: number; squareness: number[]; counters: { x: number; y: number; w: number; h: number }[]; stroke: number; radial: number[]; polar: number[]; sides: Record<string, number[]>; corners: Record<string, number>; shear: number; ink: { minX: number; maxX: number; minY: number; maxY: number }; strokes: { vertical: number; verticalAt: number; horizontal: number; horizontalAt: number; stems: string; stemAt: number[]; crossbars: number } };
const SIDE_BINS = 16;
const RADIAL_DIRECTIONS = 72;
/** Pieces and holes of the ink (nonzero fill), rasterised at pxPerEm, after closing gaps narrower than one device pixel. */
/** clip: only the ink between these x (em), for one letter of a two-letter sequence. */
export function topology(segs: any[], pxPerEm: number, devicePx: number, clip?: [number, number]): Topology {
  const edges = flatten(segs);
  const empty = { pieces: 0, holes: 0, squareness: [], counters: [], stroke: 0, radial: [], polar: [], sides: {}, corners: {}, shear: 0, ink: { minX: NaN, maxX: NaN, minY: NaN, maxY: NaN }, strokes: { vertical: 0, verticalAt: 0.5, horizontal: 0, horizontalAt: 0.5, stems: "none", stemAt: [], crossbars: 0 } };
  if (!edges.length) return empty;
  const R = Math.max(0, Math.round(devicePx / 2));
  const pad = (R + 3) / pxPerEm;
  const xs = edges.flatMap((e) => [e[0], e[2]]), ys = edges.flatMap((e) => [e[1], e[3]]);
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  const W = Math.ceil((Math.max(...xs) + pad - x0) * pxPerEm), H = Math.ceil((Math.max(...ys) + pad - y0) * pxPerEm);
  let img = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    const y = y0 + (j + 0.5) / pxPerEm;
    const cross: [number, number][] = [];
    for (const [ax, ay, bx, by] of edges) if ((ay <= y) !== (by <= y)) cross.push([ax + ((y - ay) / (by - ay)) * (bx - ax), by > ay ? 1 : -1]);
    cross.sort((a, b) => a[0] - b[0]);
    let w = 0, k = 0;
    for (let i = 0; i < W; i++) {
      const x = x0 + (i + 0.5) / pxPerEm;
      while (k < cross.length && cross[k]![0] < x) { w += cross[k]![1]; k++; }
      if (w !== 0) img[j * W + i] = 1;
    }
  }
  if (clip) for (let i = 0; i < W; i++) {
    const x = x0 + (i + 0.5) / pxPerEm;
    if (x < clip[0] || x >= clip[1]) for (let j = 0; j < H; j++) img[j * W + i] = 0;
  }
  if (!img.some((v) => v)) return empty;
  let area = 0, boundary = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!img[j * W + i]) continue;
    area++;
    if (i === 0 || j === 0 || i === W - 1 || j === H - 1 || !img[j * W + i - 1] || !img[j * W + i + 1] || !img[(j - 1) * W + i] || !img[(j + 1) * W + i]) boundary++;
  }
  const stroke = boundary ? (2 * area) / boundary / pxPerEm : 0;
  // Radial profile: from the middle of the ink's bounding box, the farthest ink in each direction, over the mean. A
  // circle is flat; a flat side is a dip between two peaks (its corners); slant rotates the peaks.
  let bi0 = W, bi1 = 0, bj0 = H, bj1 = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (img[j * W + i]) { if (i < bi0) bi0 = i; if (i > bi1) bi1 = i; if (j < bj0) bj0 = j; if (j > bj1) bj1 = j; }
  const cx = (bi0 + bi1) / 2, cy = (bj0 + bj1) / 2;
  const far = new Array(RADIAL_DIRECTIONS).fill(0);
  for (let j = bj0; j <= bj1; j++) for (let i = bi0; i <= bi1; i++) {
    if (!img[j * W + i]) continue;
    const dx = i - cx, dy = j - cy, r = Math.hypot(dx, dy);
    const k = Math.round(((Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * RADIAL_DIRECTIONS) % RADIAL_DIRECTIONS;
    if (r > far[k]) far[k] = r;
  }
  // Directions no ink pixel falls in exactly (thin strokes) take their neighbours' mean
  for (let k = 0; k < RADIAL_DIRECTIONS; k++) if (!far[k]) far[k] = (far[(k + RADIAL_DIRECTIONS - 1) % RADIAL_DIRECTIONS] + far[(k + 1) % RADIAL_DIRECTIONS]) / 2;
  const meanFar = far.reduce((a, b) => a + b, 0) / RADIAL_DIRECTIONS || 1;
  const radial = far.map((r) => Math.round((r / meanFar) * 1000) / 1000);
  // The same profile over the ink box's half-height (not the mean radius), for comparing left and right halves
  const halfH = (bj1 - bj0 + 1) / 2 || 1;
  const polar = far.map((r) => Math.round((r / halfH) * 1000) / 1000);
  // Side profiles (as in character recognition): looking in from each side of the ink's box, how deep the white goes
  // before the ink starts, row by row (left, right) and column by column (top, bottom), over the box's width or
  // height, in SIDE_BINS steps. Straight sides are flat, openings are deep, and mirroring swaps left and right.
  const bw = bi1 - bi0 + 1, bh = bj1 - bj0 + 1;
  const side = (n: number, depth: (u: number) => number, span: number) => Array.from({ length: SIDE_BINS }, (_, b) => {
    const u0 = Math.floor((b * n) / SIDE_BINS), u1 = Math.max(u0 + 1, Math.floor(((b + 1) * n) / SIDE_BINS));
    let sum = 0; for (let u = u0; u < u1; u++) sum += depth(u);
    return Math.round((sum / (u1 - u0) / span) * 1000) / 1000;
  });
  const fromLeft = (j: number) => { for (let i = bi0; i <= bi1; i++) if (img[(bj0 + j) * W + i]) return i - bi0; return bw; };
  const fromRight = (j: number) => { for (let i = bi1; i >= bi0; i--) if (img[(bj0 + j) * W + i]) return bi1 - i; return bw; };
  const fromTop = (i: number) => { for (let j = bj0; j <= bj1; j++) if (img[j * W + bi0 + i]) return j - bj0; return bh; };
  const fromBottom = (i: number) => { for (let j = bj1; j >= bj0; j--) if (img[j * W + bi0 + i]) return bj1 - j; return bh; };
  const sides = { left: side(bh, fromLeft, bw), right: side(bh, fromRight, bw), top: side(bw, fromTop, bh), bottom: side(bw, fromBottom, bh) };
  // Corner reach: from each corner of the ink's box, the distance to the nearest ink, in em at actual size (a square
  // corner is 0, a round one is not): the polar profile read along the diagonals. In em, not over the box's size: a
  // thin stroke's box is so narrow that a taper too small to see would count as a round corner.
  const cornerReach = ([ci, cj]: [number, number]) => {
    let m = Infinity;
    for (let j = bj0; j <= bj1; j++) for (let i = bi0; i <= bi1; i++) if (img[j * W + i]) { const d = Math.hypot(i - ci, j - cj); if (d < m) m = d; }
    return Math.round((m / pxPerEm) * 1000) / 1000;
  };
  // Raster rows run up from the bottom (font y up): bj1 is the top
  const corners = { topLeft: cornerReach([bi0, bj1]), topRight: cornerReach([bi1, bj1]), bottomLeft: cornerReach([bi0, bj0]), bottomRight: cornerReach([bi1, bj0]) };
  // Shear: how far the ink's centre drifts sideways per unit of height (least squares over the rows); italic about 0.2
  let sy = 0, sx = 0, syy = 0, sxy = 0, rowsWithInk = 0;
  for (let j = bj0; j <= bj1; j++) {
    let n = 0, sum = 0;
    for (let i = bi0; i <= bi1; i++) if (img[j * W + i]) { n++; sum += i; }
    if (!n) continue;
    const cxr = sum / n; rowsWithInk++; sy += j; sx += cxr; syy += j * j; sxy += j * cxr;
  }
  const shear = rowsWithInk > 1 ? (rowsWithInk * sxy - sy * sx) / (rowsWithInk * syy - sy * sy) : 0;
  // Straight strokes: the longest vertical run of ink (a stem: Y has one, V does not) and the longest horizontal run (a
  // bar), each over the box's height or width, with where it sits across the box
  let vRun = 0, vPos = 0.5, hRun = 0, hPos = 0.5;
  for (let i = bi0; i <= bi1; i++) {
    let run = 0;
    for (let j = bj0; j <= bj1; j++) { run = img[j * W + i] ? run + 1 : 0; if (run > vRun) { vRun = run; vPos = (i - bi0 + 0.5) / bw; } }
  }
  for (let j = bj0; j <= bj1; j++) {
    let run = 0;
    for (let i = bi0; i <= bi1; i++) { run = img[j * W + i] ? run + 1 : 0; if (run > hRun) { hRun = run; hPos = (j - bj0 + 0.5) / bh; } }
  }
  // Stems: columns with a vertical ink run at least STEM of the box's height, grouped, placed in thirds of the box
  // (left, centre, right); a glyph narrower than a fifth of an em is one stem
  const STEM = 0.5;
  const colRun: number[] = [];
  for (let i = bi0; i <= bi1; i++) {
    let run = 0, best = 0;
    for (let j = bj0; j <= bj1; j++) { run = img[j * W + i] ? run + 1 : 0; if (run > best) best = run; }
    colRun.push(best);
  }
  const stemColumns = colRun.map((r, k) => (r >= STEM * bh ? k : -1)).filter((k) => k >= 0);
  const stems = new Set<string>();
  const stemAt: number[] = [];
  const stemBands: [number, number][] = [];
  if (bw / pxPerEm < 0.2) { if (stemColumns.length) { stems.add("single"); stemAt.push(0.5); stemBands.push([bi0 + stemColumns[0]!, bi0 + stemColumns.at(-1)!]); } }
  else for (let k = 0; k < stemColumns.length;) {
    let e = k; while (e + 1 < stemColumns.length && stemColumns[e + 1] === stemColumns[e]! + 1) e++;
    // A stem is straight on both edges: a band of such columns most of a stroke wide, standing clear of the columns
    // beside it (much shorter runs), so a bowl's nearly straight side or a diagonal crossing does not count
    const lo = stemColumns[k]!, hi = stemColumns[e]!;
    const beside = Math.max(colRun[lo - 2] ?? 0, colRun[hi + 2] ?? 0);
    if (hi - lo + 1 >= 0.7 * stroke * pxPerEm && beside < 0.6 * Math.min(colRun[lo]!, colRun[hi]!)) {
      const at = ((lo + hi) / 2 + 0.5) / bw;
      stemAt.push(at);
      stemBands.push([bi0 + lo, bi0 + hi]);
      stems.add(at < 1 / 3 ? "left" : at > 2 / 3 ? "right" : "centre");
    }
    k = e + 1;
  }
  // Crossbars: a horizontal stroke running through a stem and out on both sides, away from the stem's ends (Ŧ against
  // T, t against l, ł against l); a bar at the top or foot, an arm from one side (k, ƙ's hook) or a bowl joining it
  // does not count
  // Only between the stem's own ends, clear of them by a stroke and a half: where Y's arms fork from its stem, or m's
  // arches meet its middle stem, is a junction, not a bar
  const reach = Math.max(1, Math.round(0.5 * stroke * pxPerEm));
  const margin = Math.max(1, Math.round(1.5 * stroke * pxPerEm));
  let crossbars = 0;
  for (const [lo, hi] of stemBands) {
    const c = Math.round((lo + hi) / 2);
    let r0 = bj0, r1 = bj0 - 1, run0 = bj0;
    for (let j = bj0; j <= bj1 + 1; j++) {
      if (j <= bj1 && img[j * W + c]) continue;
      if (j - 1 - run0 > r1 - r0) { r0 = run0; r1 = j - 1; }
      run0 = j + 1;
    }
    let inBar = false;
    for (let j = Math.max(bj0 + Math.ceil(0.15 * bh), r0 + margin); j <= Math.min(bj1 - Math.ceil(0.15 * bh), r1 - margin); j++) {
      let through = lo - reach >= 0 && hi + reach < W;
      for (let i = lo - reach; through && i <= hi + reach; i++) if (!img[j * W + i]) through = false;
      if (through && !inBar) crossbars++;
      inBar = through;
    }
  }
  const strokes = { vertical: vRun / bh, verticalAt: vPos, horizontal: hRun / bw, horizontalAt: hPos, stems: [...stems].sort().join("+") || "none", stemAt, crossbars };
  if (R > 0) {
    const disk: [number, number][] = [];
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) if (di * di + dj * dj <= R * R) disk.push([di, dj]);
    const morph = (src: Uint8Array, grow: boolean) => {
      const dst = new Uint8Array(W * H);
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        let v = grow ? 0 : 1;
        for (const [di, dj] of disk) {
          const ii = i + di, jj = j + dj;
          const s = ii >= 0 && jj >= 0 && ii < W && jj < H ? src[jj * W + ii]! : 0;
          if (grow ? s : !s) { v = grow ? 1 : 0; break; }
        }
        dst[j * W + i] = v;
      }
      return dst;
    };
    img = morph(morph(img, true), false);
  }
  const seen = new Uint8Array(W * H);
  let pieces = 0; const squareness: { x: number; s: number; at: { x: number; y: number; w: number; h: number } }[] = [];
  for (let s0 = 0; s0 < W * H; s0++) {
    if (seen[s0]) continue;
    const want = img[s0]!;
    let edge = false, n = 0, i0 = W, i1 = 0, j0 = H, j1 = 0;
    const stack = [s0]; seen[s0] = 1;
    while (stack.length) {
      const q = stack.pop()!; const i = q % W, j = (q - i) / W; n++;
      if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
      if (i === 0 || j === 0 || i === W - 1 || j === H - 1) edge = true;
      const nb = want ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [di, dj] of nb) {
        const ii = i + di!, jj = j + dj!;
        if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
        const r = jj * W + ii;
        if (!seen[r] && img[r] === want) { seen[r] = 1; stack.push(r); }
      }
    }
    if (want) pieces++;
    else if (!edge) squareness.push({ x: (i0 + i1) / 2 + ((j0 + j1) / 2) * 1e-3, s: n / ((i1 - i0 + 1) * (j1 - j0 + 1)),
      // Where the counter sits in the ink's box and how much of it it spans (D's counter the full height, R's and P's the
      // top half)
      at: { x: ((i0 + i1) / 2 - bi0) / bw, y: ((j0 + j1) / 2 - bj0) / bh, w: (i1 - i0 + 1) / bw, h: (j1 - j0 + 1) / bh } });
  }
  // Holes in reading order (by height first: top to bottom, then left to right)
  squareness.sort((a, b) => a.x - b.x);
  // The ink's box in em (before closing gaps)
  const ink = { minX: x0 + bi0 / pxPerEm, maxX: x0 + (bi1 + 1) / pxPerEm, minY: y0 + bj0 / pxPerEm, maxY: y0 + (bj1 + 1) / pxPerEm };
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const counters = squareness.map((h) => ({ x: r3(h.at.x), y: r3(h.at.y), w: r3(h.at.w), h: r3(h.at.h) }));
  return { pieces, holes: squareness.length, squareness: squareness.map((h) => Math.round(h.s * 1000) / 1000), counters, stroke, radial, polar, sides, corners, shear, ink, strokes };
}

// ---------- Glyph distance at actual size and baseline (cv-pairs --consecutive) ----------

function encodeOutline(segs: any[], fr: number[]): Buffer {
  const n = segs.reduce((k, sg) => k + 1 + 8 * (sg.type === "line" ? 4 : sg.type === "quadratic" ? 6 : 8), 0);
  const b = Buffer.alloc(1 + 32 + 4 + n);
  let o = 0; b[o++] = 1;
  for (const v of fr) { b.writeDoubleLE(v, o); o += 8; }
  b.writeUInt32LE(segs.length, o); o += 4;
  for (const sg of segs) {
    b[o++] = sg.type === "line" ? 0 : sg.type === "quadratic" ? 1 : 2;
    for (const p of (sg.type === "line" ? [sg.p0, sg.p1] : sg.type === "quadratic" ? [sg.p0, sg.p1, sg.p2] : [sg.p0, sg.p1, sg.p2, sg.p3])) { b.writeDoubleLE(p.x, o); b.writeDoubleLE(p.y, o + 8); o += 16; }
  }
  return b;
}
/** The middle part of a snippet (every glyph between the neighbours) as one outline, on its ink centre in the em frame. */
function middle(line: Line): { segs: any[]; minX: number; maxX: number; minY: number; maxY: number } | null {
  const g = line.glyphs;
  if (g.length < 3) return null;
  const mid = g.slice(1, -1);
  const segs = mid.flatMap((m) => m.segs);
  const ys = segs.flatMap((sg: any) => Object.entries(sg).filter(([k]) => k !== "type").map(([, v]: any) => v.y));
  return { segs, minX: Math.min(...mid.map((m) => m.minX)), maxX: Math.max(...mid.map((m) => m.maxX)), minY: ys.length ? Math.min(...ys) : NaN, maxY: ys.length ? Math.max(...ys) : NaN };
}
function distances(pairs: [any[], any[]][]): number[] {
  if (!pairs.length) return [];
  const head = Buffer.alloc(8 + 16 + 36 * 16);
  head.write("CVG1", 0, "latin1"); head.writeUInt32LE(pairs.length * 2, 4); head.writeUInt32LE(36, 8); head.writeUInt32LE(50, 12); head.writeDoubleLE(GRID, 16);
  for (let i = 0; i < 36; i++) { const a = (i * Math.PI) / 36; head.writeDoubleLE(Math.cos(a), 24 + i * 16); head.writeDoubleLE(Math.sin(a), 32 + i * 16); }
  const parts: Buffer[] = [head];
  let k = 0;
  for (const pair of pairs) for (const segs of pair) {
    const xs = segs.flatMap((sg: any) => Object.entries(sg).filter(([key]) => key !== "type").map(([, v]: any) => v.x));
    const centre = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
    const g = segs.map((sg: any) => Object.fromEntries(Object.entries(sg).map(([key, v]: any) => [key, key === "type" ? v : { x: (v.x - centre) * SCALE + GRID / 2, y: (ABOVE - v.y) * SCALE }])));
    const c = Buffer.alloc(4); c.writeUInt32LE(k++, 0);
    const o = encodeOutline(g, [0, 0, GRID, GRID]);
    parts.push(c, o, o, o);
  }
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `in-place-${process.pid}.bin`);
  fs.writeFileSync(file, Buffer.concat(parts));
  const out = execFileSync(PAIRS_BIN, [file, "--consecutive"], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n");
  fs.rmSync(file);
  return out.map((l) => Number(l.split(" ")[3]));
}

// ---------- The stage ----------

type Candidate = { x: string; t: string; how: string };
function candidates(): Candidate[] {
  const hex = (u: string) => String.fromCodePoint(parseInt(u.replace(/^U\+/, ""), 16));
  const isTarget = (s: string) => /^[A-Za-z0-9]{1,2}$/.test(s);
  const seen = new Map<string, Candidate>();
  const add = (x: string, t: string, how: string) => { if (x === t || /^[A-Za-z0-9]$/.test(x) && t.length === 1) return; const k = `${x}|${t}`; if (!seen.has(k)) seen.set(k, { x, t, how }); };
  const read = (f: string) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const out = (n: string) => path.join(ROOT, `data/output/${RUN}.${n}`);
  for (const r of read(out("cross.jsonl"))) add(hex(r.x), hex(r.t), "across fonts");
  for (const r of read(out("seq-cross.jsonl"))) add(hex(r.x), r.t, "across fonts (sequence)");
  for (const r of read(out("seq.jsonl"))) add(hex(r.a), r.b, "same font (sequence)");
  for (const r of read(out("jsonl"))) {
    const a = hex(r.a), b = hex(r.b);
    if (isTarget(b) && !isTarget(a)) add(a, b, "same font");
    if (isTarget(a) && !isTarget(b)) add(b, a, "same font");
  }
  return [...seen.values()];
}

/** The shape checks between a letter (tg) and a lookalike (tl), both at actual size: topology, counters, corners,
 * edges, slant and centre stem. Line fit (size, position, spacing, weight, order) and distance are the caller's. */
function shapeGates(tg: Topology, tl: Topology) {
  const sameTopology = tg.pieces === tl.pieces && tg.holes === tl.holes;
  // Square against round only: a counter's squareness varies a lot between designs of the same letter
  const counters = tl.squareness.every((s, h) => tg.squareness[h] === undefined || (s >= SQUARE) === (tg.squareness[h]! >= SQUARE) || Math.abs(s - tg.squareness[h]!) < SQUARENESS_SLACK);
  // Each counter where the letter's is, and about as tall and wide, as fractions of the ink's box (R's counter is the
  // top half of the letter, D's all of it)
  // (paired one to one, the pairing that fits best: stacked counters, as in B and 8, sit at nearly the same x, so their
  // order in a sort is chance)
  const cd = (c: Topology["counters"][number], g: Topology["counters"][number]) => Math.max(Math.abs(c.x - g.x), Math.abs(c.y - g.y), Math.abs(c.w - g.w), Math.abs(c.h - g.h));
  const pairings = (n: number): number[][] => n <= 1 ? [[0].slice(0, n)] : pairings(n - 1).flatMap((p) => Array.from({ length: n }, (_, k) => [...p.slice(0, k), n - 1, ...p.slice(k)]));
  const counterDiff = tl.counters.length && tl.counters.length === tg.counters.length && tl.counters.length <= 4
    ? Math.min(...pairings(tl.counters.length).map((p) => Math.max(...tl.counters.map((c, h) => cd(c, tg.counters[p[h]!]!)))))
    : 0;
  const countersPlaced = counterDiff <= COUNTER_TOLERANCE;
  const cornerDiffs = Object.keys(tg.corners).map((c) => Math.abs((tl.corners[c] ?? 0) - tg.corners[c]!));
  const cornerDiff = Math.max(...cornerDiffs);
  const cornersFit = cornerDiff <= CORNER_TOLERANCE;
  // Broad: an angular or rounded version of one corner still reads as the letter (ᱠ for b, ப for u); two corners
  // changed do not (O for D, 𐊧 for B)
  const cornersFitBroad = cornerDiffs.filter((d) => d > CORNER_TOLERANCE).length <= 1;
  // Any stem in the middle of either (0.3 to 0.7 of the width) needs a stem within 0.2 of it in the other (Y's stem
  // against V's point); at the sides, a bowl's nearly straight side reads as a stem on one side or the other by luck
  const matched = (p: number[], q: number[]) => p.filter((x) => x >= 0.3 && x <= 0.7).every((x) => q.some((y) => Math.abs(x - y) <= 0.2));
  const strokesFit = matched(tl.strokes.stemAt, tg.strokes.stemAt) && matched(tg.strokes.stemAt, tl.strokes.stemAt);
  const crossbarsFit = tl.strokes.crossbars === tg.strokes.crossbars;
  const shearDiff = Math.abs(tl.shear - tg.shear);
  const upright = shearDiff <= SHEAR_TOLERANCE;
  const edgeDiff = Math.max(...["left", "right"].map((sd) => Math.abs(curvature(tl.sides[sd] ?? []) - curvature(tg.sides[sd] ?? []))));
  const edgesFit = edgeDiff <= EDGE_TOLERANCE;
  return {
    strict: sameTopology && counters && countersPlaced && edgesFit && cornersFit && upright && strokesFit && crossbarsFit,
    broad: sameTopology && counters && countersPlaced && edgesFit && cornersFitBroad && strokesFit && crossbarsFit,
    failed: [!sameTopology && "topology", !counters && "counter shape", !countersPlaced && "counter placement", !edgesFit && "edges (mirrored or straight against curved)", !cornersFit && "corners", !upright && "slant", !strokesFit && "centre stem", !crossbarsFit && "crossbar"] as (string | false)[],
    record: { topology: `${tl.pieces}/${tl.holes} vs ${tg.pieces}/${tg.holes}`, sameTopology, squareness: tl.squareness, genuineSquareness: tg.squareness, counters, counterDiff: Math.round(counterDiff * 1000) / 1000, countersPlaced,
      cornerDiff: Math.round(cornerDiff * 1000) / 1000, cornersFit, cornersFitBroad, edgeDiff: Math.round(edgeDiff * 1000) / 1000, edgesFit,
      shearDiff: Math.round(shearDiff * 1000) / 1000, upright, stems: `${tl.strokes.stems} vs ${tg.strokes.stems}`, strokesFit, crossbars: `${tl.strokes.crossbars} vs ${tg.strokes.crossbars}`, crossbarsFit },
  };
}
const lineFitsAny = (row: any) => row.fits && row.inkFits && !row.reordered && DPRS.some((d) => row.byDisplay[d].weightFits);
/** A reference font's design of the letter, scaled to the context letter's ink height, on its baseline and centre. */
function fitDesign(des: { segs: any[]; minX: number; maxX: number; minY: number; maxY: number }, g: { minX: number; maxX: number; minY: number; maxY: number }) {
  const k = (g.maxY - g.minY) / ((des.maxY - des.minY) || 1);
  const dcx = (des.minX + des.maxX) / 2, gcx = (g.minX + g.maxX) / 2;
  const t = (p: any) => ({ x: (p.x - dcx) * k + gcx, y: (p.y - des.minY) * k + g.minY });
  return des.segs.map((sg: any) => Object.fromEntries(Object.entries(sg).map(([key, v]: any) => [key, key === "type" ? v : t(v)])));
}
const ALLOGRAPHS = !process.env.NO_ALLOGRAPHS;
let designs = new Map<string, { font: string; segs: any[]; minX: number; maxX: number; minY: number; maxY: number }[]>();
const allographJobs: { row: any; font: string; segs: any[]; l: any[]; size: number }[] = [];

async function main() {
  let cands = candidates();
  if (arg("--only")) { const [x, t] = arg("--only")!.split(" "); cands = [{ x: x!, t: t!, how: "asked" }]; }
  // A list of "x t" pairs, one per line; lines starting with # are comments
  if (arg("--pairs")) cands = fs.readFileSync(arg("--pairs")!, "utf8").trim().split("\n").filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => { const [x, t] = l.trim().split(/\s+/); return { x: x!, t: t!, how: arg("--how") ?? "listed" }; });
  cands = cands.slice(0, LIMIT);
  console.error(`${cands.length} candidates from ${RUN}`);
  // Counter squareness range of each target across the page fonts (per DPR's closing), computed at 16 px
  const targets = [...new Set(cands.map((c) => c.t).concat(ANCHORS.flat()))];
  const squareRange = new Map<string, [number, number][]>(); // target|dpr -> per hole [min, max] (recorded only)
  if (process.env.SQUARE_RANGES) for (const dpr of DPRS) {
    const perTarget = new Map<string, number[][]>();
    for (const family of REF_FONTS) {
      if (!fontCatalogue().get(family) && family !== "System Font") continue;
      const lines = layout(family, 16, targets.map((t) => { const [a, b] = neighbours(t); return a + t + b; }));
      lines.forEach((line, i) => {
        const m = middle(line); if (!m) return;
        const topo = topology(m.segs, 16 * dpr * 4, 4);
        const list = perTarget.get(targets[i]!) ?? perTarget.set(targets[i]!, []).get(targets[i]!)!;
        list.push(topo.squareness);
      });
    }
    for (const [t, lists] of perTarget) {
      const holes = Math.max(0, ...lists.map((l) => l.length));
      const ranges: [number, number][] = [];
      for (let h = 0; h < holes; h++) { const v = lists.map((l) => l[h]).filter((s): s is number => s !== undefined); ranges.push([Math.min(...v), Math.max(...v)]); }
      squareRange.set(`${t}|${dpr}`, ranges);
    }
  }
  const results: any[] = [];
  // The letters' designs across the common reference fonts (what readers know a letter can look like)
  if (ALLOGRAPHS) {
    const letters = [...new Set(cands.map((c) => c.t))];
    for (const font of REF_FONTS) {
      if (!fontCatalogue().get(font) && font !== "System Font") continue;
      const lines = layout(font, 16, letters.map((t) => { const [a, b] = neighbours(t); return a + t + b; }));
      lines.forEach((line, i) => { const m = middle(line); if (m) (designs.get(letters[i]!) ?? designs.set(letters[i]!, []).get(letters[i]!)!).push({ font, ...m }); });
    }
  }
  for (const { family, size } of CONTEXTS) {
    const strings: string[] = [];
    for (const c of cands) { const [a, b] = neighbours(c.t); strings.push(a + c.t + b, a + c.x + b); }
    for (const [x, t] of ANCHORS) { const [a, b] = neighbours(t); strings.push(a + t + b, a + x + b); }
    const lines = layout(family, size, strings);
    const pairsForDistance: [any[], any[]][] = [];
    const index: number[] = [];
    // Two-letter sequences: also each letter's share, cut where the genuine pair's letters meet (row.cut below)
    const cutOf = (k: number) => {
      const gl = lines[2 * k]!;
      return k < cands.length && cands[k]!.t.length === 2 && gl.glyphs.length === 4 ? (gl.glyphs[1]!.maxX + gl.glyphs[2]!.minX) / 2 : NaN;
    };
    const halfIndex = new Map<number, number>(); // distance slot of candidate k's first letter (second: + 1)
    for (let i = 0; i < lines.length; i += 2) {
      const g = middle(lines[i]!), l = middle(lines[i + 1]!);
      if (!g || !l) continue;
      pairsForDistance.push([g.segs, l.segs]); index.push(i / 2);
      const cut = cutOf(i / 2);
      if (!isNaN(cut)) {
        halfIndex.set(i / 2, pairsForDistance.length);
        pairsForDistance.push([clipSegs(g.segs, -Infinity, cut), clipSegs(l.segs, -Infinity, cut)], [clipSegs(g.segs, cut, Infinity), clipSegs(l.segs, cut, Infinity)]);
        index.push(-1, -1);
      }
    }
    const dist = new Map<number, number>();
    const all = distances(pairsForDistance);
    all.forEach((d, k) => { if (index[k]! >= 0) dist.set(index[k]!, d); });
    // An accepted confusable anchors the context only where the context draws it at the same size and position (old-
    // style figures, as in Georgia, set 0 lower and smaller than O, and 1 than l)
    const anchorDist = ANCHORS.map((_, k) => {
      const i = 2 * (cands.length + k), g = middle(lines[i]!), l = middle(lines[i + 1]!);
      if (!g || !l) return NaN;
      const same = Math.abs(l.maxY - g.maxY) <= INK_TOLERANCE && Math.abs(l.minY - g.minY) <= INK_TOLERANCE;
      return same ? dist.get(cands.length + k) ?? NaN : NaN;
    });
    // The median of the accepted confusables: robust to a design that deliberately separates one of them (SF's 1)
    const sortedAnchors = anchorDist.filter((d) => !isNaN(d)).sort((a, b) => a - b);
    // Two tiers: strict, as alike as the median accepted confusable (Unicode submissions, reports); broad, as alike as
    // the least alike one (defence, where a missed lookalike costs more than an extra entry)
    const anchor = sortedAnchors[Math.floor(sortedAnchors.length / 2)]!;
    const anchorBroad = sortedAnchors[sortedAnchors.length - 1]!;
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k]!, gl = lines[2 * k]!, ll = lines[2 * k + 1]!;
      const g = middle(gl), l = middle(ll);
      const row: any = { x: c.x, t: c.t, how: c.how, context: `${family} ${size}`, faces: ll.faces, anchor: Math.round(anchor * 1000) / 1000,
        anchors: Object.fromEntries(ANCHORS.map(([x, t], j) => [`${x}/${t}`, Math.round(anchorDist[j]! * 1000) / 1000])) };
      if (!g || !l) { row.note = "layout"; results.push(row); continue; }
      // Spacing: gaps to the neighbours against the genuine letter's
      const gapL = (l.minX - ll.glyphs[0]!.maxX) - (g.minX - gl.glyphs[0]!.maxX);
      const gapR = (ll.glyphs.at(-1)!.minX - l.maxX) - (gl.glyphs.at(-1)!.minX - g.maxX);
      row.distance = Math.round((dist.get(k) ?? NaN) * 1000) / 1000;
      // Reordering: a right-to-left character pulls neighbouring digits round it ("20ߣ5" shows as "5ߣ20"); the left
      // neighbour must be the same glyph in the same place
      const sig = (gl: Glyph) => `${gl.face}:${gl.segs.length}:${gl.minX.toFixed(3)}:${gl.maxX.toFixed(3)}`;
      row.reordered = sig(ll.glyphs[0]!) !== sig(gl.glyphs[0]!);
      // Ink extent against the genuine letter's, em: top, bottom, width
      const r3 = (v: number) => Math.round(v * 1000) / 1000;
      row.ink = { top: r3(l.maxY - g.maxY), bottom: r3(l.minY - g.minY), width: r3((l.maxX - l.minX) - (g.maxX - g.minX)) };
      row.inkFits = Math.abs(row.ink.top) <= INK_TOLERANCE && Math.abs(row.ink.bottom) <= INK_TOLERANCE && Math.abs(row.ink.width) <= WIDTH_TOLERANCE;
      row.gaps = [Math.round(gapL * 1000) / 1000, Math.round(gapR * 1000) / 1000];
      row.fits = Math.abs(gapL) <= FIT_SPACE && Math.abs(gapR) <= FIT_SPACE;
      row.alike = row.distance <= anchor;
      row.alikeBroad = row.distance <= anchorBroad;
      row.anchorBroad = Math.round(anchorBroad * 1000) / 1000;
      row.byDisplay = {};
      // A two-letter sequence: each letter's share of the lookalike, cut where the genuine pair's letters meet, has to
      // pass for that letter, in its own place (a D for a D and an R for an R inside "Dz" and "Rz", a caron over a z
      // above the x-height); the pair's outline alone hides what differs inside it
      const pair = c.t.length === 2 && gl.glyphs.length === 4 ? gl.glyphs.slice(1, 3) : null;
      const cut = cutOf(k);
      // Each letter as alike as the pair has to be (the pair's own distance is diluted by whatever is the same)
      const letterDist = pair && halfIndex.has(k) ? [all[halfIndex.get(k)!]!, all[halfIndex.get(k)! + 1]!] : null;
      if (pair) { row.cut = r3(cut); row.letterDistances = letterDist?.map(r3); }
      const lettersAlike = !letterDist || letterDist.every((d) => d <= anchor);
      const lettersAlikeBroad = !letterDist || letterDist.every((d) => d <= anchorBroad);
      for (const dpr of DPRS) {
        const px = size * dpr * 4;
        const tg = topology(g.segs, px, 4), tl = topology(l.segs, px, 4);
        const shape = shapeGates(tg, tl);
        if (pair) {
          const halves = ([[-Infinity, cut], [cut, Infinity]] as [number, number][]).map((clip, h) => {
            const hg = topology(g.segs, px, 4, clip), hl = topology(l.segs, px, 4, clip);
            const inkFits = hl.pieces > 0 && Math.abs(hl.ink.maxY - hg.ink.maxY) <= INK_TOLERANCE && Math.abs(hl.ink.minY - hg.ink.minY) <= INK_TOLERANCE
              && Math.abs((hl.ink.maxX - hl.ink.minX) - (hg.ink.maxX - hg.ink.minX)) <= WIDTH_TOLERANCE;
            const hs = shapeGates(hg, hl);
            const name = h ? "second letter" : "first letter";
            return { strict: hs.strict && inkFits, broad: hs.broad && inkFits, failed: [...hs.failed, !inkFits && "size or position"].filter(Boolean).map((f) => `${name}: ${f}`), record: { ...hs.record, inkFits } };
          });
          shape.strict &&= halves.every((hv) => hv.strict) && lettersAlike;
          shape.broad &&= halves.every((hv) => hv.broad) && lettersAlikeBroad;
          if (!lettersAlikeBroad || !lettersAlike) shape.failed.push(`letter shape (${letterDist!.map((d) => d.toFixed(3)).join(", ")})`);
          shape.failed.push(...halves.flatMap((hv) => hv.failed));
          (shape.record as any).letters = halves.map((hv) => hv.record);
        }
        // Stroke weight: mean stroke thickness (ink area over half its boundary) against the letter's (bold stands out)
        const weight = tg.stroke ? tl.stroke / tg.stroke : 1;
        const weightFits = weight >= 1 / WEIGHT_RATIO && weight <= WEIGHT_RATIO;
        const lineFits = row.fits && row.inkFits && !row.reordered && weightFits;
        row.byDisplay[dpr] = { ...shape.record, ...(process.env.KEEP_RADIAL ? { radial: tl.radial, genuineRadial: tg.radial, polar: tl.polar, genuinePolar: tg.polar, sides: tl.sides, genuineSides: tg.sides, corners: tl.corners, genuineCorners: tg.corners } : {}),
          weight: Math.round(weight * 1000) / 1000, weightFits,
          inPlace: shape.strict && row.alike && lineFits,
          inPlaceBroad: shape.broad && row.alikeBroad && lineFits,
          failed: [...shape.failed, !row.alike && "shape", !row.fits && "spacing", !row.inkFits && "size or position", row.reordered && "reordering", !weightFits && "weight"].filter(Boolean) };
      }
      // Alternative designs: fails strict here, so try the letter as drawn in each common reference font, scaled to this
      // letter's height on its baseline (shape from that design; size, position, spacing and weight still from this line)
      // (single letters only: an alternative design is a letter's, and a sequence's halves are judged letter by letter)
      if (ALLOGRAPHS && !pair && c.t.length === 1 && !DPRS.some((d) => row.byDisplay[d].inPlace) && lineFitsAny(row)) {
        for (const des of designs.get(c.t) ?? []) {
          if (des.font === family) continue;
          const scaled = fitDesign(des, g);
          allographJobs.push({ row, font: des.font, segs: scaled, l: l.segs, size });
        }
      }
      results.push(row);
    }
    console.error(`  ${family} ${size}: anchors ${ANCHORS.map(([x, t], k) => `${x}/${t} ${isNaN(anchorDist[k]!) ? "not drawn alike in size" : anchorDist[k]!.toFixed(3)}`).join(", ")}; bar ${anchor.toFixed(3)}`);
  }
  if (allographJobs.length) {
    const d = distances(allographJobs.map((j) => [j.segs, j.l]));
    allographJobs.forEach((job, i) => {
      const row = job.row;
      // Shape: as alike as this context's median accepted confusable, against the design
      if (!(d[i]! <= row.anchor)) return;
      for (const dpr of DPRS) {
        if (!row.byDisplay[dpr].weightFits) continue;
        const px = job.size * dpr * 4;
        const shape = shapeGates(topology(job.segs, px, 4), topology(job.l, px, 4));
        if (shape.strict) ((row.byDisplay[dpr].designs ??= []) as string[]).push(job.font);
      }
    });
    console.error(`alternative designs: ${allographJobs.length} comparisons`);
  }
  const file = arg("--out") ?? path.join(ROOT, `data/output/${RUN}.in-place.jsonl`);
  fs.writeFileSync(file, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const byCand = new Map<string, any[]>();
  for (const r of results) (byCand.get(`${r.x}|${r.t}`) ?? byCand.set(`${r.x}|${r.t}`, []).get(`${r.x}|${r.t}`)!).push(r);
  const passing = [...byCand.values()].filter((rs) => rs.some((r) => r.byDisplay?.[1]?.inPlace || r.byDisplay?.[2]?.inPlace));
  const broad = [...byCand.values()].filter((rs) => rs.some((r) => r.byDisplay?.[1]?.inPlaceBroad || r.byDisplay?.[2]?.inPlaceBroad));
  const design = [...byCand.values()].filter((rs) => !rs.some((r) => r.byDisplay?.[1]?.inPlace || r.byDisplay?.[2]?.inPlace) && rs.some((r) => r.byDisplay?.[1]?.designs?.length || r.byDisplay?.[2]?.designs?.length));
  console.error(`${byCand.size} candidates; alike in place in at least one context: strict ${passing.length}, broad ${broad.length}; reads as another common design of the letter (not strict): ${design.length} -> ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
