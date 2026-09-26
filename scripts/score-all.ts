/**
 * score-all.ts
 *
 * Every pair of letters and digits that a font draws, in every font. score-exhaustive.ts took its characters from the
 * release's list (the characters of earlier lookalikes plus the twelve March script sets), so it could not reach the
 * ~7,900 letters (Yi, Canadian Aboriginal, Ethiopic, the Indic scripts...) that were never in that list. Here the
 * characters come from each font's own character map: every code point with General_Category L or N that the font
 * maps to a glyph. Nothing depends on an earlier list, bank or run.
 *
 * The fonts are src/font-catalogue.ts's: every family on the machine (and in data/fonts/) that draws a letter or digit,
 * each loaded in the face a browser uses for body text; earlier runs used the bank's fonts that draw the letter a, in
 * face 0 of each collection.
 *
 * Measurement is score-exhaustive.ts's: the box signature under ALIKE, the baseline-anchored signature under EM_ALIKE,
 * the latter taken as the lower of the advance-centred and ink-centred distances. Signatures are computed here (the
 * SignaturePool); the all-pairs comparison runs in native/cv-pairs (Rust, every core), which ports compareGeometric
 * exactly and skips pairs a count-only lower bound rules out. --check compares the two implementations.
 *
 * Usage:
 *   npx tsx scripts/score-all.ts [--scope nonhan|all] [--fonts N] [--only "Font Name"]
 *     nonhan (default): Han and the precomposed Hangul syllables left out; all: everything, Han and Hangul included
 *   npx tsx scripts/score-all.ts --check "Font Name"    Rust against TypeScript distances on that font's first pairs
 *   npx tsx scripts/score-all.ts --check-sigs "Font Name"   Rust signatures against TypeScript ones, byte for byte
 *   --js-sigs   compute signatures in TypeScript (the SignaturePool) instead of in Rust from the outlines
 *   --out NAME  output files data/output/NAME.jsonl and NAME.chars.json (default all-pairs-<scope>)
 *   --match RE  only the families whose names match RE
 *   --cross     also the cross-font test (score-cross-font.ts's, in cv-pairs): each text font's characters against the
 *               62 ASCII letters and digits of every page font in CROSS_REFERENCE_FONTS that lacks them; output
 *               NAME.cross.jsonl. --release2-rule: as release 2, only characters no page font draws. --cross-em: also
 *               alike in the em frame, the character in its own font at the size and on the baseline of the page
 *               font's letters, as a browser draws a fallback character
 *   --sequences also every two-character sequence of ASCII letters and digits, set as each font sets it (kerning,
 *               ligatures), against every character in the same font and as cross-font targets held to their letters'
 *               floors; output NAME.seq.jsonl, NAME.seq.chars.json and (with --cross) NAME.seq-cross.jsonl
 *   --no-group  one font at a time, every outline signed (no sharing between faces), to check the grouped runs
 *   --keep      keep each font's cv-pairs input in data/output/sig-tmp (for profiling cv-pairs on its own)
 *
 * Output: data/output/all-pairs-<scope>.jsonl, rows as in exhaustive-pairs.jsonl, plus data/output/all-pairs-<scope>.chars.json
 * (per font, the code points compared) for audits.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { compareGeometric, type CompactBankTarget } from "../src/signature-bank.js";
import { SignaturePool, type Signature } from "../src/signature-pool.js";
import { DISPLAY_FONTS } from "../src/display-fonts.js";
import { loadBankFor } from "../src/bank-load.js";
import { loadFont, extractGlyphPath, extractSequencePath, getFontMetrics, normalizeToGrid, normalizeToEmFrame, emFrame, commandsToSegments, computeBBox } from "../src/glyph-path.js";
import { parseCommands } from "../src/coretext.js";
import { fontCatalogue, loadFace, measuredFamilies } from "../src/font-catalogue.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const NATIVE = process.env.CV_PAIRS ?? path.join(ROOT, "native/cv-pairs/target/release/cv-pairs");
const TMP = path.join(ROOT, "data/output/sig-tmp");
const NUM_ANGLES = 36, RAYS = 50, GRID = 128;
const arg = (name: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const scope = arg("--scope") ?? "nonhan";
const limit = arg("--fonts") ? parseInt(arg("--fonts")!, 10) : Infinity;
const check = arg("--check");
const checkSigs = arg("--check-sigs");
const only = arg("--only") ?? check ?? checkSigs;
const match = arg("--match") ? new RegExp(arg("--match")!) : undefined;
const jsSigs = process.argv.includes("--js-sigs");
const noGroup = process.argv.includes("--no-group");
const crossFont = process.argv.includes("--cross");
const release2Rule = process.argv.includes("--release2-rule");
// --sequences: also every two-character sequence of ASCII letters and digits, as each font sets it, compared with every
// character (same font) and as a cross-font target (Ы for "bl", ѹ for "oy")
const sequences = process.argv.includes("--sequences");
const outName = arg("--out") ?? `all-pairs-${scope}`;

const inScope = (cp: number) => {
  const ch = String.fromCodePoint(cp);
  if (!/[\p{L}\p{N}]/u.test(ch)) return false;
  if (scope === "all") return true;
  return !/\p{Script=Han}/u.test(ch) && !(cp >= 0xac00 && cp <= 0xd7a3);
};

/** One signature as cv-pairs reads it: counts (1,800 bytes), total hits (u32), a flags byte, then the present arrays. */
function encodeSig(s: Signature): Buffer {
  const total = s.positions.length;
  const parts = [Buffer.from(Uint8Array.from(s.counts)), Buffer.alloc(5)];
  parts[1]!.writeUInt32LE(total, 0);
  let flags = 0;
  [s.positions, s.angles, s.pingDistances, s.pingMax].forEach((a, i) => {
    if (a.length) { flags |= 1 << i; parts.push(Buffer.from(Uint8Array.from(a))); }
  });
  parts[1]![4] = flags;
  return Buffer.concat(parts);
}

