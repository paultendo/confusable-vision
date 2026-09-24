/**
 * export-idn-pairs.ts
 *
 * The IDN-relevant view of a release (data/release/<version>/, built by build-release.ts): lookalikes that can appear
 * in domain names. A pair is included when
 *
 *   1. it passes the release's suggested thresholds: within one font, alike in at least 3 text fonts and at least 5%
 *      of the text fonts rendering both; across fonts, alike in at least 3 font combinations and at least 10% of them;
 *   2. both characters can be registered at a common TLD, among those whose registry rules the release records
 *      ("registrableAt": ASCII letters and digits count everywhere).
 *
 * Registrability decides, not TR39 status: Verisign's .com and .net tables accept characters TR39 marks Obsolete or
 * Technical. Each pair carries both characters' Identifier_Type so a stricter consumer can filter on it.
 *
 * Usage:
 *   npx tsx scripts/export-idn-pairs.ts [release-dir]
 *
 * Output: data/output/idn-relevant-pairs.json
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { SAME_FONT, ACROSS_FONTS, passes } from "../src/thresholds.js";

const ROOT = join(import.meta.dirname, "..");
const latestRelease = () => join(ROOT, "data/release", readdirSync(join(ROOT, "data/release")).sort().at(-1)!);
const releaseDir = process.argv[2] ?? latestRelease();
const outPath = join(ROOT, "data/output/idn-relevant-pairs.json");


type Character = { codepoint: string; char: string; name: string; script: string; identifierType: string; registrableAt: string[] };

const jsonl = <T>(file: string): T[] =>
  gunzipSync(readFileSync(join(releaseDir, file))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function main() {
  const characters = new Map(jsonl<Character>("characters.jsonl.gz").map((c) => [c.codepoint, c]));
  const release = readFileSync(join(releaseDir, "DATASET.md"), "utf8").match(/release (\d{4}\.\d{2}\.\d{2})/)?.[1];
  const side = (c: Character) => ({ char: c.char, codepoint: c.codepoint, script: c.script, identifierType: c.identifierType });

  const rows = [];
  for (const l of jsonl<any>("lookalikes.jsonl.gz")) {
    if (!passes(l)) continue;
    const a = characters.get(l.a)!, b = characters.get(l.b)!;
    const registrableAt = a.registrableAt.filter((t) => b.registrableAt.includes(t));
    if (registrableAt.length === 0) continue;
    rows.push({
      a: side(a), b: side(b),
      scripts: [a.script, b.script].sort().join("-"),
      method: l.method,
      ...(l.method === "same font"
        ? { textFontsAlike: l.textFontsAlike, textFontsRenderingBoth: l.textFontsRenderingBoth, share: l.textShare,
            meanDistanceWhereAlike: l.meanDistanceWhereAlike }
        : { alike: l.alike, combinations: l.combinations, share: l.share }),
      registrableAt,
      alikeIn: l.alikeIn,
    });
  }
  rows.sort((p, q) => q.share - p.share);

  const out = {
    description:
      "Lookalike characters that can appear in domain names: pairs from the confusable-vision release named below " +
      "that pass its suggested thresholds and whose characters can both be registered at a common TLD. Measured by " +
      "RaySpace at the size and baseline position each glyph has in running text; see the release's DATASET.md.",
    license: "CC-BY-4.0. Attribution: confusable-vision, Paul Wood FRSA (@paultendo).",
    release,
    selection: {
      rule:
        `Within one font: alike in at least ${SAME_FONT.minFonts} text fonts (or all of them, if fewer render both) and at least ${SAME_FONT.minShare * 100}% of the ` +
        `text fonts rendering both. Across fonts: alike in at least ${ACROSS_FONTS.minCombinations} font combinations and ` +
        `at least ${ACROSS_FONTS.minShare * 100}% of them. Both characters registrable at a common TLD ("registrableAt").`,
      sameFont: SAME_FONT,
      acrossFonts: ACROSS_FONTS,
    },
    counts: {
      pairs: rows.length,
      sameFont: rows.filter((r) => r.method === "same font").length,
      acrossFonts: rows.filter((r) => r.method === "across fonts").length,
      crossScript: rows.filter((r) => r.a.script !== r.b.script).length,
      bothRecommended: rows.filter((r) => r.a.identifierType === "Recommended" && r.b.identifierType === "Recommended").length,
    },
    pairs: rows,
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out.counts), "->", outPath);
}

main();
