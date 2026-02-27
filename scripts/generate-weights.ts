/**
 * generate-weights.ts -- Milestone 3 + 5
 *
 * Combines all milestone outputs into a single confusable-weights.json artifact
 * for integration with namespace-guard's risk scoring.
 *
 * Inputs:
 *   - confusable-discoveries.json (110 TR39 high-risk pairs)
 *   - candidate-discoveries.json (793 novel pairs)
 *   - confusable-glyph-reuse.json + candidate-glyph-reuse.json (from Item 1)
 *   - candidate-discoveries-annotated.json (from Item 3)
 *   - confusable-discoveries-annotated.json (from Item 3)
 *   - cross-script-discoveries.json (M5 cross-script confusable pairs)
 *
 * Output: data/output/confusable-weights.json (~80-120 KB, committed to repo)
 *
 * Usage: npx tsx scripts/generate-weights.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  ConfusableEdgeWeight,
  ConfusableWeightsOutput,
  GlyphReuseSummary,
  IdentifierProperties,
} from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data/output');

const CONFUSABLE_PATH = path.join(DATA, 'confusable-discoveries.json');
const CANDIDATE_PATH = path.join(DATA, 'candidate-discoveries.json');
const CONFUSABLE_GLYPH_PATH = path.join(DATA, 'confusable-glyph-reuse.json');
const CANDIDATE_GLYPH_PATH = path.join(DATA, 'candidate-glyph-reuse.json');
const CONFUSABLE_ANNOTATED_PATH = path.join(DATA, 'confusable-discoveries-annotated.json');
const CANDIDATE_ANNOTATED_PATH = path.join(DATA, 'candidate-discoveries-annotated.json');
const CROSS_SCRIPT_PATH = path.join(DATA, 'cross-script-discoveries.json');
const OUTPUT_PATH = path.join(DATA, 'confusable-weights.json');

const FONT_SET_ID = 'macos-m1-system-230fonts';

interface DiscoveryPair {
  source: string;
  sourceCodepoint: string;
  target: string;
  fonts: Array<{
    sourceFont: string;
    targetFont: string;
    ssim: number | null;
    pHash: number | null;
    sourceRenderStatus: string;
    sourceFallbackFont: string | null;
    ssimSkipped: boolean;
  }>;
  summary: {
    meanSsim: number | null;
    meanPHash: number | null;
    nativeFontCount: number;
    fallbackFontCount: number;
    notdefFontCount: number;
    validFontCount: number;
  };
}

interface AnnotatedPair extends DiscoveryPair {
  properties: IdentifierProperties;
}

interface CrossScriptPair {
  charA: string;
  codepointA: string;
  scriptA: string;
  charB: string;
  codepointB: string;
  scriptB: string;
  summary: {
    meanSsim: number | null;
    meanPHash: number | null;
    nativeFontCount: number;
    fallbackFontCount: number;
    notdefFontCount: number;
    validFontCount: number;
  };
  bestFont: {
    sourceFont: string;
    targetFont: string;
    ssim: number;
    pHash: number;
  };
}

/**
 * Compute percentile from a sorted array of numbers.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (idx - lower);
}

/**
 * Compute edge weight for a single pair.
 */
function computeEdge(
  pair: DiscoveryPair,
  glyphReuse: boolean,
  properties: IdentifierProperties,
  inTr39: boolean,
): ConfusableEdgeWeight {
  // Separate same-font and cross-font comparisons
  const sameScores: number[] = [];
  const crossScores: number[] = [];

  for (const f of pair.fonts) {
    if (f.ssim === null) continue;
    if (f.sourceFont === f.targetFont) {
      sameScores.push(f.ssim);
    } else {
      crossScores.push(f.ssim);
    }
  }

  // Sort for percentile computation
  sameScores.sort((a, b) => a - b);
  crossScores.sort((a, b) => a - b);
  const allScores = [...sameScores, ...crossScores].sort((a, b) => a - b);

  const sameMax = sameScores.length > 0 ? sameScores[sameScores.length - 1]! : 0;
  const sameP95 = percentile(sameScores, 95);
  const sameMean = sameScores.length > 0
    ? sameScores.reduce((a, b) => a + b, 0) / sameScores.length
    : 0;

  const crossMax = crossScores.length > 0 ? crossScores[crossScores.length - 1]! : 0;
  const crossP95 = percentile(crossScores, 95);
  const crossMean = crossScores.length > 0
    ? crossScores.reduce((a, b) => a + b, 0) / crossScores.length
    : 0;

  const danger = Math.max(sameMax, crossMax);
  const stableDanger = percentile(allScores, 95);
  const cost = Math.max(0, Math.min(1, 1 - stableDanger));

  return {
    source: pair.source,
    sourceCodepoint: pair.sourceCodepoint,
    target: pair.target,
    sameMax: round(sameMax),
    sameP95: round(sameP95),
    sameMean: round(sameMean),
    sameN: sameScores.length,
    crossMax: round(crossMax),
    crossP95: round(crossP95),
    crossMean: round(crossMean),
    crossN: crossScores.length,
    danger: round(danger),
    stableDanger: round(stableDanger),
    cost: round(cost),
    glyphReuse,
    xidContinue: properties.xidContinue,
    xidStart: properties.xidStart,
    idnaPvalid: properties.idnaPvalid,
    tr39Allowed: properties.tr39Allowed,
    inTr39,
    fontSetId: FONT_SET_ID,
  };
}

