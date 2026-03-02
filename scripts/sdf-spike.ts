/**
 * sdf-spike.ts -- Phase 2 validation
 *
 * Tests the SDF engine against known pairs and compares with SSIM ground truth.
 * Validates that SDF distance inversely correlates with SSIM, and that baseline
 * alignment is consistent across comparisons.
 *
 * Pass criteria:
 * - SDF distance inversely correlates with SSIM for known pairs
 * - Both SDFs in each comparison have baseline at the same grid row
 * - Dotless i/i SDF falls between raycasting (high) and SSIM (low)
 *
 * Usage: npx tsx scripts/sdf-spike.ts
 */

import fs from 'node:fs';
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
import { renderCharacter } from '../src/renderer.js';
import { normaliseImage } from '../src/normalise-image.js';
import { compareImages } from '../src/compare.js';
import { initFonts } from '../src/fonts.js';

const GRID_SIZE = 128;
const ARIAL_PATH = '/System/Library/Fonts/Supplemental/Arial.ttf';

interface TestPair {
  label: string;
  charA: string;
  codeA: number;
  charB: string;
  codeB: number;
}

const TEST_PAIRS: TestPair[] = [
  {
    label: 'Cyrillic a vs Latin a (confusable)',
    charA: '\u0430', codeA: 0x0430,
    charB: 'a', codeB: 0x0061,
  },
  {
    label: 'Latin a vs Latin z (non-confusable)',
    charA: 'a', codeA: 0x0061,
    charB: 'z', codeB: 0x007A,
  },
  {
    label: 'Cyrillic i (U+0456) vs Latin i (dot topology)',
    charA: '\u0456', codeA: 0x0456,
    charB: 'i', codeB: 0x0069,
  },
  {
    label: 'Latin O vs digit 0 (confusable)',
    charA: 'O', codeA: 0x004F,
    charB: '0', codeB: 0x0030,
  },
  {
    label: 'Latin l vs digit 1 (confusable)',
    charA: 'l', codeA: 0x006C,
    charB: '1', codeB: 0x0031,
  },
];

