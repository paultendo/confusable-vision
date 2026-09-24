/**
 * generate-weights-release.ts
 *
 * Confusable weights for namespace-guard from a release (data/release/<version>/): one edge per lookalike that passes
 * the release's suggested thresholds (the same rule as the IDN view). A pair's presence says it was found alike; its
 * weights say how widely:
 *
 *   danger, stableDanger   the share of text fonts (or, across fonts, of font combinations) where it is alike
 *   cost                   1 - share
 *
 * Release 2 replaces the March weights (confusable-weights-v2.json), whose distances were blind to size and mapped
 * distance to similarity as 1 - d/2, flagging pairs such as c/o that readers tell apart.
 *
 * Usage:
 *   npx tsx scripts/generate-weights-release.ts [release-dir]
 *
 * Output: data/output/confusable-weights-v3.json
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { passes } from "../src/thresholds.js";

const ROOT = join(import.meta.dirname, "..");
const releaseDir = process.argv[2] ?? join(ROOT, "data/release", readdirSync(join(ROOT, "data/release")).sort().at(-1)!);

function rangeSet(file: string, value: string): Set<number> {
  const out = new Set<number>();
  for (const raw of readFileSync(join(ROOT, "data/input", file), "utf8").split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const [range, v] = line.split(";").map((s) => s.trim());
    if (v !== value) continue;
    const [a, b] = range!.split("..");
    for (let cp = parseInt(a!, 16); cp <= parseInt(b ?? a!, 16); cp++) out.add(cp);
  }
  return out;
}

const jsonl = (file: string) =>
  gunzipSync(readFileSync(join(releaseDir, file))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const characters = new Map(jsonl("characters.jsonl.gz").map((c: any) => [c.codepoint, c]));
const xid = rangeSet("DerivedCoreProperties.txt", "XID_Continue");
const allowed = rangeSet("IdentifierStatus.txt", "Allowed");
const release = readFileSync(join(releaseDir, "DATASET.md"), "utf8").match(/release (\d{4}\.\d{2}\.\d{2})/)?.[1];

const edges = [];
for (const l of jsonl("lookalikes.jsonl.gz")) {
  if (!passes(l)) continue;
  const a = characters.get(l.a), b = characters.get(l.b);
  // The more common character is the target: ASCII first, then the lower code point
  const [src, tgt] = [a, b].sort((p: any, q: any) => {
    const ap = p.char.charCodeAt(0) < 0x80 ? 0 : 1, aq = q.char.charCodeAt(0) < 0x80 ? 0 : 1;
    return ap !== aq ? aq - ap : parseInt(q.codepoint.slice(2), 16) - parseInt(p.codepoint.slice(2), 16);
  });
  const share = l.method === "same font" ? l.textShare : l.share;
  const cp = parseInt(src.codepoint.slice(2), 16);
  edges.push({
    source: src.char, sourceCodepoint: src.codepoint, target: tgt.char, targetCodepoint: tgt.codepoint,
    sourceScript: src.script, targetScript: tgt.script, method: l.method,
    danger: share, stableDanger: share, cost: Math.round((1 - share) * 10000) / 10000,
    xidContinue: xid.has(cp), idnaPvalid: src.idna2008 === "valid", tr39Allowed: allowed.has(cp),
  });
}
edges.sort((p, q) => q.danger - p.danger || p.sourceCodepoint.localeCompare(q.sourceCodepoint));
const out = {
  meta: {
    generatedAt: new Date().toISOString(), pairCount: edges.length, release, scorer: "rayspace-release-2",
    fontSetId: "macos-system-plus-roboto", licence: "CC-BY-4.0",
    attribution: "Paul Wood FRSA (@paultendo), confusable-vision",
    weights: "danger = stableDanger = share of text fonts (or font combinations) where the pair is alike; cost = 1 - share",
  },
  edges,
};
writeFileSync(join(ROOT, "data/output/confusable-weights-v3.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`${edges.length} edges from release ${release}`);