const compact = (s: Signature): CompactBankTarget => {
  const t: CompactBankTarget = { advanceWidth: 0, counts: Uint8Array.from(s.counts) };
  if (s.positions.length) t.positions = Uint8Array.from(s.positions);
  if (s.angles.length) t.angles = Uint8Array.from(s.angles);
  if (s.pingDistances.length) t.pingDistances = Uint8Array.from(s.pingDistances);
  if (s.pingMax.length) t.pingMax = Uint8Array.from(s.pingMax);
  return t;
};

/** Signatures for every in-scope glyph of one font, written to a file for cv-pairs. Returns the code points written. */
async function writeSignatures(pool: SignaturePool, family: string, file: string, keep?: Map<number, Signature[]>): Promise<number[]> {
  const font: any = loadFace(family);
  if (!font) return [];
  const metrics = getFontMetrics(font);
  const cps = ([...font.characterSet] as number[]).filter(inScope).sort((a, b) => a - b);
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, Buffer.from("CVS1\0\0\0\0", "latin1"));
  const written: number[] = [];
  const BATCH = 1500;
  for (let s = 0; s < cps.length; s += BATCH) {
    await Promise.all(cps.slice(s, s + BATCH).map(async (cp) => {
      let g;
      try { if (font.glyphForCodePoint(cp).id === 0) return; g = extractGlyphPath(font, cp); } catch { return; }
      if (!g) return;
      const sigs = await Promise.all([
        pool.compute(normalizeToGrid(g, metrics, GRID), undefined, NUM_ANGLES, RAYS, GRID),
        pool.compute(normalizeToEmFrame(g, font.unitsPerEm, GRID), emFrame(GRID), NUM_ANGLES, RAYS, GRID),
        pool.compute(normalizeToEmFrame(g, font.unitsPerEm, GRID, "ink"), emFrame(GRID), NUM_ANGLES, RAYS, GRID),
      ]);
      const head = Buffer.alloc(4);
      head.writeUInt32LE(cp, 0);
      fs.writeSync(fd, Buffer.concat([head, ...sigs.map(encodeSig)]));
      written.push(cp);
      keep?.set(cp, sigs);
    }));
  }
  const n = Buffer.alloc(4);
  n.writeUInt32LE(written.length, 0);
  fs.writeSync(fd, n, 0, 4, 4);
  fs.closeSync(fd);
  return written.sort((a, b) => a - b);
}

/** The ray header cv-pairs reads after the counts: angles, rays, grid, and the ray directions as JavaScript computes
 * them (Math.cos and Math.sin of i * PI / NUM_ANGLES). */
function rayHeader(): Buffer {
  const b = Buffer.alloc(4 + 4 + 8 + NUM_ANGLES * 16);
  b.writeUInt32LE(NUM_ANGLES, 0); b.writeUInt32LE(RAYS, 4); b.writeDoubleLE(GRID, 8);
  for (let i = 0; i < NUM_ANGLES; i++) {
    const angle = (i * Math.PI) / NUM_ANGLES;
    b.writeDoubleLE(Math.cos(angle), 16 + i * 16); b.writeDoubleLE(Math.sin(angle), 24 + i * 16);
  }
  return b;
}

/**
 * Page fonts for the cross-font test: release 2's 21 (scripts/score-cross-font.ts REFERENCE_FONTS), now in the faces a
 * browser uses, plus the system UI font (-apple-system / system-ui pages), Noto Sans and Noto Serif (Android, Linux),
 * and DejaVu Sans and Serif (Linux defaults).
 */
export const CROSS_REFERENCE_FONTS = [
  // score-cross-font.ts REFERENCE_FONTS (importing it would run that script)
  "Roboto", "Arial", "Helvetica", "Helvetica Neue", "Times New Roman", "Georgia", "Verdana", "Tahoma", "Trebuchet MS",
  "Courier New", "Menlo", "Monaco", "Avenir", "Avenir Next", "Futura", "Gill Sans", "Optima", "Baskerville",
  "Palatino", "Charter", "Iowan Old Style",
  "System Font", "Noto Sans", "Noto Serif", "DejaVu Sans", "DejaVu Serif"];
const ASCII_TARGETS = [...Array.from({ length: 10 }, (_, i) => 0x30 + i), ...Array.from({ length: 26 }, (_, i) => 0x41 + i),
  ...Array.from({ length: 26 }, (_, i) => 0x61 + i)];

/**
 * Two-character ASCII sequences travel through cv-pairs as glyphs with ids above Unicode (SEQ_BASE + i * 62 + j for
 * ASCII_TARGETS[i] then [j]); cv-pairs never pairs two sequences, and never tests a sequence as a character across fonts.
 */
export const SEQ_BASE = 0x200000;
const SEQUENCES: [number, string][] = ASCII_TARGETS.flatMap((a, i) => ASCII_TARGETS.map((b, j) => [SEQ_BASE + i * 62 + j, String.fromCodePoint(a, b)] as [number, string]));
export const seqText = (id: number) => String.fromCodePoint(ASCII_TARGETS[Math.floor((id - SEQ_BASE) / 62)]!, ASCII_TARGETS[(id - SEQ_BASE) % 62]!);