/**
 * Compute edge weight for a cross-script pair (M5).
 * Cross-script pairs only have bestFont and summary (no full fonts array).
 * All comparisons are same-font, so mean approximates p95 for the 1-3 shared fonts.
 * Property flags are omitted: cross-script edges work with context "all"
 * but are filtered out by "identifier" or "domain".
 */
function computeCrossScriptEdge(pair: CrossScriptPair): ConfusableEdgeWeight {
  const danger = round(pair.bestFont.ssim);
  const stableDanger = round(pair.summary.meanSsim ?? pair.bestFont.ssim);
  const cost = round(Math.max(0, Math.min(1, 1 - stableDanger)));

  return {
    source: pair.charA,
    sourceCodepoint: pair.codepointA,
    target: pair.charB,
    sameMax: danger,
    sameP95: stableDanger,
    sameMean: stableDanger,
    sameN: pair.summary.validFontCount,
    crossMax: 0,
    crossP95: 0,
    crossMean: 0,
    crossN: 0,
    danger,
    stableDanger,
    cost,
    glyphReuse: false,
    xidContinue: false,
    xidStart: false,
    idnaPvalid: false,
    tr39Allowed: false,
    inTr39: false,
    fontSetId: FONT_SET_ID,
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function main() {
  console.log('generate-weights: loading inputs...\n');

  // Load discovery pairs
  const confusable = JSON.parse(fs.readFileSync(CONFUSABLE_PATH, 'utf-8'));
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE_PATH, 'utf-8'));

  // Load glyph reuse results
  const confusableGlyph: GlyphReuseSummary[] = JSON.parse(
    fs.readFileSync(CONFUSABLE_GLYPH_PATH, 'utf-8')
  );
  const candidateGlyph: GlyphReuseSummary[] = JSON.parse(
    fs.readFileSync(CANDIDATE_GLYPH_PATH, 'utf-8')
  );

  // Load annotated properties
  const confusableAnnotated = JSON.parse(
    fs.readFileSync(CONFUSABLE_ANNOTATED_PATH, 'utf-8')
  );
  const candidateAnnotated = JSON.parse(
    fs.readFileSync(CANDIDATE_ANNOTATED_PATH, 'utf-8')
  );

  // Load cross-script discoveries (M5)
  const crossScript = JSON.parse(fs.readFileSync(CROSS_SCRIPT_PATH, 'utf-8'));

  console.log(`  TR39 pairs:       ${confusable.pairs.length}`);
  console.log(`  Novel pairs:      ${candidate.pairs.length}`);
  console.log(`  Cross-script raw: ${crossScript.pairs.length}`);

  // Build glyph-reuse lookup by sourceCodepoint
  const glyphLookup = new Map<string, boolean>();
  for (const g of confusableGlyph) {
    glyphLookup.set(`${g.sourceCodepoint}:${g.target}`, g.glyphReuse);
  }
  for (const g of candidateGlyph) {
    glyphLookup.set(`${g.sourceCodepoint}:${g.target}`, g.glyphReuse);
  }

  // Build property lookup by sourceCodepoint
  const propLookup = new Map<string, IdentifierProperties>();
  for (const p of confusableAnnotated.pairs) {
    propLookup.set(`${p.sourceCodepoint}:${p.target}`, p.properties);
  }
  for (const p of candidateAnnotated.pairs) {
    propLookup.set(`${p.sourceCodepoint}:${p.target}`, p.properties);
  }

  // Compute edges
  const edges: ConfusableEdgeWeight[] = [];

  // TR39 pairs
  for (const pair of confusable.pairs as DiscoveryPair[]) {
    const key = `${pair.sourceCodepoint}:${pair.target}`;
    const glyphReuse = glyphLookup.get(key) ?? false;
    const properties = propLookup.get(key) ?? {
      xidStart: false, xidContinue: false, idnaPvalid: false, tr39Allowed: false,
    };
    edges.push(computeEdge(pair, glyphReuse, properties, true));
  }

  // Novel pairs
  for (const pair of candidate.pairs as DiscoveryPair[]) {
    const key = `${pair.sourceCodepoint}:${pair.target}`;
    const glyphReuse = glyphLookup.get(key) ?? false;
    const properties = propLookup.get(key) ?? {
      xidStart: false, xidContinue: false, idnaPvalid: false, tr39Allowed: false,
    };
    edges.push(computeEdge(pair, glyphReuse, properties, false));
  }

  // Cross-script pairs (M5) -- deduplicate against TR39/novel pairs
  const existingPairKeys = new Set<string>();
  for (const edge of edges) {
    existingPairKeys.add(`${edge.source}:${edge.target}`);
    existingPairKeys.add(`${edge.target}:${edge.source}`);
  }

  let crossScriptAdded = 0;
  for (const pair of crossScript.pairs as CrossScriptPair[]) {
    const k1 = `${pair.charA}:${pair.charB}`;
    const k2 = `${pair.charB}:${pair.charA}`;
    if (existingPairKeys.has(k1) || existingPairKeys.has(k2)) continue;
    edges.push(computeCrossScriptEdge(pair));
    existingPairKeys.add(k1);
    existingPairKeys.add(k2);
    crossScriptAdded++;
  }
  console.log(`  Cross-script new: ${crossScriptAdded} (${crossScript.pairs.length - crossScriptAdded} deduplicated)`);

  // Sort by danger descending
  edges.sort((a, b) => b.danger - a.danger || a.sourceCodepoint.localeCompare(b.sourceCodepoint));

  const output: ConfusableWeightsOutput = {
    meta: {
      generatedAt: new Date().toISOString(),
      pairCount: edges.length,
      tr39PairCount: confusable.pairs.length,
      novelPairCount: candidate.pairs.length,
      crossScriptPairCount: crossScriptAdded,
      fontSetId: FONT_SET_ID,
      licence: 'CC-BY-4.0',
      attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
    },
    edges,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  // Summary stats
  const tr39Edges = edges.filter(e => e.inTr39);

  const costs = edges.map(e => e.cost);
  costs.sort((a, b) => a - b);

  const zeroCost = edges.filter(e => e.cost === 0);
  const lowCost = edges.filter(e => e.cost > 0 && e.cost < 0.1);
  const midCost = edges.filter(e => e.cost >= 0.1 && e.cost < 0.3);
  const highCost = edges.filter(e => e.cost >= 0.3);

  console.log(`\n=== Weight Summary ===`);
  console.log(`  Total edges:  ${edges.length}`);
  console.log(`  TR39:         ${tr39Edges.length}`);
  console.log(`  Novel:        ${candidate.pairs.length}`);
  console.log(`  Cross-script: ${crossScriptAdded}`);
  console.log(`\n  Cost distribution:`);
  console.log(`    cost = 0:       ${zeroCost.length}  (pixel-identical in p95)`);
  console.log(`    0 < cost < 0.1: ${lowCost.length}  (near-identical)`);
  console.log(`    0.1 <= cost < 0.3: ${midCost.length}  (moderate risk)`);
  console.log(`    cost >= 0.3:    ${highCost.length}  (lower risk)`);
  console.log(`\n  Cost range: ${costs[0]} to ${costs[costs.length - 1]}`);

  const glyphReusePairs = edges.filter(e => e.glyphReuse);
  const xidPairs = edges.filter(e => e.xidContinue);
  const idnaPairs = edges.filter(e => e.idnaPvalid);

  console.log(`\n  Glyph reuse: ${glyphReusePairs.length}`);
  console.log(`  XID_Continue: ${xidPairs.length}`);
  console.log(`  IDNA PVALID: ${idnaPairs.length}`);

  // Top 10 most dangerous
  console.log(`\n  Top 10 by danger:`);
  for (const e of edges.slice(0, 10)) {
    console.log(`    ${e.sourceCodepoint} ${e.source} -> ${e.target}  danger=${e.danger}  cost=${e.cost}  tr39=${e.inTr39}`);
  }

  const fileSize = fs.statSync(OUTPUT_PATH).size;
  console.log(`\nWritten: ${OUTPUT_PATH} (${(fileSize / 1024).toFixed(0)} KB)`);
}

main();
