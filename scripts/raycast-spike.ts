/**
 * raycast-spike.ts -- Phase 1 validation
 *
 * Tests the raycasting engine against known confusable and non-confusable pairs.
 * Validates that ray signature distance separates confusable from non-confusable pairs,
 * and that topological differences (e.g. dotted vs dotless i) show up in intersection counts.
 *
 * Pass criteria:
 * - Confusable distance < non-confusable distance
 * - Vertical rays through i (U+0456) vs i (U+0069) show different intersection counts
 *
 * Usage: npx tsx scripts/raycast-spike.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  loadFont,
  extractGlyphPath,
  getFontMetrics,
  normalizeToGrid,
} from '../src/glyph-path.js';
import { computeSignature, compareSignatures } from '../src/raycasting.js';

const GRID_SIZE = 128;

// Arial path on macOS
const ARIAL_PATH = '/System/Library/Fonts/Supplemental/Arial.ttf';

interface TestPair {
  label: string;
  charA: string;
  codeA: number;
  charB: string;
  codeB: number;
  expectConfusable: boolean;
}

const TEST_PAIRS: TestPair[] = [
  {
    label: 'Cyrillic a vs Latin a (confusable)',
    charA: '\u0430', codeA: 0x0430,
    charB: 'a', codeB: 0x0061,
    expectConfusable: true,
  },
  {
    label: 'Latin a vs Latin z (non-confusable)',
    charA: 'a', codeA: 0x0061,
    charB: 'z', codeB: 0x007A,
    expectConfusable: false,
  },
  {
    label: 'Cyrillic i (U+0456) vs Latin i (dot topology)',
    charA: '\u0456', codeA: 0x0456,
    charB: 'i', codeB: 0x0069,
    expectConfusable: true, // Visually similar but may differ in topology
  },
];

// Benchmark glyph: Han U+4E28 (complex outline)
const BENCHMARK_CODE = 0x4E28;

function main(): void {
  console.log('=== Raycasting Spike (Phase 1) ===\n');

  const font = loadFont(ARIAL_PATH);
  if (!font) {
    console.error('Failed to load Arial. Check path:', ARIAL_PATH);
    process.exit(1);
  }

  const metrics = getFontMetrics(font);
  console.log(`Font: Arial (unitsPerEm=${metrics.unitsPerEm}, ascender=${metrics.ascender}, descender=${metrics.descender})\n`);

  // --- Test pairs ---
  console.log('--- Pair Comparisons ---\n');
  const results: Array<{ label: string; distance: number; expectConfusable: boolean }> = [];

  for (const pair of TEST_PAIRS) {
    const pathA = extractGlyphPath(font, pair.codeA);
    const pathB = extractGlyphPath(font, pair.codeB);

    if (!pathA) {
      console.log(`  ${pair.label}: SKIP (${pair.charA} has no glyph)`);
      continue;
    }
    if (!pathB) {
      console.log(`  ${pair.label}: SKIP (${pair.charB} has no glyph)`);
      continue;
    }

    const gridA = normalizeToGrid(pathA, metrics, GRID_SIZE);
    const gridB = normalizeToGrid(pathB, metrics, GRID_SIZE);

    const t0 = performance.now();
    const sigA = computeSignature(gridA);
    const sigB = computeSignature(gridB);
    const distance = compareSignatures(sigA, sigB);
    const elapsed = performance.now() - t0;

    results.push({ label: pair.label, distance, expectConfusable: pair.expectConfusable });

    console.log(`  ${pair.label}`);
    console.log(`    Segments: ${pathA.segments.length} vs ${pathB.segments.length}`);
    console.log(`    Distance: ${distance.toFixed(6)}`);
    console.log(`    Time: ${elapsed.toFixed(1)}ms`);

    // Print intersection histogram summaries
    console.log(`    Histogram A: ${formatHistogram(sigA.intersectionHistogram)}`);
    console.log(`    Histogram B: ${formatHistogram(sigB.intersectionHistogram)}`);
    console.log('');
  }

  // --- Dot topology test (i vs i) ---
  console.log('--- Dot Topology Test ---\n');
  const iCyrillic = extractGlyphPath(font, 0x0456);
  const iLatin = extractGlyphPath(font, 0x0069);

  if (iCyrillic && iLatin) {
    const gridCyrillic = normalizeToGrid(iCyrillic, metrics, GRID_SIZE);
    const gridLatin = normalizeToGrid(iLatin, metrics, GRID_SIZE);

    const sigCyrillic = computeSignature(gridCyrillic);
    const sigLatin = computeSignature(gridLatin);

    // Check vertical rays (angle ~PI/2) for intersection count difference
    // At angle index = numAngles/2 (= 18 for 36 angles), we get vertical rays
    const verticalIdx = Math.floor(sigCyrillic.angles.length / 2);
    const vertRaysCyrillic = sigCyrillic.angles[verticalIdx]!;
    const vertRaysLatin = sigLatin.angles[verticalIdx]!;

    // Count rays that hit 2 or more intersections (indicates dot above stem)
    const multiHitCyrillic = vertRaysCyrillic.rays.filter(r => r.intersectionCount >= 4).length;
    const multiHitLatin = vertRaysLatin.rays.filter(r => r.intersectionCount >= 4).length;

    console.log(`  Cyrillic i (U+0456) vertical rays with >=4 intersections: ${multiHitCyrillic}`);
    console.log(`  Latin i (U+0069) vertical rays with >=4 intersections: ${multiHitLatin}`);
    console.log(`  (Both should show dot-through-stem rays with high counts if dotted)`);

    // Check if histograms differ
    const histDiff = histogramsDiffer(sigCyrillic.intersectionHistogram, sigLatin.intersectionHistogram);
    console.log(`  Histogram difference detected: ${histDiff ? 'YES' : 'NO'}`);
    console.log('');
  } else {
    console.log('  SKIP: could not extract both i glyphs\n');
  }

  // --- Benchmark: Han U+4E28 ---
  console.log('--- Benchmark: Han U+4E28 ---\n');
  // Try multiple font paths for Han character
  const hanFontPaths = [
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    ARIAL_PATH,
  ];

  let hanTiming: number | null = null;
  for (const fp of hanFontPaths) {
    const hanFont = loadFont(fp);
    if (!hanFont) continue;

    const hanPath = extractGlyphPath(hanFont, BENCHMARK_CODE);
    if (!hanPath) continue;

    const hanMetrics = getFontMetrics(hanFont);
    const hanGrid = normalizeToGrid(hanPath, hanMetrics, GRID_SIZE);

    const t0 = performance.now();
    computeSignature(hanGrid);
    hanTiming = performance.now() - t0;

    console.log(`  Font: ${path.basename(fp)}`);
    console.log(`  Segments: ${hanPath.segments.length}`);
    console.log(`  Signature time: ${hanTiming.toFixed(1)}ms`);
    break;
  }
  if (hanTiming === null) {
    console.log('  SKIP: no font found with Han U+4E28');
  }
  console.log('');

  // --- Validation summary ---
  console.log('=== Validation Summary ===\n');

  const confusable = results.filter(r => r.expectConfusable);
  const nonConfusable = results.filter(r => !r.expectConfusable);

  if (confusable.length > 0 && nonConfusable.length > 0) {
    const maxConfusableDist = Math.max(...confusable.map(r => r.distance));
    const minNonConfusableDist = Math.min(...nonConfusable.map(r => r.distance));

    const separated = maxConfusableDist < minNonConfusableDist;
    console.log(`  Max confusable distance:     ${maxConfusableDist.toFixed(6)}`);
    console.log(`  Min non-confusable distance:  ${minNonConfusableDist.toFixed(6)}`);
    console.log(`  Separation: ${separated ? 'PASS' : 'FAIL'} (confusable < non-confusable)`);
  } else {
    console.log('  Insufficient data for separation test');
  }

  if (hanTiming !== null) {
    const needsAcceleration = hanTiming > 100;
    console.log(`  Han benchmark: ${hanTiming.toFixed(1)}ms ${needsAcceleration ? '(consider acceleration for Phase 3+)' : '(fast enough)'}`);
  }

  // --- Persist results ---
  const ROOT = path.resolve(import.meta.dirname, '..');
  const OUTPUT_PATH = path.join(ROOT, 'data/output/raycast-spike.json');

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      font: 'Arial',
      gridSize: GRID_SIZE,
      platform: `${process.platform} ${process.arch}`,
    },
    pairs: results.map(r => ({
      label: r.label,
      distance: r.distance,
      expectConfusable: r.expectConfusable,
    })),
    dotTopology: iCyrillic && iLatin ? {
      cyrillicSegments: iCyrillic.segments.length,
      latinSegments: iLatin.segments.length,
      histogramsDiffer: histogramsDiffer(
        computeSignature(normalizeToGrid(iCyrillic, metrics, GRID_SIZE)).intersectionHistogram,
        computeSignature(normalizeToGrid(iLatin, metrics, GRID_SIZE)).intersectionHistogram,
      ),
    } : null,
    hanBenchmarkMs: hanTiming,
    validation: {
      separationPass: confusable.length > 0 && nonConfusable.length > 0
        ? Math.max(...confusable.map(r => r.distance)) < Math.min(...nonConfusable.map(r => r.distance))
        : null,
    },
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n  Written: ${OUTPUT_PATH}`);
  console.log('\nDone.');
}

function formatHistogram(hist: Map<number, number>): string {
  const entries = [...hist.entries()].sort(([a], [b]) => a - b);
  return entries.map(([count, freq]) => `${count}:${freq}`).join(' ');
}

function histogramsDiffer(a: Map<number, number>, b: Map<number, number>): boolean {
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  for (const k of allKeys) {
    if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) return true;
  }
  return false;
}

main();
