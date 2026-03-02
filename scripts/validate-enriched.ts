/**
 * validate-enriched.ts
 *
 * Validates the enriched raycasting comparison (counts + positions) on
 * known confusable pairs. Compares old count-only metric with new enriched
 * metric to verify that positions improve discrimination.
 *
 * Key test cases:
 * - l vs alef: identical (both metrics ~0)
 * - i vs alef: dot detected by positions (enriched >> count-only)
 * - c vs o: opening detected by position differences
 * - Georgian U+10FF vs o: true positive (small distance)
 * - Georgian U+10FF vs c: SDF false positive (enriched should separate)
 * - Georgian U+10FF vs e: SDF false positive (enriched should separate)
 *
 * Usage: npx tsx scripts/validate-enriched.ts
 */

import { loadFont, extractGlyphPath, getFontMetrics, normalizeToGrid } from '../src/glyph-path.js';
import { computeEnrichedSignature } from '../src/raycasting.js';
import { compareEnrichedArrays, compareCountArrays } from '../src/signature-bank.js';

const GRID_SIZE = 128;
const NUM_ANGLES = 36;
const RAYS_PER_ANGLE = 50;

// Known system font paths -- Helvetica first (has Georgian, Cyrillic, Arabic coverage)
const FONT_PATHS = [
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/Supplemental/Tahoma.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
];

interface TestPair {
  label: string;
  charA: string;
  charB: string;
  /** 'identical' (<0.15), 'similar' (<0.15), 'different' (>0.3), 'info' (report only) */
  expected: 'identical' | 'similar' | 'different' | 'info';
}

const TEST_PAIRS: TestPair[] = [
  // Font-conditional: identical in Tahoma (0.0004), different in Arial (0.6547)
  { label: 'l vs alef (font-conditional)', charA: 'l', charB: '\u0627', expected: 'info' },
  { label: 'o vs Georgian U+10FF (round match)', charA: 'o', charB: '\u10FF', expected: 'similar' },

  // The dot problem: count-only misses it, enriched should catch it
  { label: 'i vs alef (DOT PROBLEM)', charA: 'i', charB: '\u0627', expected: 'different' },

  // Open vs closed: positions reveal the opening in c
  { label: 'c vs o (open vs closed)', charA: 'c', charB: 'o', expected: 'different' },

  // SDF false positives: enriched should show these are different
  { label: 'c vs Georgian U+10FF (SDF false positive)', charA: 'c', charB: '\u10FF', expected: 'different' },
  { label: 'e vs Georgian U+10FF (SDF false positive)', charA: 'e', charB: '\u10FF', expected: 'different' },

  // Control: clearly different characters
  { label: 'a vs z (control, clearly different)', charA: 'a', charB: 'z', expected: 'different' },

  // IPA / ligature-like pairs
  { label: 'o vs Cyrillic o U+043E (should match)', charA: 'o', charB: '\u043E', expected: 'identical' },

  // Counter-opening signal (pings should capture)
  { label: 'G vs O (counter opening, uppercase)', charA: 'G', charB: 'O', expected: 'different' },
  { label: 'e vs o (crossbar vs open counter)', charA: 'e', charB: 'o', expected: 'different' },
];

function runForFont(fontPath: string, pairs: TestPair[]): { passed: number; failed: number; tested: number } {
  const font = loadFont(fontPath);
  if (!font) {
    console.log(`  Font not found: ${fontPath}\n`);
    return { passed: 0, failed: 0, tested: 0 };
  }

  const fontName = fontPath.split('/').pop()!;
  console.log(`\n--- ${fontName} ---\n`);
  console.log(
    'Pair'.padEnd(45) +
    'Count-only'.padStart(12) +
    'Pos+Ang'.padStart(12) +
    '+Pings'.padStart(12) +
    '  PingDelta'.padStart(12) +
    '  Expected'.padStart(12) +
    '  Result',
  );
  console.log('-'.repeat(120));

  const metrics = getFontMetrics(font);
  let passed = 0;
  let failed = 0;

  for (const pair of pairs) {
    const cpA = pair.charA.codePointAt(0)!;
    const cpB = pair.charB.codePointAt(0)!;

    const pathA = extractGlyphPath(font, cpA);
    const pathB = extractGlyphPath(font, cpB);

    if (!pathA || !pathB) {
      console.log(`${pair.label.padEnd(45)}  SKIP (missing glyph)`);
      continue;
    }

    const gridA = normalizeToGrid(pathA, metrics, GRID_SIZE);
    const gridB = normalizeToGrid(pathB, metrics, GRID_SIZE);

    const sigA = computeEnrichedSignature(gridA, NUM_ANGLES, RAYS_PER_ANGLE);
    const sigB = computeEnrichedSignature(gridB, NUM_ANGLES, RAYS_PER_ANGLE);

    const countOnly = compareCountArrays(sigA.counts, sigB.counts, NUM_ANGLES, RAYS_PER_ANGLE);

    // Without pings (pos + angles only)
    const noPings = compareEnrichedArrays(
      sigA.counts, sigA.positions,
      sigB.counts, sigB.positions,
      NUM_ANGLES, RAYS_PER_ANGLE,
      sigA.angles, sigB.angles,
    );

    // With pings (full enriched)
    const withPings = compareEnrichedArrays(
      sigA.counts, sigA.positions,
      sigB.counts, sigB.positions,
      NUM_ANGLES, RAYS_PER_ANGLE,
      sigA.angles, sigB.angles,
      sigA.pingDistances, sigB.pingDistances,
      sigA.pingMax, sigB.pingMax,
    );

    const pingDelta = withPings - noPings;

    // Evaluate result (using full enriched distance)
    // Thresholds: confusable pairs score < 0.15 (may have slight outline differences),
    // different pairs score > 0.3 (clear gap between groups)
    let status: string;
    if (pair.expected === 'info') {
      status = 'INFO';
    } else if (pair.expected === 'identical' || pair.expected === 'similar') {
      const pass = withPings < 0.15;
      status = pass ? 'PASS' : 'FAIL';
      if (pass) passed++; else failed++;
    } else {
      // 'different': enriched should clearly separate from confusable pairs
      const pass = withPings > 0.3;
      status = pass ? 'PASS' : 'FAIL';
      if (pass) passed++; else failed++;
    }

    console.log(
      `${pair.label.padEnd(45)}` +
      `${countOnly.toFixed(4).padStart(12)}` +
      `${noPings.toFixed(4).padStart(12)}` +
      `${withPings.toFixed(4).padStart(12)}` +
      `${(pingDelta >= 0 ? '+' : '') + pingDelta.toFixed(4)}`.padStart(12) +
      `${pair.expected.padStart(12)}` +
      `  ${status}`,
    );
  }

  return { passed, failed, tested: passed + failed };
}

function main(): void {
  console.log('=== Enriched Raycasting Validation ===');

  let totalPassed = 0;
  let totalFailed = 0;

  for (const fontPath of FONT_PATHS) {
    const { passed, failed } = runForFont(fontPath, TEST_PAIRS);
    totalPassed += passed;
    totalFailed += failed;
  }

  console.log(`\n${'='.repeat(100)}`);
  console.log(`Total: ${totalPassed} passed, ${totalFailed} failed across all fonts`);

  if (totalFailed > 0) {
    console.log('\nNote: Threshold calibration may need adjustment based on these results.');
    process.exit(1);
  }
}

main();