/** A Swift tool in scripts/, compiled to data/output/bin when missing or older than its source. */
function swiftTool(name: string): string {
  const src = path.join(ROOT, `scripts/${name}.swift`), bin = path.join(ROOT, `data/output/bin/${name}`);
  if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "inherit" });
  }
  return bin;
}

type Placed = { segments: any[]; advanceWidth: number; bbox: { minX: number; minY: number; maxX: number; maxY: number } };
const shiftSegment = (sg: any, dx: number, dy: number) =>
  Object.fromEntries(Object.entries(sg).map(([k, v]) => [k, k === "type" ? v : { x: (v as any).x + dx, y: (v as any).y + dy }]));

/**
 * Every sequence as Core Text sets it in the face: its glyphs (ligatures), their positions (kerning, AAT or OpenType,
 * and the size-specific tracking of the system font), as macOS and Safari draw text. Checked 26 Sep 2026 against
 * fontkit's layout in 26 page fonts: identical glyphs and positions in 20, fontkit forms fi and fl in Menlo and Monaco
 * where Core Text does not, and misses SF's tracking (-0.43 pt at 17 pt) and optical-size kerning. The outlines are
 * fontkit's glyphs placed where Core Text puts them; for faces only Core Text opens, the whole line comes from Core
 * Text. Null when Core Text cannot open the face (hidden faces read from their files): fontkit's layout then.
 */
function sequenceLayouts(family: string, font: any): Map<string, Placed> | null {
  const texts = SEQUENCES.map(([, t]) => t).filter((t) => [...t].every((c) => font.glyphForCodePoint(c.codePointAt(0)!).id));
  const out = new Map<string, Placed>();
  const place = (text: string, segments: any[], width: number) => { if (segments.length) out.set(text, { segments, advanceWidth: width, bbox: computeBBox(segments) }); };
  try {
    if (font.coreText) {
      loadFace(family); // compiles ct-outlines if needed
      const lines = execFileSync(path.join(ROOT, "data/output/bin/ct-outlines"), ["--via", font.coreText.role, font.coreText.sample, "--layout"],
        { input: texts.join("\n") + "\n", maxBuffer: 1 << 30 }).toString().trim().split("\n").slice(1);
      for (const line of lines) {
        const [text, width, cmds] = line.split("\t");
        if (cmds && cmds !== "!") place(text!, commandsToSegments(parseCommands(cmds)), Number(width));
      }
      return out;
    }
    const entry: any = fontCatalogue().get(family);
    const args = family === "System Font" ? ["System Font"]
      : entry?.file && !/^\/(System|Library)\//.test(entry.file) ? [entry.postscriptName, entry.file] : [entry?.postscriptName];
    const lines = execFileSync(swiftTool("ct-layout"), args, { input: texts.join("\n") + "\n", maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "ignore"] })
      .toString().trim().split("\n");
    for (const line of lines) {
      const [text, glyphs, width] = line.split("\t");
      if (!glyphs || glyphs.includes("!")) continue; // Core Text fell back to another face
      const segments: any[] = [];
      for (const g of glyphs.split(" ")) {
        const [id, pos] = g.split("@");
        const [x, y] = pos!.split(",").map(Number);
        const glyph = font.getGlyph(Number(id));
        for (const sg of commandsToSegments(glyph?.path?.commands ?? [])) segments.push(shiftSegment(sg, x!, y!));
      }
      place(text!, segments, Number(width));
    }
    return out;
  } catch {
    return null;
  }
}
let layoutFallbacks: string[] = [];

/** A sequence as the font sets it: Core Text's placement (sequenceLayouts), else fontkit's layout. */
function sequenceGlyph(font: any, text: string, placed: Map<string, Placed> | null) {
  if (placed) return placed.get(text) ?? null;
  return typeof font.layout === "function" ? extractSequencePath(font, text) : null;
}

/** Extra white space a side (em) within which a cross-font lookalike fits the line: 0.12 em, about 2 px at 16 px text,
 * where gaps began to show by eye (26 Sep 2026); recorded per combination, not used to drop pairs. */
const FIT_SPACE = 0.12;

/** The ink box score-cross-font.ts compares (glyph-box.ts glyphBox): control-point box in em. */
const inkBox = (g: { bbox: { minX: number; minY: number; maxX: number; maxY: number } }, upm: number) =>
  [g.bbox.minX / upm, g.bbox.minY / upm, g.bbox.maxX / upm, g.bbox.maxY / upm];

/**
 * CVR3: each page font's name, the letters and digits it draws, a target count, and its targets (the 62 letters and
 * digits, then with --sequences the two-character sequences as it sets them): ink box and three outlines, box frame and
 * em frame on the advance and on the ink, so the cross-font test can compare at the size and baseline text has.
 */