async function main(): Promise<void> {
  console.log('=== SDF Spike (Phase 2) ===\n');

  // Initialise fonts for SSIM rendering
  console.log('[1/3] Initialising fonts...\n');
  initFonts();

  const font = loadFont(ARIAL_PATH);
  if (!font) {
    console.error('Failed to load Arial. Check path:', ARIAL_PATH);
    process.exit(1);
  }

  const metrics = getFontMetrics(font);
  const baselineRow = getBaselineRow(metrics, GRID_SIZE);
  console.log(`Font: Arial (unitsPerEm=${metrics.unitsPerEm}, baselineRow=${baselineRow})\n`);

  // --- Compute all metrics ---
  console.log('[2/3] Computing metrics for test pairs...\n');

  interface PairResult {
    label: string;
    rayDistance: number | null;
    sdfL2: number | null;
    sdfNCC: number | null;
    ssim: number | null;
    baselineA: number;
    baselineB: number;
    sdfTimeMs: number;
  }

  const results: PairResult[] = [];

  for (const pair of TEST_PAIRS) {
    const pathA = extractGlyphPath(font, pair.codeA);
    const pathB = extractGlyphPath(font, pair.codeB);

    if (!pathA || !pathB) {
      console.log(`  ${pair.label}: SKIP (missing glyph)`);
      results.push({
        label: pair.label,
        rayDistance: null, sdfL2: null, sdfNCC: null, ssim: null,
        baselineA: baselineRow, baselineB: baselineRow, sdfTimeMs: 0,
      });
      continue;
    }

    const gridA = normalizeToGrid(pathA, metrics, GRID_SIZE);
    const gridB = normalizeToGrid(pathB, metrics, GRID_SIZE);

    // Raycasting
    const sigA = computeSignature(gridA);
    const sigB = computeSignature(gridB);
    const rayDistance = compareSignatures(sigA, sigB);

    // SDF
    const t0 = performance.now();
    const sdfA = computeSDF(gridA, GRID_SIZE, GRID_SIZE, baselineRow);
    const sdfB = computeSDF(gridB, GRID_SIZE, GRID_SIZE, baselineRow);
    const sdfTimeMs = performance.now() - t0;

    // Baseline alignment assertion
    if (sdfA.baselineRow !== sdfB.baselineRow) {
      console.error(`  BASELINE MISMATCH: ${pair.label} (${sdfA.baselineRow} vs ${sdfB.baselineRow})`);
      console.error('  SDF comparison is INVALID. Aborting.');
      process.exit(1);
    }

    const sdfResult = compareSDF(sdfA, sdfB);

    // SSIM via existing pipeline
    let ssimScore: number | null = null;
    const renderA = renderCharacter(pair.charA, 'Arial');
    const renderB = renderCharacter(pair.charB, 'Arial');
    if (renderA && renderB) {
      const normA = await normaliseImage(renderA.pngBuffer);
      const normB = await normaliseImage(renderB.pngBuffer);
      const comparison = await compareImages(normA, normB);
      ssimScore = comparison?.ssim ?? null;
    }

    results.push({
      label: pair.label,
      rayDistance,
      sdfL2: sdfResult.l2,
      sdfNCC: sdfResult.ncc,
      ssim: ssimScore,
      baselineA: sdfA.baselineRow,
      baselineB: sdfB.baselineRow,
      sdfTimeMs,
    });

    console.log(`  ${pair.label}`);
    console.log(`    Segments: ${pathA.segments.length} vs ${pathB.segments.length}`);
  }

  // --- Results table ---
  console.log('\n[3/3] Results\n');

  // Header
  const hdr = [
    'Pair'.padEnd(48),
    'Ray Dist'.padStart(10),
    'SDF L2'.padStart(10),
    'SDF NCC'.padStart(10),
    'SSIM'.padStart(10),
    'SDF ms'.padStart(10),
  ];
  console.log(hdr.join(' | '));
  console.log('-'.repeat(hdr.join(' | ').length));

  for (const r of results) {
    const row = [
      r.label.padEnd(48),
      r.rayDistance !== null ? r.rayDistance.toFixed(4).padStart(10) : 'N/A'.padStart(10),
      r.sdfL2 !== null ? r.sdfL2.toFixed(4).padStart(10) : 'N/A'.padStart(10),
      r.sdfNCC !== null ? r.sdfNCC.toFixed(4).padStart(10) : 'N/A'.padStart(10),
      r.ssim !== null ? r.ssim.toFixed(4).padStart(10) : 'N/A'.padStart(10),
      r.sdfTimeMs.toFixed(0).padStart(10),
    ];
    console.log(row.join(' | '));
  }

  // --- Baseline alignment check ---
  console.log('\n--- Baseline Alignment ---\n');
  const allAligned = results.every(r => r.baselineA === r.baselineB);
  console.log(`  All baselines aligned: ${allAligned ? 'PASS' : 'FAIL'}`);
  console.log(`  Baseline row: ${baselineRow}`);

  // --- Correlation analysis ---
  console.log('\n--- Correlation Analysis ---\n');

  const validResults = results.filter(r =>
    r.sdfL2 !== null && r.ssim !== null,
  );

  let corr: number | null = null;
  if (validResults.length >= 3) {
    const ssimValues = validResults.map(r => r.ssim!);
    const sdfL2Values = validResults.map(r => r.sdfL2!);

    corr = pearsonCorrelation(ssimValues, sdfL2Values);
    console.log(`  SSIM vs SDF L2 correlation: ${corr.toFixed(4)}`);
    console.log(`  Expected: negative (higher SSIM = lower SDF distance)`);
    console.log(`  Result: ${corr < -0.3 ? 'PASS' : 'WEAK/FAIL'} (threshold: r < -0.3)`);
  } else {
    console.log('  Insufficient valid results for correlation');
  }

  // --- Dot topology analysis ---
  console.log('\n--- Dot Topology (i vs i) ---\n');
  const iResult = results.find(r => r.label.includes('dot topology'));
  const aResult = results.find(r => r.label.includes('Cyrillic a'));
  if (iResult && aResult && iResult.sdfL2 !== null && aResult.sdfL2 !== null) {
    console.log(`  Cyrillic a vs Latin a -- SDF L2: ${aResult.sdfL2.toFixed(4)}, SSIM: ${aResult.ssim?.toFixed(4) ?? 'N/A'}`);
    console.log(`  Cyrillic i vs Latin i -- SDF L2: ${iResult.sdfL2.toFixed(4)}, SSIM: ${iResult.ssim?.toFixed(4) ?? 'N/A'}`);
    console.log(`  (If both are identical glyphs in Arial, SDF L2 should be ~0 for both)`);
  }

  // --- Persist results ---
  const ROOT = path.resolve(import.meta.dirname, '..');
  const OUTPUT_PATH = path.join(ROOT, 'data/output/sdf-spike.json');

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      font: 'Arial',
      gridSize: GRID_SIZE,
      baselineRow,
      platform: `${process.platform} ${process.arch}`,
    },
    pairs: results.map(r => ({
      label: r.label,
      rayDistance: r.rayDistance,
      sdfL2: r.sdfL2,
      sdfNCC: r.sdfNCC,
      ssim: r.ssim,
      sdfTimeMs: r.sdfTimeMs,
    })),
    validation: {
      baselinesAligned: allAligned,
      ssimVsSdfL2Correlation: corr,
      correlationPass: corr !== null ? corr < -0.3 : null,
    },
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n  Written: ${OUTPUT_PATH}`);
  console.log('\nDone.');
}

/**
 * Pearson correlation coefficient between two arrays.
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]!;
    sumY += y[i]!;
    sumXY += x[i]! * y[i]!;
    sumX2 += x[i]! * x[i]!;
    sumY2 += y[i]! * y[i]!;
  }

  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  return den < 1e-10 ? 0 : num / den;
}

main();
