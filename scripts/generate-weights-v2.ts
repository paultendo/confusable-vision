/**
 * generate-weights-v2.ts
 *
 * Produce confusable-weights-v2.json from RaySpace discovery JSONL.
 *
 * Reads singlechar-sdf-discoveries.jsonl (764K lines, 249,976 unique pairs)
 * and produces per-pair distributional records with backward-compatible
 * danger/stableDanger/cost fields for namespace-guard.
 *
 * Output:
 *   - data/output/confusable-weights-v2.json  (committed, pairs below threshold)
 *   - data/output/confusable-weights-v2-full.jsonl (gitignored, all pairs)
 *
 * Usage:
 *   npx tsx scripts/generate-weights-v2.ts
 *   npx tsx scripts/generate-weights-v2.ts --threshold 0.5   # strict only
 *   npx tsx scripts/generate-weights-v2.ts --threshold 2.0   # everything
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type {
  ConfusableEdgeWeight,
  ConfusableWeightsOutput,
  IdentifierProperties,
} from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_INPUT = path.join(ROOT, 'data/input');
const DATA_OUTPUT = path.join(ROOT, 'data/output');

const DISCOVERY_PATH = path.join(DATA_OUTPUT, 'singlechar-sdf-discoveries.jsonl');
const CONFUSABLES_TXT = path.join(DATA_INPUT, 'confusables.txt');
const DERIVED_CORE_PATH = path.join(DATA_INPUT, 'DerivedCoreProperties.txt');
const IDNA_PATH = path.join(DATA_INPUT, 'IdnaMappingTable.txt');
const ID_STATUS_PATH = path.join(DATA_INPUT, 'IdentifierStatus.txt');

const OUTPUT_JSON = path.join(DATA_OUTPUT, 'confusable-weights-v2.json');
const OUTPUT_JSONL = path.join(DATA_OUTPUT, 'confusable-weights-v2-full.jsonl');

const FONT_SET_ID = 'macos-arm64-system-245fonts';
const MAX_RAY_DISTANCE = 2.0;

// ---------------------------------------------------------------------------
// Reused from annotate-properties.ts
// ---------------------------------------------------------------------------

function parseRangeSet(filePath: string, property: string): Set<number> {
  const text = fs.readFileSync(filePath, 'utf-8');
  const result = new Set<number>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(';');
    if (parts.length < 2) continue;

    const propField = parts[1]!.trim().split('#')[0]!.trim();
    if (propField !== property) continue;

    const range = parts[0]!.trim();
    if (range.includes('..')) {
      const [startHex, endHex] = range.split('..');
      const start = parseInt(startHex!, 16);
      const end = parseInt(endHex!, 16);
      for (let cp = start; cp <= end; cp++) {
        result.add(cp);
      }
    } else {
      result.add(parseInt(range, 16));
    }
  }

  return result;
}

function parseIdnaPvalid(filePath: string): Set<number> {
  const text = fs.readFileSync(filePath, 'utf-8');
  const result = new Set<number>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(';');
    if (parts.length < 2) continue;

    const status = parts[1]!.trim().split('#')[0]!.trim();
    if (status !== 'valid') continue;

    const range = parts[0]!.trim();
    if (range.includes('..')) {
      const [startHex, endHex] = range.split('..');
      const start = parseInt(startHex!, 16);
      const end = parseInt(endHex!, 16);
      for (let cp = start; cp <= end; cp++) {
        result.add(cp);
      }
    } else {
      result.add(parseInt(range, 16));
    }
  }

  return result;
}

function getProperties(
  cp: number,
  xidStart: Set<number>,
  xidContinue: Set<number>,
  idnaPvalid: Set<number>,
  tr39Allowed: Set<number>,
): IdentifierProperties {
  return {
    xidStart: xidStart.has(cp),
    xidContinue: xidContinue.has(cp),
    idnaPvalid: idnaPvalid.has(cp),
    tr39Allowed: tr39Allowed.has(cp),
  };
}

// ---------------------------------------------------------------------------
// TR39 confusables.txt pair lookup
// ---------------------------------------------------------------------------

function buildTr39PairSet(filePath: string): Set<string> {
  const text = fs.readFileSync(filePath, 'utf-8');
  const pairs = new Set<string>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(';');
    if (parts.length < 2) continue;

    const sourceHexes = parts[0]!.trim().split(/\s+/);
    const targetHexes = parts[1]!.trim().split(/\s+/);

    // Only single-char to single-char pairs
    if (sourceHexes.length !== 1 || targetHexes.length !== 1) continue;

    const srcCp = parseInt(sourceHexes[0]!, 16);
    const tgtCp = parseInt(targetHexes[0]!, 16);
    if (isNaN(srcCp) || isNaN(tgtCp)) continue;

    const srcHex = 'U+' + srcCp.toString(16).toUpperCase().padStart(4, '0');
    const tgtHex = 'U+' + tgtCp.toString(16).toUpperCase().padStart(4, '0');

    pairs.add(`${srcHex}:${tgtHex}`);
    pairs.add(`${tgtHex}:${srcHex}`);
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (idx - lower);
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Discovery line types
// ---------------------------------------------------------------------------

interface DiscoveryLine {
  type: 'discovery';
  source: string;
  sourceCodepoint: string;
  sourceScript: string;
  target: string;
  targetCodepoint: string;
  targetScript: string;
  font: string;
  rayDistance: number;
}

interface PairAccumulator {
  source: string;
  sourceCodepoint: string;
  sourceScript: string;
  target: string;
  targetCodepoint: string;
  targetScript: string;
  distances: number[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const threshold = parseFloat(
    process.argv.find((_, i) => process.argv[i - 1] === '--threshold') ?? '1.0'
  );
  console.log(`generate-weights-v2: threshold=${threshold}\n`);

  // 1. Load property lookup sets
  console.log('[1/5] Loading Unicode property sets...');
  const xidStart = parseRangeSet(DERIVED_CORE_PATH, 'XID_Start');
  const xidContinue = parseRangeSet(DERIVED_CORE_PATH, 'XID_Continue');
  const idnaPvalid = parseIdnaPvalid(IDNA_PATH);
  const tr39Allowed = parseRangeSet(ID_STATUS_PATH, 'Allowed');

  console.log(`  XID_Start:    ${xidStart.size.toLocaleString()}`);
  console.log(`  XID_Continue: ${xidContinue.size.toLocaleString()}`);
  console.log(`  IDNA PVALID:  ${idnaPvalid.size.toLocaleString()}`);
  console.log(`  TR39 Allowed: ${tr39Allowed.size.toLocaleString()}`);

  // 2. Build TR39 pair lookup
  console.log('\n[2/5] Building TR39 pair lookup...');
  const tr39Pairs = buildTr39PairSet(CONFUSABLES_TXT);
  console.log(`  TR39 pair keys: ${tr39Pairs.size.toLocaleString()}`);

  // 3. Stream discovery JSONL and accumulate per-pair distances
  console.log('\n[3/5] Reading discovery JSONL...');
  const pairMap = new Map<string, PairAccumulator>();
  let discoveryCount = 0;
  let skipped = 0;

  const fileStream = fs.createReadStream(DISCOVERY_PATH, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.startsWith('{"type":"discovery"')) {
      skipped++;
      continue;
    }

    const d = JSON.parse(line) as DiscoveryLine;
    discoveryCount++;

    // Canonical key: sort codepoints to deduplicate A:B / B:A
    const [cpA, cpB] = [d.sourceCodepoint, d.targetCodepoint].sort();
    const key = `${cpA}:${cpB}`;

    let acc = pairMap.get(key);
    if (!acc) {
      // Use the order where source comes first alphabetically by codepoint
      const srcFirst = d.sourceCodepoint <= d.targetCodepoint;
      acc = {
        source: srcFirst ? d.source : d.target,
        sourceCodepoint: srcFirst ? d.sourceCodepoint : d.targetCodepoint,
        sourceScript: srcFirst ? d.sourceScript : d.targetScript,
        target: srcFirst ? d.target : d.source,
        targetCodepoint: srcFirst ? d.targetCodepoint : d.sourceCodepoint,
        targetScript: srcFirst ? d.targetScript : d.sourceScript,
        distances: [],
      };
      pairMap.set(key, acc);
    }

    acc.distances.push(d.rayDistance);
  }

  console.log(`  Discoveries: ${discoveryCount.toLocaleString()}`);
  console.log(`  Skipped (meta/font-done): ${skipped.toLocaleString()}`);
  console.log(`  Unique pairs: ${pairMap.size.toLocaleString()}`);

  // 4. Compute edges
  console.log('\n[4/5] Computing distributional stats...');
  const allEdges: ConfusableEdgeWeight[] = [];
  let tierCounts = { strict: 0, standard: 0, exploratory: 0 };

  for (const [, acc] of pairMap) {
    const distances = acc.distances.slice().sort((a, b) => a - b);
    const fontCount = distances.length;
    const zeroCount = distances.filter(d => d === 0).length;

    const rayMean = distances.reduce((a, b) => a + b, 0) / fontCount;
    const rayP50 = percentile(distances, 50);
    const rayP90 = percentile(distances, 90);
    const rayMin = distances[0]!;

    // Tier based on mean distance
    const tier: 'strict' | 'standard' | 'exploratory' =
      rayMean < 0.50 ? 'strict' :
      rayMean < 1.00 ? 'standard' :
      'exploratory';
    tierCounts[tier]++;

    // Backward-compatible scores: map ray distance to 0-1 similarity
    const similarities = distances.map(d => Math.max(0, 1 - d / MAX_RAY_DISTANCE));
    similarities.sort((a, b) => a - b);
    const danger = round(Math.max(0, 1 - rayMin / MAX_RAY_DISTANCE));
    const stableDanger = round(percentile(similarities, 95));
    const cost = round(Math.max(0, Math.min(1, 1 - stableDanger)));

    // Property flags for source character
    const srcCp = parseInt(acc.sourceCodepoint.slice(2), 16);
    const props = getProperties(srcCp, xidStart, xidContinue, idnaPvalid, tr39Allowed);

    // TR39 lookup (check both directions)
    const inTr39 = tr39Pairs.has(`${acc.sourceCodepoint}:${acc.targetCodepoint}`) ||
                   tr39Pairs.has(`${acc.targetCodepoint}:${acc.sourceCodepoint}`);

    const edge: ConfusableEdgeWeight = {
      source: acc.source,
      sourceCodepoint: acc.sourceCodepoint,
      target: acc.target,
      // v1 same/cross fields: not applicable for RaySpace (all comparisons are same-font)
      sameMax: danger,
      sameP95: stableDanger,
      sameMean: round(1 - rayMean / MAX_RAY_DISTANCE),
      sameN: fontCount,
      crossMax: 0,
      crossP95: 0,
      crossMean: 0,
      crossN: 0,
      danger,
      stableDanger,
      cost,
      glyphReuse: false,
      xidContinue: props.xidContinue,
      xidStart: props.xidStart,
      idnaPvalid: props.idnaPvalid,
      tr39Allowed: props.tr39Allowed,
      inTr39,
      fontSetId: FONT_SET_ID,
      // v2 distributional fields
      rayMean: round(rayMean),
      rayP50: round(rayP50),
      rayP90: round(rayP90),
      rayMin: round(rayMin),
      zeroCount,
      zeroFraction: round(zeroCount / fontCount),
      tier,
      sourceScript: acc.sourceScript,
      targetScript: acc.targetScript,
    };

    allEdges.push(edge);
  }

  // Sort by danger descending, then by codepoint for stability
  allEdges.sort((a, b) => b.danger - a.danger || a.sourceCodepoint.localeCompare(b.sourceCodepoint));

  // 5. Output
  console.log('\n[5/5] Writing output...');

  // 5a. Full JSONL (all pairs, gitignored)
  const jsonlStream = fs.createWriteStream(OUTPUT_JSONL);
  for (const edge of allEdges) {
    jsonlStream.write(JSON.stringify(edge) + '\n');
  }
  jsonlStream.end();
  console.log(`  Full JSONL: ${OUTPUT_JSONL} (${allEdges.length.toLocaleString()} pairs)`);

  // 5b. Committed JSON (pairs below threshold)
  const filteredEdges = allEdges.filter(e => (e.rayMean ?? 0) < threshold);
  const tr39Count = filteredEdges.filter(e => e.inTr39).length;

  const output: ConfusableWeightsOutput = {
    meta: {
      generatedAt: new Date().toISOString(),
      pairCount: filteredEdges.length,
      fontSetId: FONT_SET_ID,
      licence: 'CC-BY-4.0',
      attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
      scorer: 'rayspace',
      fontCount: 245,
      tiers: tierCounts,
    },
    edges: filteredEdges,
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
  const fileSize = fs.statSync(OUTPUT_JSON).size;
  console.log(`  Committed JSON: ${OUTPUT_JSON} (${filteredEdges.length.toLocaleString()} pairs, ${(fileSize / 1024).toFixed(0)} KB)`);

  // Summary
  console.log(`\n=== Weight Summary ===`);
  console.log(`  Total unique pairs: ${allEdges.length.toLocaleString()}`);
  console.log(`  Committed (threshold < ${threshold}): ${filteredEdges.length.toLocaleString()}`);
  console.log(`  TR39 pairs in committed: ${tr39Count}`);
  console.log(`\n  Tier distribution (all pairs):`);
  console.log(`    Strict (< 0.50):      ${tierCounts.strict.toLocaleString()}`);
  console.log(`    Standard (< 1.00):    ${tierCounts.standard.toLocaleString()}`);
  console.log(`    Exploratory (< 2.00): ${tierCounts.exploratory.toLocaleString()}`);

  // Cost distribution
  const costs = filteredEdges.map(e => e.cost);
  costs.sort((a, b) => a - b);
  const zeroCost = filteredEdges.filter(e => e.cost === 0);
  const lowCost = filteredEdges.filter(e => e.cost > 0 && e.cost < 0.1);
  const midCost = filteredEdges.filter(e => e.cost >= 0.1 && e.cost < 0.3);
  const highCost = filteredEdges.filter(e => e.cost >= 0.3);

  console.log(`\n  Cost distribution (committed):`);
  console.log(`    cost = 0:       ${zeroCost.length}  (identical in p95)`);
  console.log(`    0 < cost < 0.1: ${lowCost.length}  (near-identical)`);
  console.log(`    0.1 <= cost < 0.3: ${midCost.length}  (moderate risk)`);
  console.log(`    cost >= 0.3:    ${highCost.length}  (lower risk)`);

  // Property breakdown
  const xidPairs = filteredEdges.filter(e => e.xidContinue);
  const idnaPairs = filteredEdges.filter(e => e.idnaPvalid);
  const allowedPairs = filteredEdges.filter(e => e.tr39Allowed);

  console.log(`\n  Properties (committed):`);
  console.log(`    XID_Continue: ${xidPairs.length}`);
  console.log(`    IDNA PVALID:  ${idnaPairs.length}`);
  console.log(`    TR39 Allowed: ${allowedPairs.length}`);
  console.log(`    In TR39:      ${tr39Count}`);

  // Top 10 most dangerous
  console.log(`\n  Top 10 by danger:`);
  for (const e of filteredEdges.slice(0, 10)) {
    console.log(`    ${e.sourceCodepoint} ${e.source} -> ${e.target}  danger=${e.danger}  rayMean=${e.rayMean}  fonts=${e.sameN}  zeros=${e.zeroCount}  tier=${e.tier}`);
  }

  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