function writeRefs(file: string, fonts: string[]): Map<string, Set<number>> {
  const parts: Buffer[] = [Buffer.from("CVR4", "latin1"), rayHeader()];
  const frame = emFrame(GRID);
  const n = Buffer.alloc(4); n.writeUInt32LE(fonts.length, 0); parts.push(n);
  const chars = new Map<string, Set<number>>();
  for (const family of fonts) {
    const font: any = loadFace(family);
    if (!font) throw new Error(`page font ${family} not in the catalogue`);
    const metrics = getFontMetrics(font);
    const cps = ([...font.characterSet] as number[]).filter((c) => /[\p{L}\p{N}]/u.test(String.fromCodePoint(c)));
    chars.set(family, new Set(cps));
    const name = Buffer.from(family, "utf8");
    const head = Buffer.alloc(4 + name.length + 4 + cps.length * 4);
    let o = head.writeUInt32LE(name.length, 0); o += name.copy(head, o); o = head.writeUInt32LE(cps.length, o);
    for (const c of cps) o = head.writeUInt32LE(c, o);
    parts.push(head);
    const targets: [number, string][] = [...ASCII_TARGETS.map((t) => [t, String.fromCodePoint(t)] as [number, string]), ...(sequences ? SEQUENCES : [])];
    const placed = sequences ? sequenceLayouts(family, font) : null;
    if (sequences && !placed) layoutFallbacks.push(family);
    { const c = Buffer.alloc(4); c.writeUInt32LE(targets.length, 0); parts.push(c); }
    for (const [t, text] of targets) {
      let g = null;
      try { g = t < SEQ_BASE ? (font.glyphForCodePoint(t).id ? extractGlyphPath(font, t) : null) : sequenceGlyph(font, text, placed); } catch { g = null; }
      if (g && t >= SEQ_BASE) chars.get(family)!.add(t);
      const b = Buffer.alloc(5); b.writeUInt32LE(t, 0); b[4] = g ? 1 : 0; parts.push(b);
      if (!g) continue;
      const bx = Buffer.alloc(40); [...inkBox(g, font.unitsPerEm), g.advanceWidth / font.unitsPerEm].forEach((v, i) => bx.writeDoubleLE(v, i * 8)); parts.push(bx);
      parts.push(encodeOutline(normalizeToGrid(g, metrics, GRID)), encodeOutline(normalizeToEmFrame(g, font.unitsPerEm, GRID), frame),
        encodeOutline(normalizeToEmFrame(g, font.unitsPerEm, GRID, "ink"), frame));
    }
  }
  fs.writeFileSync(file, Buffer.concat(parts));
  return chars;
}

/** One normalised outline as cv-pairs reads it (see read_outline in native/cv-pairs). */
function encodeOutline(segs: any[], fr?: { minX: number; minY: number; maxX: number; maxY: number }): Buffer {
  const n = segs.reduce((k, sg) => k + 1 + 8 * (sg.type === "line" ? 4 : sg.type === "quadratic" ? 6 : 8), 0);
  const b = Buffer.alloc(1 + (fr ? 32 : 0) + 4 + n);
  let o = 0;
  b[o++] = fr ? 1 : 0;
  if (fr) { for (const v of [fr.minX, fr.minY, fr.maxX, fr.maxY]) { b.writeDoubleLE(v, o); o += 8; } }
  b.writeUInt32LE(segs.length, o); o += 4;
  for (const sg of segs) {
    b[o++] = sg.type === "line" ? 0 : sg.type === "quadratic" ? 1 : 2;
    const pts = sg.type === "line" ? [sg.p0, sg.p1] : sg.type === "quadratic" ? [sg.p0, sg.p1, sg.p2] : [sg.p0, sg.p1, sg.p2, sg.p3];
    for (const p of pts) { b.writeDoubleLE(p.x, o); b.writeDoubleLE(p.y, o + 8); o += 16; }
  }
  return b;
}

/** Each in-scope glyph of a font with its three normalised outlines (box, em on the advance, em on the ink), encoded. */
function* glyphOutlines(family: string): Generator<[number, Buffer, number[]]> {
  const font: any = loadFace(family);
  if (!font) return;
  const metrics = getFontMetrics(font);
  const frame = emFrame(GRID);
  for (const cp of ([...font.characterSet] as number[]).filter(inScope).sort((a, b) => a - b)) {
    let g;
    try { if (font.glyphForCodePoint(cp).id === 0) continue; g = extractGlyphPath(font, cp); } catch { continue; }
    if (!g) continue;
    yield [cp, Buffer.concat([encodeOutline(normalizeToGrid(g, metrics, GRID)), encodeOutline(normalizeToEmFrame(g, font.unitsPerEm, GRID), frame),
      encodeOutline(normalizeToEmFrame(g, font.unitsPerEm, GRID, "ink"), frame)]), [...inkBox(g, font.unitsPerEm), g.advanceWidth / font.unitsPerEm]];
  }
  const placed = sequences ? sequenceLayouts(family, font) : null;
  if (sequences && !placed) layoutFallbacks.push(family);
  if (sequences) for (const [id, text] of SEQUENCES) {
    let g;
    try { g = sequenceGlyph(font, text, placed); } catch { continue; }
    if (!g) continue;
    yield [id, Buffer.concat([encodeOutline(normalizeToGrid(g, metrics, GRID)), encodeOutline(normalizeToEmFrame(g, font.unitsPerEm, GRID), frame),
      encodeOutline(normalizeToEmFrame(g, font.unitsPerEm, GRID, "ink"), frame)]), [...inkBox(g, font.unitsPerEm), g.advanceWidth / font.unitsPerEm]];
  }
  if (font._glyphs) font._glyphs = []; // fontkit's glyph cache: large for CJK fonts, not needed again
}

