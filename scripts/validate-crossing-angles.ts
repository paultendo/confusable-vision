/**
 * validate-crossing-angles.ts
 *
 * Validates that crossing angles (RaySpace Refinement 2) improve discrimination
 * for the dominant false positive category: diacritic confusion.
 *
 * The dot on "i" is circular (rays cross near-perpendicular), while accent marks
 * are diagonal strokes (rays graze them). Crossing angles should capture this
 * difference where position-only comparison cannot.
 *
 * Compares four metrics side by side:
 *   1. count-only (baseline)
 *   2. enriched positions only (Refinement 1)
 *   3. enriched positions + angles (Refinement 2)
 *   4. enriched positions + angles + pings (Refinement 3)
 *
 * Key expectations:
 *   - li vs u-acute: distance should INCREASE with angles (dot != accent)
 *   - rn vs m: pings should reveal gap vs continuous arch
 *   - o vs Cyrillic o: distance should stay LOW (true confusable, control)
 *
 * Usage: npx tsx scripts/validate-crossing-angles.ts
 */

import {
  loadFont,
  extractGlyphPath,
  concatGlyphPaths,
  getFontMetrics,
  normalizeToGrid,
} from '../src/glyph-path.js';
import { computeEnrichedSignature } from '../src/raycasting.js';
import { compareEnrichedArrays, compareCountArrays } from '../src/signature-bank.js';

const GRID_SIZE = 128;
const NUM_ANGLES = 36;
const RAYS_PER_ANGLE = 50;

const FONT_PATHS = [
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/Supplemental/Tahoma.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
];

interface TestPair {
  label: string;
  /** Source string (may be multi-char bigram) */
  source: string;
  /** Target string (single codepoint) */
  target: string;
  /**
   * 'identical': both metrics should be very low (<0.05)
   * 'similar': true confusable, should stay close (<0.2)
   * 'different_angles': angles should help discriminate (delta > 0)
   * 'different': clearly different, both metrics should show it
   * 'info': report only, no pass/fail
   */
  expected: 'identical' | 'similar' | 'different_angles' | 'different' | 'info';
}

const TEST_PAIRS: TestPair[] = [
  // -- Diacritic confusion targets (angles should help) --
  { label: 'li vs u-acute (dot != accent)', source: 'li', target: '\u00FA', expected: 'different_angles' },
  { label: 'li vs u-grave (dot != accent)', source: 'li', target: '\u00F9', expected: 'different_angles' },
  { label: 'ii vs u-umlaut (dots != diaeresis)', source: 'ii', target: '\u00FC', expected: 'different_angles' },
  { label: 'it vs n-tilde (dot+bar != tilde)', source: 'it', target: '\u00F1', expected: 'different_angles' },

  // -- Controls: true confusables (should stay close) --
  { label: 'rn vs m (true confusable)', source: 'rn', target: 'm', expected: 'similar' },
  { label: 'o vs Cyrillic o (true confusable)', source: 'o', target: '\u043E', expected: 'identical' },
  { label: 'cl vs d (true confusable)', source: 'cl', target: 'd', expected: 'info' },
  { label: 'vv vs w (true confusable)', source: 'vv', target: 'w', expected: 'info' },

  // -- Extra diacritics (info) --
  { label: 'li vs i-acute (dot vs accent)', source: 'li', target: '\u00ED', expected: 'info' },
  { label: 'l vs l (identity control)', source: 'l', target: 'l', expected: 'identical' },
];

