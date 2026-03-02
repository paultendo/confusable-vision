/**
 * validate-raycast-sdf.ts -- Phase 3: full validation
 *
 * Loads scored pairs from confusable-scores.json.gz, computes ray signatures
 * and SDF distances for each pair in Arial, and outputs a validation JSON
 * with per-pair SSIM, ray_distance, sdf_distance.
 *
 * confusable-scores.json.gz provides test pairs and SSIM ground truth.
 * The geometric metrics (ray, SDF) are computed independently -- this script
 * measures how they correlate with SSIM, not whether they agree with
 * confusables.txt.
 *
 * Performance: caches per-codepoint SDF, grid segments, and ray signatures
 * so that each unique codepoint is computed at most once. Glyph ID matching
 * short-circuits identical-glyph pairs to distance 0.
 *
 * Summary includes: SDF vs SSIM correlation, ray distance separation at
 * extremes, and disagreement pairs.
 *
 * Usage: npx tsx scripts/validate-raycast-sdf.ts
 */

import fs from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import {
  loadFont,
  extractGlyphPath,
  getFontMetrics,
  normalizeToGrid,
  getBaselineRow,
} from '../src/glyph-path.js';
import { computeSignature, compareSignatures } from '../src/raycasting.js';
import { computeSDF, compareSDF } from '../src/sdf.js';
import type { PathSegment, TopologicalSignature, SDFGrid } from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCORES_PATH = path.join(ROOT, 'data/output/confusable-scores.json.gz');
const OUTPUT_PATH = path.join(ROOT, 'data/output/raycast-sdf-validation.json');

const GRID_SIZE = 128;
const ARIAL_PATH = '/System/Library/Fonts/Supplemental/Arial.ttf';

interface ScoredPair {
  source: string;
  sourceCodepoint: string;
  target: string;
  summary: { meanSsim: number | null };
}

interface ValidationEntry {
  source: string;
  sourceCodepoint: string;
  target: string;
  ssim: number | null;
  rayDistance: number | null;
  sdfL2: number | null;
  sdfNCC: number | null;
  glyphIdMatch: boolean;
}

/** Cached per-codepoint computation results for a given font */
interface CodepointCache {
  glyphId: number;
  grid: PathSegment[];
  sig: TopologicalSignature;
  sdf: SDFGrid;
}

async function loadScores(): Promise<ScoredPair[]> {
  if (!fs.existsSync(SCORES_PATH)) {
    // Try uncompressed version
    const uncompressed = SCORES_PATH.replace('.gz', '');
    if (fs.existsSync(uncompressed)) {
      const raw = fs.readFileSync(uncompressed, 'utf-8');
      const data = JSON.parse(raw);
      return data.pairs ?? [];
    }
    console.error(`Scores file not found: ${SCORES_PATH}`);
    console.error('Run score-all-pairs first: npm run score-all-pairs');
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    const stream = createReadStream(SCORES_PATH).pipe(createGunzip());
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      const data = JSON.parse(raw);
      resolve(data.pairs ?? []);
    });
    stream.on('error', reject);
  });
}