/** CVG1 (one font): per glyph its code point and three outlines. For --check-sigs. */
function writeOutlines(family: string, file: string): number[] {
  const count = Buffer.alloc(8);
  count.write("CVG1", 0, "latin1");
  const chunks: Buffer[] = [count, rayHeader()];
  const written: number[] = [];
  for (const [cp, o] of glyphOutlines(family)) {
    const c = Buffer.alloc(4); c.writeUInt32LE(cp, 0);
    chunks.push(c, o);
    written.push(cp);
  }
  count.writeUInt32LE(written.length, 4);
  fs.writeFileSync(file, Buffer.concat(chunks));
  return written;
}

/**
 * CVG3: the faces of one font file together, each distinct normalised outline written once (keyed by the SHA-256 of
 * its bytes, which are exactly what the signature is computed from), then each font's code points with the outline
 * each uses. Region and edition faces share most outlines (Noto Sans CJK KR adds 472 outlines to HK and JP's), and
 * cv-pairs signs each distinct outline once. Returns each font's code points.
 */
/** Per font, per code point: a short key of the glyph's normalised outlines, to count distinct designs (NAME.outlines.json) */
const outlineKeys: Record<string, Record<number, string>> = {};

function writeGroup(families: string[], file: string): Record<string, number[]> {
  const fd = fs.openSync(file, "w");
  const head = Buffer.alloc(12); // "CVG3", fonts, outlines
  head.write("CVG4", 0, "latin1");
  fs.writeSync(fd, head);
  fs.writeSync(fd, rayHeader());
  const index = new Map<string, number>();
  const tables: [string, [number, number, number[]][]][] = [];
  for (const family of families) {
    const table: [number, number, number[]][] = [];
    for (const [cp, o, box] of glyphOutlines(family)) {
      const key = createHash("sha256").update(o).digest("base64");
      if (cp < SEQ_BASE) (outlineKeys[family] ??= {})[cp] = key.slice(0, 12);
      let k = index.get(key);
      if (k === undefined) { k = index.size; index.set(key, k); fs.writeSync(fd, o); }
      table.push([cp, k, box]);
    }
    tables.push([family, table]);
  }
  for (const [family, table] of tables) {
    const name = Buffer.from(family, "utf8");
    const b = Buffer.alloc(4 + name.length + 1 + 4 + table.length * 48);
    let o = b.writeUInt32LE(name.length, 0);
    o += name.copy(b, o);
    b[o++] = DISPLAY_FONTS.has(family) ? 0 : 1; // cross-font test for text fonts only
    o = b.writeUInt32LE(table.length, o);
    for (const [cp, k, box] of table) { o = b.writeUInt32LE(cp, o); o = b.writeUInt32LE(k, o); for (const v of box) o = b.writeDoubleLE(v, o); }
    fs.writeSync(fd, b);
  }
  head.writeUInt32LE(families.length, 4); head.writeUInt32LE(index.size, 8);
  fs.writeSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  return Object.fromEntries(tables.map(([f, t]) => [f, t.map(([cp]) => cp)]));
}

/** Signatures files (CVS1) by code point: cp -> the three signatures' bytes. */
function readSigFile(file: string): Map<number, Buffer> {
  const b = fs.readFileSync(file);
  const n = b.readUInt32LE(4);
  const out = new Map<number, Buffer>();
  let o = 8;
  for (let i = 0; i < n; i++) {
    const start = o, cp = b.readUInt32LE(o); o += 4;
    for (let k = 0; k < 3; k++) {
      o += NUM_ANGLES * RAYS;
      const total = b.readUInt32LE(o), flags = b[o + 4]!; o += 5;
      for (let bit = 0; bit < 4; bit++) if (flags & (1 << bit)) o += total;
    }
    out.set(cp, b.subarray(start + 4, o));
  }
  return out;
}

/** The text fonts in the signature bank, cached: finding them means reading the whole 7.8 GB bank. */
async function bankFonts(): Promise<string[]> {
  const cache = path.join(ROOT, "data/output/bank-fonts.json");
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  const fonts = [...(await loadBankFor(new Set([0x61]))).get(0x61)!.keys()].sort();
  fs.writeFileSync(cache, JSON.stringify(fonts));
  return fonts;
}