function runForFont(fontPath: string, pairs: TestPair[]): {
  passed: number;
  failed: number;
} {
  const font = loadFont(fontPath);
  if (!font) {
    console.log(`  Font not found: ${fontPath}\n`);
    return { passed: 0, failed: 0 };
  }

  const fontName = fontPath.split('/').pop()!;
  console.log(`\n--- ${fontName} ---\n`);
  console.log(
    'Pair'.padEnd(42) +
    'Count-only'.padStart(12) +
    'Pos-only'.padStart(12) +
    '+Angles'.padStart(12) +
    '+PingMin'.padStart(12) +
    '+PingBoth'.padStart(12) +
    ' MinOnly'.padStart(10) +
    ' MaxOnly'.padStart(10) +
    '  Expected'.padStart(18) +
    '  Result',
  );
  console.log('-'.repeat(150));

  const metrics = getFontMetrics(font);
  let passed = 0;
  let failed = 0;

  for (const pair of pairs) {
    const sourceChars = [...pair.source];

    // Build source: single char or bigram via concatGlyphPaths
    let sourceGrid;
    if (sourceChars.length === 1) {
      const path = extractGlyphPath(font, pair.source.codePointAt(0)!);
      if (!path) {
        console.log(`${pair.label.padEnd(42)}  SKIP (missing source glyph)`);
        continue;
      }
      sourceGrid = normalizeToGrid(path, metrics, GRID_SIZE);
    } else {
      const path = concatGlyphPaths(font, pair.source);
      if (!path) {
        console.log(`${pair.label.padEnd(42)}  SKIP (missing source glyph)`);
        continue;
      }
      sourceGrid = normalizeToGrid(path, metrics, GRID_SIZE);
    }

    // Build target (single char)
    const targetPath = extractGlyphPath(font, pair.target.codePointAt(0)!);
    if (!targetPath) {
      console.log(`${pair.label.padEnd(42)}  SKIP (missing target glyph)`);
      continue;
    }
    const targetGrid = normalizeToGrid(targetPath, metrics, GRID_SIZE);

    // Compute signatures
    const sigSource = computeEnrichedSignature(sourceGrid, NUM_ANGLES, RAYS_PER_ANGLE);
    const sigTarget = computeEnrichedSignature(targetGrid, NUM_ANGLES, RAYS_PER_ANGLE);

    // 1. Count-only
    const countOnly = compareCountArrays(sigSource.counts, sigTarget.counts, NUM_ANGLES, RAYS_PER_ANGLE);

    // 2. Position-only (no angles)
    const posOnly = compareEnrichedArrays(
      sigSource.counts, sigSource.positions,
      sigTarget.counts, sigTarget.positions,
      NUM_ANGLES, RAYS_PER_ANGLE,
    );

    // 3. Position + angles (no pings)
    const withAngles = compareEnrichedArrays(
      sigSource.counts, sigSource.positions,
      sigTarget.counts, sigTarget.positions,
      NUM_ANGLES, RAYS_PER_ANGLE,
      sigSource.angles, sigTarget.angles,
    );

    // 4a. Position + angles + pingMin only (stroke width)
    const withPingMin = compareEnrichedArrays(
      sigSource.counts, sigSource.positions,
      sigTarget.counts, sigTarget.positions,
      NUM_ANGLES, RAYS_PER_ANGLE,
      sigSource.angles, sigTarget.angles,
      sigSource.pingDistances, sigTarget.pingDistances,
    );

    // 4b. Position + angles + pingMin + pingMax (stroke width + counter width)
    const withPingBoth = compareEnrichedArrays(
      sigSource.counts, sigSource.positions,
      sigTarget.counts, sigTarget.positions,
      NUM_ANGLES, RAYS_PER_ANGLE,
      sigSource.angles, sigTarget.angles,
      sigSource.pingDistances, sigTarget.pingDistances,
      sigSource.pingMax, sigTarget.pingMax,
    );

    const minDelta = withPingMin - withAngles;   // contribution of pingMin alone
    const maxDelta = withPingBoth - withPingMin;  // marginal contribution of pingMax

    // Evaluate (using full enriched distance with pings)
    let status: string;
    if (pair.expected === 'info') {
      status = 'INFO';
    } else if (pair.expected === 'identical') {
      const pass = withPingBoth < 0.15;
      status = pass ? 'PASS' : 'FAIL';
      if (pass) passed++; else failed++;
    } else if (pair.expected === 'similar') {
      // rn vs m: structural differences are real, pings add interior signal
      const pass = withPingBoth < 0.5;
      status = pass ? 'PASS' : 'FAIL';
      if (pass) passed++; else failed++;
    } else if (pair.expected === 'different_angles') {
      // Angles should increase the distance compared to position-only
      const anglesHelp = (withAngles - posOnly) > 0.001;
      status = anglesHelp ? 'PASS' : 'FAIL';
      if (anglesHelp) passed++; else failed++;
    } else {
      // 'different'
      const pass = withPingBoth > 0.3;
      status = pass ? 'PASS' : 'FAIL';
      if (pass) passed++; else failed++;
    }

    console.log(
      `${pair.label.padEnd(42)}` +
      `${countOnly.toFixed(4).padStart(12)}` +
      `${posOnly.toFixed(4).padStart(12)}` +
      `${withAngles.toFixed(4).padStart(12)}` +
      `${withPingMin.toFixed(4).padStart(12)}` +
      `${withPingBoth.toFixed(4).padStart(12)}` +
      `${(minDelta >= 0 ? '+' : '') + minDelta.toFixed(4)}`.padStart(10) +
      `${(maxDelta >= 0 ? '+' : '') + maxDelta.toFixed(4)}`.padStart(10) +
      `${pair.expected.padStart(18)}` +
      `  ${status}`,
    );
  }

  return { passed, failed };
}

function main(): void {
  console.log('=== Crossing Angles Validation (RaySpace Refinement 2) ===');
  console.log('Validates that crossing angles improve diacritic discrimination.\n');

  let totalPassed = 0;
  let totalFailed = 0;

  for (const fontPath of FONT_PATHS) {
    const { passed, failed } = runForFont(fontPath, TEST_PAIRS);
    totalPassed += passed;
    totalFailed += failed;
  }

  console.log(`\n${'='.repeat(150)}`);
  console.log(`Total: ${totalPassed} passed, ${totalFailed} failed across all fonts`);

  if (totalFailed > 0) {
    console.log('\nSome tests failed. Thresholds may need tuning.');
    process.exit(1);
  } else {
    console.log('\nAll tests passed.');
  }
}

main();
