/**
 * score-pairs-from-bank.ts
 *
 * RaySpace distances for a given list of character pairs, read from the signature bank with the same method as
 * discover-singlechar-sdf.ts (ray-only scorer): per font, the pair is compared only if the two advance widths are
 * within 15% of each other, the distance is compareEnrichedArrays() on the bank signatures, and a font counts as a
 * discovery when the distance is at most 2.0. The discovery run only compared characters across its twelve script
 * sets; this scores pairs outside that population (same-script pairs, characters outside the sets) so every pair
 * can carry a RaySpace measurement.
 *
 * Output is discovery lines in the same format as singlechar-sdf-discoveries.jsonl, so build-release.ts can take
 * both files.
 *
 * Usage:
 *   npx tsx scripts/score-pairs-from-bank.ts <pairs.json> <out.jsonl>
 *       pairs.json: [["U+0131","U+0069"], ...]
 *   --font <family> scores only that font (for a font added through a side bank)
 *   npx tsx scripts/score-pairs-from-bank.ts --validate <n> <out.jsonl>
 *       rescore n pairs sampled from singlechar-sdf-discoveries.jsonl and report how far the distances differ
 */

import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { compareEnrichedArrays, type CompactBankTarget } from "../src/signature-bank.js";
import { loadBankFor } from "../src/bank-load.js";
import { rangeLookup } from "../src/ranges.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const BANK_PATH = path.join(ROOT, "data/output/signature-bank.jsonl.gz");
const DISCOVERIES_PATH = path.join(ROOT, "data/output/singlechar-sdf-discoveries.jsonl");
const NUM_ANGLES = 36;
const RAYS_PER_ANGLE = 50;
const WIDTH_TOLERANCE = 0.15;
const RAY_THRESHOLD = 2.0;

const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
const cpOf = (s: string) => parseInt(s.replace(/^U\+/, ""), 16);

function scriptOf(): (cp: number) => string {
  const lookup = rangeLookup(path.join(ROOT, "data/input/Scripts.txt"));
  return (cp) => lookup(cp) ?? "Unknown";
}


function distance(a: CompactBankTarget, b: CompactBankTarget): number | null {
  if (a.advanceWidth <= 0 || b.advanceWidth <= 0) return null;
  if (b.advanceWidth < a.advanceWidth / (1 + WIDTH_TOLERANCE) || b.advanceWidth > a.advanceWidth * (1 + WIDTH_TOLERANCE)) {
    return null;
  }
  return compareEnrichedArrays(a.counts, a.positions, b.counts, b.positions, NUM_ANGLES, RAYS_PER_ANGLE,
    a.angles, b.angles, a.pingDistances, b.pingDistances, a.pingMax, b.pingMax);
}

async function sampleDiscoveries(n: number): Promise<{ pairs: [number, number][]; recorded: Map<string, number> }> {
  // Every k-th distinct pair, so the sample spans the file without randomness
  const recorded = new Map<string, number>();
  const rl = createInterface({ input: createReadStream(DISCOVERIES_PATH), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"discovery"')) continue;
    const o = JSON.parse(line);
    recorded.set(`${o.sourceCodepoint}|${o.targetCodepoint}|${o.font}`, o.rayDistance);
  }
  const keys = [...new Set([...recorded.keys()].map((k) => k.split("|").slice(0, 2).join("|")))];
  const step = Math.max(1, Math.floor(keys.length / n));
  const pairs = keys.filter((_, i) => i % step === 0).slice(0, n).map((k) => k.split("|").map(cpOf) as [number, number]);
  return { pairs, recorded };
}

async function main() {
  const fontIdx = process.argv.indexOf("--font");
  const onlyFont = fontIdx > 0 ? process.argv[fontIdx + 1] : undefined;
  if (fontIdx > 0) process.argv.splice(fontIdx, 2);
  const validate = process.argv[2] === "--validate";
  const outPath = validate ? process.argv[4]! : process.argv[3]!;
  let pairs: [number, number][];
  let recorded: Map<string, number> | null = null;
  if (validate) {
    ({ pairs, recorded } = await sampleDiscoveries(parseInt(process.argv[3]!, 10)));
  } else {
    pairs = (JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as [string, string][]).map(([a, b]) => [cpOf(a), cpOf(b)]);
  }
  const needed = new Set(pairs.flat());
  console.log(`${pairs.length} pairs over ${needed.size} code points`);
  const bank = await loadBankFor(needed);
  const script = scriptOf();

  const out = fs.openSync(outPath, "w");
  fs.writeSync(out, JSON.stringify({ type: "meta", scorer: "ray", method: "pair-list", numAngles: NUM_ANGLES,
    raysPerAngle: RAYS_PER_ANGLE, widthTolerance: WIDTH_TOLERANCE, rayThreshold: RAY_THRESHOLD,
    pairs: pairs.length }) + "\n");
  let found = 0, missing = 0;
  const diffs: number[] = [];
  let recordedOnly = 0, rescoredOnly = 0;
  for (const [a, b] of pairs) {
    const fa = bank.get(a), fb = bank.get(b);
    if (!fa || !fb) { missing++; continue; }
    for (const [font, ta] of fa) {
      if (onlyFont && font !== onlyFont) continue;
      const tb = fb.get(font);
      if (!tb) continue;
      const d = distance(ta, tb);
      const key = `${hex(a)}|${hex(b)}|${font}`;
      const known = recorded?.get(key) ?? recorded?.get(`${hex(b)}|${hex(a)}|${font}`);
      if (d === null || d > RAY_THRESHOLD) {
        if (known !== undefined) recordedOnly++;
        continue;
      }
      const rd = Math.round(d * 10000) / 10000;
      if (recorded) {
        if (known === undefined) rescoredOnly++;
        else diffs.push(Math.abs(known - rd));
      }
      found++;
      fs.writeSync(out, JSON.stringify({
        type: "discovery",
        source: String.fromCodePoint(a), sourceCodepoint: hex(a), sourceScript: script(a),
        target: String.fromCodePoint(b), targetCodepoint: hex(b), targetScript: script(b),
        font, sdfL2: -1, sdfNCC: -1, rayDistance: rd,
      }) + "\n");
    }
  }
  fs.closeSync(out);
  console.log(`${found} font-level discoveries written to ${outPath}; ${missing} pairs had a character missing from the bank`);
  if (recorded) {
    diffs.sort((x, y) => x - y);
    const exact = diffs.filter((d) => d === 0).length;
    console.log(`validation: ${diffs.length} font-level distances matched against the March run, ${exact} identical, ` +
      `max difference ${diffs.at(-1) ?? 0}; ${recordedOnly} recorded in March but not reproduced, ` +
      `${rescoredOnly} found now but not recorded in March`);
  }
}

main();