function runNative(file: string, extra: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(NATIVE, [file, ...extra], { stdio: ["ignore", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    p.stdout.on("data", (c) => chunks.push(c));
    p.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error(`cv-pairs exited ${code}`)));
  });
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  if (!fs.existsSync(NATIVE)) execFileSync("cargo", ["build", "--release"], { cwd: path.dirname(path.dirname(path.dirname(NATIVE))), stdio: "inherit" });
  // The fonts: every family in the font catalogue that draws a letter or digit (src/font-catalogue.ts), each in the face
  // a browser uses for body text
  const fonts = measuredFamilies().filter((f) => (!only || f === only) && (!match || match.test(f))).sort().slice(0, limit);
  console.error(`${fonts.length} fonts, scope ${scope}`);
  // The TypeScript signature workers, only when something needs them
  const pool = (jsSigs || check || checkSigs) ? new SignaturePool() : ({ close: async () => {} } as unknown as SignaturePool);

  if (checkSigs) {
    const js = path.join(TMP, "check-js.bin"), outl = path.join(TMP, "check-outlines.bin"), rs = path.join(TMP, "check-rs.bin");
    let t = Date.now();
    await writeSignatures(pool, checkSigs, js);
    await pool.close();
    const jsSecs = (Date.now() - t) / 1000;
    writeOutlines(checkSigs, outl);
    t = Date.now();
    execFileSync(NATIVE, [outl, "--dump-sigs", rs, "--sample", "1"], { stdio: ["ignore", "ignore", "inherit"] });
    const rsSecs = (Date.now() - t) / 1000;
    const a = readSigFile(js), b = readSigFile(rs);
    let same = 0, diff = 0;
    for (const [cp, buf] of a) {
      if (b.get(cp)?.equals(buf)) same++;
      else { diff++; if (diff <= (process.env.SHOW_DIFFS ? 200 : 5)) console.error(`differs: U+${cp.toString(16).toUpperCase()}`); }
    }
    console.error(`${same} glyphs with all three signatures byte-identical, ${diff} different, ${b.size - a.size} extra in Rust; ` +
      `TypeScript ${jsSecs.toFixed(1)}s (13 workers), Rust ${rsSecs.toFixed(1)}s including the pairs sample`);
    for (const f of [js, outl, rs]) fs.rmSync(f);
    return;
  }

  if (check) {
    const keep = new Map<number, Signature[]>();
    const file = path.join(TMP, "check.bin");
    await writeSignatures(pool, check, file, keep);
    await pool.close();
    const out = execFileSync(NATIVE, [file, "--sample", "20000"], { maxBuffer: 1 << 28 }).toString().trim().split("\n");
    let same = 0, diff = 0;
    for (const line of out) {
      const [a, b, ...ds] = line.split(" ");
      const sa = keep.get(parseInt(a!, 16))!, sb = keep.get(parseInt(b!, 16))!;
      const js = [0, 1, 2].map((k) => compareGeometric(compact(sa[k]!), compact(sb[k]!), NUM_ANGLES, RAYS));
      if (js.every((d, k) => d === Number(ds[k]))) same++;
      else { diff++; if (diff <= 5) console.error("differs", a, b, js, ds); }
    }
    console.error(`${same} pairs identical to the TypeScript (all three distances), ${diff} different`);
    fs.rmSync(file);
    return;
  }

  const alike = new Map<string, [string, number, number][]>();
  const seqAlike = new Map<string, [string, number, number][]>(); // "character|sequence id" -> [font, box, em]
  const chars: Record<string, number[]> = {};
  const seqChars: Record<string, number[]> = {}; // per font, the sequences it sets
  const started = Date.now();
  // Fonts from the same file go to cv-pairs together, so outlines they share are signed once (--js-sigs: one at a time)
  const catalogue = fontCatalogue();
  const groups: string[][] = [];
  if (jsSigs || noGroup) for (const f of fonts) groups.push([f]);
  else {
    const byFile = new Map<string, string[]>();
    for (const f of fonts) { const file = catalogue.get(f)!.file; (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(f); }
    groups.push(...byFile.values());
  }
  // Cross-font: the page fonts' targets, written once
  const refsFile = path.join(TMP, `${outName}-refs.bin`);
  const refChars = crossFont ? writeRefs(refsFile, CROSS_REFERENCE_FONTS) : new Map<string, Set<number>>();
  const crossArgs = crossFont ? ["--cross", refsFile, ...(release2Rule ? ["--release2-rule"] : []), ...(process.argv.includes("--cross-em") ? ["--cross-em"] : [])] : [];
  // "x|t" -> [F, R, shape distance, em distance, extra space left, extra space right] (em; null where not measured)
  const crossHits = new Map<string, [string, string, number, number | null, number | null, number | null][]>();
  const overlapping: Record<string, number[]> = {}; // per font, glyphs measured on the union of their contours
  // A pipeline: Node extracts the next group's outlines (one thread) while cv-pairs works on this one (every core)
  const prepare = async (i: number) => {
    const t = Date.now(), file = path.join(TMP, `${outName}-${i % 2}.bin`);
    const one = groups[i]![0]!;
    const cps: Record<string, number[]> = jsSigs ? { [one]: await writeSignatures(pool, one, file) }
      : noGroup ? { [one]: writeOutlines(one, file) } : writeGroup(groups[i]!, file);
    return { file, cps, prepSecs: (Date.now() - t) / 1000 };
  };
  let next = groups.length ? await prepare(0) : undefined;
  let fontsDone = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!, cur = next!;
    for (const [f, cps] of Object.entries(cur.cps)) { chars[f] = cps.filter((c) => c < SEQ_BASE); if (sequences) seqChars[f] = cps.filter((c) => c >= SEQ_BASE); }
    const total = Object.values(cur.cps).reduce((k, c) => k + c.length, 0);
    const charCount = (f: string) => (cur.cps[f] ?? []).filter((c) => c < SEQ_BASE).length;
    const t1 = Date.now();
    const native = total > 1 || crossFont ? runNative(cur.file, crossArgs) : Promise.resolve("");
    next = i + 1 < groups.length ? await prepare(i + 1) : undefined;
    const output = await native;
    const nativeSecs = (Date.now() - t1) / 1000;
    const found = new Array(group.length).fill(0);
    for (const line of output.split("\n")) {
      if (!line) continue;
      const parts = line.split(" ");
      if (parts[0] === "O") { if (parseInt(parts[2]!, 16) < SEQ_BASE) (overlapping[group[Number(parts[1])]!] ??= []).push(parseInt(parts[2]!, 16)); continue; }
      if (parts[0] === "X") {
        const [, fi, x, t, ri, d, e, dl, dr] = parts;
        const key = `${parseInt(x!, 16)}|${parseInt(t!, 16)}`;
        const r4 = (v: string | undefined) => v === undefined || v === "NaN" ? null : Math.round(Number(v) * 10000) / 10000;
        (crossHits.get(key) ?? crossHits.set(key, []).get(key)!).push([group[Number(fi)]!, CROSS_REFERENCE_FONTS[Number(ri)]!, r4(d)!, r4(e), r4(dl), r4(dr)]);
        continue;
      }
      // CVG2 lines start with the font's index in the group
      const [fi, a, b, d, e] = parts.length === 5 ? [Number(parts[0]), ...parts.slice(1)] as [number, string, string, string, string] : [0, ...parts] as [number, string, string, string, string];
      // cv-pairs reports each pair in its input order, which with --js-sigs is the order the workers finished: key on
      // the lower code point first, or one pair splits into two rows
      const [lo, hi] = [parseInt(a, 16), parseInt(b, 16)].sort((x, y) => x - y);
      const key = `${lo}|${hi}`;
      const into = hi >= SEQ_BASE ? seqAlike : alike;
      (into.get(key) ?? into.set(key, []).get(key)!).push([group[fi]!, Math.round(Number(d) * 10000) / 10000, Math.round(Number(e) * 10000) / 10000]);
      if (hi < SEQ_BASE) found[fi]++;
    }
    if (process.argv.includes("--keep")) fs.renameSync(cur.file, path.join(TMP, `${outName}-${group[0]}.bin`));
    else fs.rmSync(cur.file, { force: true });
    fontsDone += group.length;
    console.error(`  ${fontsDone}/${fonts.length} ${group.map((f, k) => `${f}: ${charCount(f)} characters, ${found[k]} alike`).join("; ")} ` +
      `(outlines ${cur.prepSecs.toFixed(0)}s, cv-pairs ${nativeSecs.toFixed(0)}s; ${((Date.now() - started) / 60000).toFixed(1)} min)`);
  }
  await pool.close();

  // Fonts that draw both, for each alike pair
  const sets = Object.entries(chars).map(([f, cps]) => [f, new Set(cps)] as const);
  const out = fs.createWriteStream(path.join(ROOT, `data/output/${outName}.jsonl`));
  const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  for (const [key, list] of alike) {
    const [a, b] = key.split("|").map(Number) as [number, number];
    const drawBoth = sets.filter(([, s]) => s.has(a) && s.has(b));
    const both = drawBoth.length, bothText = drawBoth.filter(([f]) => !DISPLAY_FONTS.has(f)).length;
    const textAlike = list.filter(([f]) => !DISPLAY_FONTS.has(f)).length;
    out.write(JSON.stringify({
      a: hex(a), b: hex(b), method: "same font", sameScript: sameScript(a, b),
      fontsRenderingBoth: both, fontsAlike: list.length, share: Math.round((list.length / both) * 10000) / 10000,
      textFontsRenderingBoth: bothText, textFontsAlike: textAlike,
      textShare: bothText ? Math.round((textAlike / bothText) * 10000) / 10000 : 0,
      alike: Object.fromEntries(list.sort((p, q) => p[1] - q[1]).map(([f, d, e]) => [f, [d, e]])),
    }) + "\n");
  }
  out.end();
  fs.writeFileSync(path.join(ROOT, `data/output/${outName}.chars.json`), JSON.stringify(chars));
  if (sequences) {
    // Characters alike a two-character sequence in the same font, rows as above with b the sequence's text
    const seqSets = Object.entries(chars).map(([f, cps]) => [f, new Set([...cps, ...(seqChars[f] ?? [])])] as const);
    const sOut = fs.createWriteStream(path.join(ROOT, `data/output/${outName}.seq.jsonl`));
    for (const [key, list] of seqAlike) {
      const [a, b] = key.split("|").map(Number) as [number, number];
      const drawBoth = seqSets.filter(([, st]) => st.has(a) && st.has(b));
      const both = drawBoth.length, bothText = drawBoth.filter(([f]) => !DISPLAY_FONTS.has(f)).length;
      const textAlike = list.filter(([f]) => !DISPLAY_FONTS.has(f)).length;
      sOut.write(JSON.stringify({
        a: hex(a), b: seqText(b), method: "same font",
        fontsRenderingBoth: both, fontsAlike: list.length, share: Math.round((list.length / both) * 10000) / 10000,
        textFontsRenderingBoth: bothText, textFontsAlike: textAlike,
        textShare: bothText ? Math.round((textAlike / bothText) * 10000) / 10000 : 0,
        alike: Object.fromEntries(list.sort((p, q) => p[1] - q[1]).map(([f, d, e]) => [f, [d, e]])),
      }) + "\n");
    }
    sOut.end();
    fs.writeFileSync(path.join(ROOT, `data/output/${outName}.seq.chars.json`), JSON.stringify(Object.fromEntries(Object.entries(seqChars).map(([f, ids]) => [f, ids.map(seqText)]))));
    console.error(`${seqAlike.size} (character, sequence) pairs alike in at least one font -> data/output/${outName}.seq.jsonl`);
    if (layoutFallbacks.length) console.error(`sequences laid out by fontkit (Core Text could not open the face): ${[...new Set(layoutFallbacks)].join(", ")}`);
  }
  fs.writeFileSync(path.join(ROOT, `data/output/${outName}.overlap.json`), JSON.stringify(overlapping));
  if (Object.keys(outlineKeys).length) fs.writeFileSync(path.join(ROOT, `data/output/${outName}.outlines.json`), JSON.stringify(outlineKeys));
  if (crossFont) {
    // Combinations, as score-cross-font.ts counts them: (F, R) with F a text font drawing x, R a page font other than
    // F that draws target t and lacks x (release 2: x skipped when any page font draws it)
    const textFonts = Object.keys(chars).filter((f) => !DISPLAY_FONTS.has(f));
    const drawsBy = new Map<number, string[]>();
    for (const f of textFonts) for (const c of chars[f]!) (drawsBy.get(c) ?? drawsBy.set(c, []).get(c)!).push(f);
    // Which face macOS actually draws x in on a page set in R (scripts/platform-fallback.swift over the installed page
    // fonts; Roboto, Noto and DejaVu are not installed macOS fonts): a hit is "macOS actual" when F is that face
    const macFile = path.join(ROOT, "data/output/platform-fallback-refs-macos.tsv");
    const macCols = new Map<string, number>(), macFace = new Map<number, string[]>();
    if (fs.existsSync(macFile)) {
      const lines = fs.readFileSync(macFile, "utf8").trim().split("\n");
      lines[0]!.split("\t").slice(1).forEach((r, i) => macCols.set(r, i));
      for (const l of lines.slice(1)) { const c = l.split("\t"); macFace.set(parseInt(c[0]!, 16), c.slice(1).filter((_, i) => i % 2 === 0)); }
    }
    const actualOnMac = (x: number, F: string, R: string) => {
      const col = macCols.get(R);
      return col !== undefined && macFace.get(x)?.[col] === catalogue.get(F)?.postscriptName;
    };
    const out = fs.createWriteStream(path.join(ROOT, `data/output/${outName}.cross.jsonl`));
    const seqOut = sequences ? fs.createWriteStream(path.join(ROOT, `data/output/${outName}.seq-cross.jsonl`)) : undefined;
    let charRows = 0;
    for (const [key, hits] of crossHits) {
      const [x, t] = key.split("|").map(Number) as [number, number];
      let combos = 0;
      for (const F of drawsBy.get(x) ?? []) for (const R of CROSS_REFERENCE_FONTS) {
        if (R === F || refChars.get(R)!.has(x) || !refChars.get(R)!.has(t)) continue;
        combos++;
      }
      const macos = hits.filter(([F, R]) => actualOnMac(x, F, R)).map(([F, R, d]) => `${F} vs ${R} ${d}`);
      // Fits the line: the extra white space each side within FIT_SPACE (Paul, 26 Sep 2026: spacing is recorded, not a cut;
      // whether a lookalike convinces depends on the font that draws it)
      const fits = (h: (typeof hits)[number]) => h[4] !== null && h[5] !== null && Math.abs(h[4]) <= FIT_SPACE && Math.abs(h[5]) <= FIT_SPACE;
      (t >= SEQ_BASE ? seqOut! : out).write(JSON.stringify({ x: hex(x), t: t >= SEQ_BASE ? seqText(t) : hex(t), combos, alike: hits.length, share: combos ? Math.round((hits.length / combos) * 10000) / 10000 : 0,
        fitLine: hits.filter(fits).length, minDistance: Math.min(...hits.map((h) => h[2])), macosActual: macos,
        macosActualFits: hits.filter(([F, R]) => actualOnMac(x, F, R)).filter(fits).length,
        alikeIn: hits.sort((a, b) => a[2] - b[2]).map(([F, R, d]) => `${F} vs ${R} ${d}`),
        detail: hits.map(([F, R, d, e, dl, dr]) => [F, R, d, e, dl, dr]) }) + "\n");
      if (t < SEQ_BASE) charRows++;
    }
    out.end();
    seqOut?.end();
    if (sequences) console.error(`${crossHits.size - charRows} cross-font (character, sequence) pairs -> data/output/${outName}.seq-cross.jsonl`);
    console.error(`${charRows} cross-font (character, target) pairs alike in at least one combination -> data/output/${outName}.cross.jsonl`);
  }
  console.error(`${alike.size} pairs alike in at least one font -> data/output/${outName}.jsonl`);
}

