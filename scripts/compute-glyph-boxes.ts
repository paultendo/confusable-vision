/**
 * compute-glyph-boxes.ts
 *
 * The real size and position of each glyph, which ray signatures do not keep: rays are spread across each glyph's
 * own bounding box and positions are fractions of it, so a signature is the same at any size or height. In running
 * text every character sits at one font size on one baseline, so o and O, or D and o, do not look alike however
 * similar their shapes.
 *
 * For every (code point, font) in the given discovery files, writes the outline's bounding box in em units, with the
 * baseline at 0 (y up), and the advance width.
 *
 * Usage:
 *   npx tsx scripts/compute-glyph-boxes.ts <discoveries.jsonl>... > data/output/glyph-boxes.jsonl
 */

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { extractGlyphPath, loadFont } from "../src/glyph-path.js";
import { systemFontPaths } from "../src/glyph-box.js";


async function main() {
  const wanted = new Map<string, Set<number>>(); // font -> code points
  for (const file of process.argv.slice(2)) {
    const rl = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.startsWith('{"type":"discovery"')) continue;
      const o = JSON.parse(line);
      let set = wanted.get(o.font);
      if (!set) wanted.set(o.font, (set = new Set()));
      set.add(parseInt(o.sourceCodepoint.slice(2), 16));
      set.add(parseInt(o.targetCodepoint.slice(2), 16));
    }
  }
  const paths = systemFontPaths();
  let written = 0, missingFont = 0, missingGlyph = 0;
  for (const [family, cps] of wanted) {
    const file = paths.get(family);
    const font = file ? loadFont(file) : null;
    if (!font) { missingFont += cps.size; console.error(`no font file for ${family}`); continue; }
    const em = font.unitsPerEm;
    for (const cp of cps) {
      const g = extractGlyphPath(font, cp);
      if (!g) { missingGlyph++; continue; }
      const r = (v: number) => Math.round((v / em) * 10000) / 10000;
      process.stdout.write(JSON.stringify({
        cp: cp.toString(16).toUpperCase().padStart(4, "0"), font: family,
        xMin: r(g.bbox.minX), yMin: r(g.bbox.minY), xMax: r(g.bbox.maxX), yMax: r(g.bbox.maxY), advance: r(g.advanceWidth),
      }) + "\n");
      written++;
    }
  }
  console.error(`${written} glyph boxes; ${missingFont} without a font file; ${missingGlyph} without a glyph`);
}

main();
