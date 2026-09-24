/**
 * generate-font-weights-release.ts
 *
 * Per-font confusable weights for namespace-guard from release 2 measurements: for each lookalike that passes the
 * release's suggested thresholds (the same rule as confusable-weights-v3.json), the fonts where it is alike and how
 * close it is in each. Tools use it to say which font makes a lookalike most convincing.
 *
 *   similarity   1 - d / ALIKE, where d is the pair's shape distance in that font (rescore-pairs.ts): 1 when the two
 *                glyphs are identical, falling to 0 at the alike threshold. Only fonts where the pair passed both the
 *                shape and the baseline-anchored test are listed.
 *
 * Pairs found alike only across fonts (a rare character drawn in a fallback font beside Latin) have no single font and
 * are left out. Release 2 replaces the February SSIM file (font-specific-weights.json), which was blind to size.
 *
 * Usage:
 *   npx tsx scripts/generate-font-weights-release.ts [release-dir]
 *
 * Output: data/output/font-specific-weights-v3.json
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { passes } from "../src/thresholds.js";

/** rescore-pairs.ts's shape threshold (not imported: importing it runs the rescoring). */
const ALIKE = 0.5;

const ROOT = join(import.meta.dirname, "..");
const releaseDir = process.argv[2] ?? join(ROOT, "data/release", readdirSync(join(ROOT, "data/release")).sort().at(-1)!);

const jsonl = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const characters = new Map(
  jsonl(gunzipSync(readFileSync(join(releaseDir, "characters.jsonl.gz"))).toString("utf8")).map((c: any) => [c.codepoint, c]));
const release = readFileSync(join(releaseDir, "DATASET.md"), "utf8").match(/release (\d{4}\.\d{2}\.\d{2})/)?.[1];

// The per-font distances behind the release's same-font rows (the release itself lists only the font names)
const fonts: Record<string, { edges: any[] }> = {};
let pairs = 0;
for (const m of jsonl(readFileSync(join(ROOT, "data/output/rescored-pairs.jsonl"), "utf8"))) {
  if (!passes({ method: "same font", ...m })) continue;
  const a = characters.get(m.a), b = characters.get(m.b);
  if (!a || !b) continue;
  // The more common character is the target, as in confusable-weights-v3.json: ASCII first, then the lower code point
  const [src, tgt] = [a, b].sort((p: any, q: any) => {
    const ap = p.char.charCodeAt(0) < 0x80 ? 0 : 1, aq = q.char.charCodeAt(0) < 0x80 ? 0 : 1;
    return ap !== aq ? aq - ap : parseInt(q.codepoint.slice(2), 16) - parseInt(p.codepoint.slice(2), 16);
  });
  pairs++;
  for (const [font, d] of Object.entries(m.alikeFonts as Record<string, number>)) {
    (fonts[font] ??= { edges: [] }).edges.push({
      source: src.char, sourceCodepoint: src.codepoint, target: tgt.char, targetCodepoint: tgt.codepoint,
      similarity: Math.round((1 - d / ALIKE) * 10000) / 10000, distance: d,
      idnaPvalid: src.idna2008 === "valid",
    });
  }
}
for (const f of Object.values(fonts)) f.edges.sort((p, q) => q.similarity - p.similarity);

const out = {
  meta: {
    generatedAt: new Date().toISOString(), release, scorer: "rayspace-release-2", fontSetId: "macos-system-plus-roboto",
    fontCount: Object.keys(fonts).length, pairCount: pairs, licence: "CC-BY-4.0",
    attribution: "Paul Wood FRSA (@paultendo), confusable-vision",
    weights: `similarity = 1 - shape distance / ${ALIKE} in that font, for fonts where the pair is alike in shape and at the baseline`,
  },
  fonts: Object.fromEntries(Object.entries(fonts).sort(([p], [q]) => p.localeCompare(q))),
};
writeFileSync(join(ROOT, "data/output/font-specific-weights-v3.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`${pairs} pairs across ${out.meta.fontCount} fonts from release ${release}`);