/** Same Unicode Script property (Common and Inherited never count). */
function scriptOf(cp: number): string | undefined {
  const m = String.fromCodePoint(cp);
  for (const s of SCRIPTS) if (s.re.test(m)) return s.name;
  return undefined;
}
const SCRIPTS = ["Latin", "Greek", "Cyrillic", "Armenian", "Hebrew", "Arabic", "Syriac", "Thaana", "Nko", "Devanagari", "Bengali",
  "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Tibetan", "Myanmar",
  "Georgian", "Hangul", "Ethiopic", "Cherokee", "Canadian_Aboriginal", "Ogham", "Runic", "Khmer", "Mongolian", "Hiragana",
  "Katakana", "Bopomofo", "Han", "Yi", "Lisu", "Vai", "Bamum", "Tifinagh", "Coptic", "Gothic", "Carian", "Lycian", "Lydian",
  "Old_Italic", "Deseret", "Osmanya", "Cypriot", "Glagolitic", "Javanese", "Balinese", "Sundanese", "Tai_Le", "Buginese",
  "Ol_Chiki", "Adlam", "Osage", "Brahmi", "Old_Turkic", "Samaritan", "Mandaic", "Tagalog", "Cham", "Kayah_Li", "Saurashtra"]
  .map((name) => ({ name, re: new RegExp(`\\p{Script=${name}}`, "u") }));
function sameScript(a: number, b: number): boolean {
  const sa = scriptOf(a);
  return !!sa && sa === scriptOf(b);
}

main();
