/**
 * compute-em-signatures.ts
 *
 * Baseline-anchored signatures (normalizeToEmFrame, fixed em frame) for every (code point, font) in the glyph box
 * table, on every core. The release scoring uses them beside the bank's box-relative signatures: shape is judged on
 * the glyph's own box, size and position against the shared baseline (docs/metric-calibration.md).
 *
 * Usage:
 *   npx tsx scripts/compute-em-signatures.ts [glyph-boxes.jsonl]
 *
 * Output: data/output/em-signatures.jsonl.gz (the signature bank's line format)
 */

import fs from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { SignaturePool } from "../src/signature-pool.js";
import { loadFont, extractGlyphPath, normalizeToEmFrame, emFrame } from "../src/glyph-path.js";
import { systemFontPaths } from "../src/glyph-box.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const boxesPath = process.argv[2] ?? path.join(ROOT, "data/output/glyph-boxes.jsonl");

async function main() {
  const byFont = new Map<string, Set<number>>();
  for (const line of fs.readFileSync(boxesPath, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    const b = JSON.parse(line);
    let s = byFont.get(b.font);
    if (!s) byFont.set(b.font, (s = new Set()));
    s.add(parseInt(b.cp, 16));
  }
  const pool = new SignaturePool();
  const paths = systemFontPaths();
  const entries = new Map<number, Record<string, unknown>[]>();
  const jobs: Promise<void>[] = [];
  for (const [family, cps] of byFont) {
    const file = paths.get(family);
    const font = file ? loadFont(file) : null;
    if (!font) { console.error(`no font file for ${family}`); continue; }
    for (const cp of cps) {
      const g = extractGlyphPath(font, cp);
      if (!g) continue;
      jobs.push(pool.compute(normalizeToEmFrame(g, font.unitsPerEm, 128), emFrame(128)).then((s) => {
        const e: Record<string, unknown> = { font: family, advanceWidth: g.advanceWidth, counts: s.counts };
        if (s.positions.length) e.positions = s.positions;
        if (s.angles.length) e.angles = s.angles;
        if (s.pingDistances.length) e.pingDistances = s.pingDistances;
        if (s.pingMax.length) e.pingMax = s.pingMax;
        let list = entries.get(cp);
        if (!list) entries.set(cp, (list = []));
        list.push(e);
      }));
    }
  }
  let done = 0;
  jobs.forEach((j) => j.then(() => { if (++done % 10000 === 0) console.error(`  ${done}/${jobs.length}`); }));
  await Promise.all(jobs);
  await pool.close();
  // Streamed: the whole file is larger than the longest string V8 allows
  const gz = createGzip();
  const out = fs.createWriteStream(path.join(ROOT, "data/output/em-signatures.jsonl.gz"));
  gz.pipe(out);
  const write = async (line: string) => { if (!gz.write(line + "\n")) await once(gz, "drain"); };
  await write(JSON.stringify({ type: "meta", generatedAt: new Date().toISOString(), frame: "em", gridSize: 128, numAngles: 36, raysPerAngle: 50 }));
  for (const cp of [...entries.keys()].sort((a, b) => a - b)) {
    await write(JSON.stringify({ type: "entry", cp: cp.toString(16).toUpperCase().padStart(4, "0"), entries: entries.get(cp) }));
  }
  gz.end();
  await once(out, "finish");
  console.error(`${jobs.length} baseline-anchored signatures for ${entries.size} code points`);
}

main();