async function main(): Promise<void> {
  console.log('=== Validate Raycast + SDF (Phase 3) ===\n');

  const font = loadFont(ARIAL_PATH);
  if (!font) {
    console.error('Failed to load Arial');
    process.exit(1);
  }

  const metrics = getFontMetrics(font);
  const baselineRow = getBaselineRow(metrics, GRID_SIZE);

  console.log('[1/3] Loading scored pairs...');
  const pairs = await loadScores();
  console.log(`  ${pairs.length} pairs loaded\n`);

  console.log('[2/3] Computing ray + SDF metrics...\n');

  // Per-codepoint cache: keyed by codepoint integer.
  // Each unique codepoint's path extraction, grid normalisation,
  // ray signature, and SDF are computed exactly once.
  const cpCache = new Map<number, CodepointCache | null>();

  function getOrCompute(codepoint: number): CodepointCache | null {
    if (cpCache.has(codepoint)) return cpCache.get(codepoint)!;

    const glyphPath = extractGlyphPath(font!, codepoint);
    if (!glyphPath) {
      cpCache.set(codepoint, null);
      return null;
    }

    const glyph = font!.glyphForCodePoint(codepoint);
    const grid = normalizeToGrid(glyphPath, metrics, GRID_SIZE);
    const sig = computeSignature(grid);
    const sdf = computeSDF(grid, GRID_SIZE, GRID_SIZE, baselineRow);

    const entry: CodepointCache = { glyphId: glyph.id, grid, sig, sdf };
    cpCache.set(codepoint, entry);
    return entry;
  }

  const results: ValidationEntry[] = [];
  let processed = 0;
  let skipped = 0;
  let glyphIdMatches = 0;

  const t0 = performance.now();

  for (const pair of pairs) {
    const sourceCode = parseInt(pair.sourceCodepoint.replace('U+', ''), 16);
    const targetCode = pair.target.codePointAt(0);
    if (!targetCode) { skipped++; continue; }

    const sourceData = getOrCompute(sourceCode);
    const targetData = getOrCompute(targetCode);

    if (!sourceData || !targetData) {
      results.push({
        source: pair.source,
        sourceCodepoint: pair.sourceCodepoint,
        target: pair.target,
        ssim: pair.summary.meanSsim,
        rayDistance: null,
        sdfL2: null,
        sdfNCC: null,
        glyphIdMatch: false,
      });
      skipped++;
      continue;
    }

    // Glyph ID short-circuit: if both codepoints map to the same
    // non-.notdef glyph in this font, the outlines are literally
    // the same data. Distance is 0 by definition.
    const glyphIdMatch = sourceData.glyphId === targetData.glyphId;
    if (glyphIdMatch) glyphIdMatches++;

    const rayDistance = glyphIdMatch ? 0 : compareSignatures(sourceData.sig, targetData.sig);
    const sdfResult = glyphIdMatch
      ? { l2: 0, ncc: 1 }
      : compareSDF(sourceData.sdf, targetData.sdf);

    results.push({
      source: pair.source,
      sourceCodepoint: pair.sourceCodepoint,
      target: pair.target,
      ssim: pair.summary.meanSsim,
      rayDistance,
      sdfL2: sdfResult.l2,
      sdfNCC: sdfResult.ncc,
      glyphIdMatch,
    });

    processed++;
    if (processed % 200 === 0) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      console.log(`  ${processed} processed, ${skipped} skipped (${elapsed}s, ${cpCache.size} codepoints cached)`);
    }
  }

  const totalTime = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`  Total: ${processed} processed, ${skipped} skipped in ${totalTime}s`);
  console.log(`  Unique codepoints computed: ${cpCache.size}`);
  console.log(`  Glyph ID matches (short-circuited): ${glyphIdMatches}\n`);

  // --- Correlation analysis ---
  console.log('[3/3] Analysis\n');

  const valid = results.filter(r =>
    r.ssim !== null && r.sdfL2 !== null && r.rayDistance !== null,
  );

  if (valid.length >= 10) {
    const ssimVals = valid.map(r => r.ssim!);
    const sdfL2Vals = valid.map(r => r.sdfL2!);
    const rayVals = valid.map(r => r.rayDistance!);

    const corrSdfSsim = pearsonCorrelation(ssimVals, sdfL2Vals);
    const corrRaySsim = pearsonCorrelation(ssimVals, rayVals);

    console.log(`  SSIM vs SDF L2 correlation:       ${corrSdfSsim.toFixed(4)}`);
    console.log(`  SSIM vs Ray distance correlation:  ${corrRaySsim.toFixed(4)}`);

    // Separation at extremes
    const highSsim = valid.filter(r => r.ssim! >= 0.8);
    const lowSsim = valid.filter(r => r.ssim! <= 0.2);

    if (highSsim.length > 0 && lowSsim.length > 0) {
      const avgRayHigh = mean(highSsim.map(r => r.rayDistance!));
      const avgRayLow = mean(lowSsim.map(r => r.rayDistance!));
      const avgSdfHigh = mean(highSsim.map(r => r.sdfL2!));
      const avgSdfLow = mean(lowSsim.map(r => r.sdfL2!));

      console.log(`\n  High SSIM (>=0.8): ${highSsim.length} pairs`);
      console.log(`    Avg ray distance: ${avgRayHigh.toFixed(4)}`);
      console.log(`    Avg SDF L2:       ${avgSdfHigh.toFixed(4)}`);
      console.log(`  Low SSIM (<=0.2):  ${lowSsim.length} pairs`);
      console.log(`    Avg ray distance: ${avgRayLow.toFixed(4)}`);
      console.log(`    Avg SDF L2:       ${avgSdfLow.toFixed(4)}`);
    }

    // Disagreement pairs: SSIM says similar but SDF says different, or vice versa
    const medianSdf = median(sdfL2Vals);
    const medianSsim = median(ssimVals);

    // "Concordant" = both metrics agree on ranking direction
    // "Discordant" = metrics disagree (high SSIM + high SDF, or low SSIM + low SDF)
    const discordant = valid.filter(r =>
      (r.ssim! > medianSsim && r.sdfL2! > medianSdf) ||
      (r.ssim! < medianSsim && r.sdfL2! < medianSdf),
    );

    console.log(`\n  Discordant pairs (SSIM and SDF disagree): ${discordant.length}/${valid.length}`);
    if (discordant.length > 0) {
      // Show the most extreme discordances
      const sorted = [...discordant].sort((a, b) => {
        const scoreA = Math.abs((a.ssim! - medianSsim) / medianSsim) + Math.abs((a.sdfL2! - medianSdf) / medianSdf);
        const scoreB = Math.abs((b.ssim! - medianSsim) / medianSsim) + Math.abs((b.sdfL2! - medianSdf) / medianSdf);
        return scoreB - scoreA;
      });
      for (const d of sorted.slice(0, 15)) {
        console.log(`    ${d.sourceCodepoint} ${d.source} -> ${d.target}: SSIM=${d.ssim!.toFixed(3)}, SDF L2=${d.sdfL2!.toFixed(3)}, glyphMatch=${d.glyphIdMatch}`);
      }
    }
  } else {
    console.log('  Insufficient valid pairs for analysis');
  }

  // Write output
  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      font: 'Arial',
      gridSize: GRID_SIZE,
      totalPairs: results.length,
      validPairs: valid.length,
      uniqueCodepoints: cpCache.size,
      glyphIdMatches,
      computeTimeSeconds: parseFloat(totalTime),
    },
    pairs: results,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n  Written: ${OUTPUT_PATH}`);
  console.log('\nDone.');
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]!; sumY += y[i]!;
    sumXY += x[i]! * y[i]!;
    sumX2 += x[i]! * x[i]!; sumY2 += y[i]! * y[i]!;
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den < 1e-10 ? 0 : num / den;
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

main();
