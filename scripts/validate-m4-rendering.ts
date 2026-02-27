/**
 * validate-m4-rendering.ts -- Phase 1 gate for Milestone 4 redesign
 *
 * Quick sanity check that renderSequence() + normalisePair() produces
 * valid multi-char vs single-char comparisons with baseline alignment
 * and unified scaling. Runs in seconds.
 *
 * Tests:
 *   "rn" vs "m"  (primary -- must score > 0.75 in at least one font)
 *   "cl" vs "d"  (secondary)
 *   "vv" vs "w"  (secondary)
 *
 * Usage:
 *   npx tsx scripts/validate-m4-rendering.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { initFonts } from '../src/fonts.js';
import { renderSequence, renderCharacter } from '../src/renderer.js';
import { normalisePair, inkCoverage, decodeAndFindBounds, getInkWidth } from '../src/normalise-image.js';
import { computeSsim } from '../src/compare.js';

const DEBUG_DIR = path.resolve(import.meta.dirname, '..', 'data/output/m4-debug');

const TEST_FONTS = [
  'Arial',
  'Helvetica',
  'Menlo',
  'Courier New',
  'Times New Roman',
];

const TEST_PAIRS: [string, string][] = [
  ['rn', 'm'],
  ['cl', 'd'],
  ['vv', 'w'],
];

const NEGATIVE_PAIRS: [string, string][] = [
  ['ww', 'n'],   // Extreme width ratio, should score low or be filtered
  ['mm', 'n'],   // Extreme width ratio, should score low or be filtered
  ['aa', 'm'],   // Extreme width ratio, should score low or be filtered
];

const WIDTH_RATIO_MAX = 2.0;
const INK_COVERAGE_MIN = 0.03;

async function main() {
  console.log('=== confusable-vision: validate-m4-rendering (Phase 1 gate) ===\n');

  console.log('[1/2] Initialising fonts...');
  const fonts = initFonts();
  const available = new Set(fonts.filter(f => f.available).map(f => f.family));

  const activeFonts = TEST_FONTS.filter(f => available.has(f));
  const missingFonts = TEST_FONTS.filter(f => !available.has(f));
  if (missingFonts.length > 0) {
    console.log(`  Skipping unavailable fonts: ${missingFonts.join(', ')}`);
  }
  console.log(`  Testing with: ${activeFonts.join(', ')}\n`);

  if (activeFonts.length === 0) {
    console.error('ERROR: No test fonts available. Cannot validate.');
    process.exit(1);
  }

  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  console.log(`[2/2] Scoring test pairs at 48px (debug PNGs in ${DEBUG_DIR})...\n`);

  let rnMaxSsim = 0;
  let anyFailure = false;

  for (const [seq, target] of TEST_PAIRS) {
    console.log(`  "${seq}" vs "${target}":`);
    const scores: number[] = [];

    for (const font of activeFonts) {
      const seqResult = renderSequence(seq, font);
      const charResult = renderCharacter(target, font);

      if (!seqResult || !charResult) {
        console.log(`    ${font}: SKIP (render returned null)`);
        continue;
      }

      const [seqNorm, charNorm] = await normalisePair(
        seqResult.pngBuffer,
        charResult.pngBuffer,
      );
      const ssim = computeSsim(seqNorm, charNorm);

      // Save debug PNGs
      const safeFont = font.replace(/\s+/g, '-');
      fs.writeFileSync(path.join(DEBUG_DIR, `${seq}_${safeFont}_raw.png`), seqResult.pngBuffer);
      fs.writeFileSync(path.join(DEBUG_DIR, `${target}_${safeFont}_raw.png`), charResult.pngBuffer);
      fs.writeFileSync(path.join(DEBUG_DIR, `${seq}_${safeFont}_pair.png`), seqNorm.pngBuffer);
      fs.writeFileSync(path.join(DEBUG_DIR, `${target}_${safeFont}_pair.png`), charNorm.pngBuffer);

      scores.push(ssim);
      const bar = '#'.repeat(Math.max(0, Math.round(ssim * 40)));
      console.log(`    ${font.padEnd(20)} SSIM=${ssim.toFixed(4)}  ${bar}`);

      if (seq === 'rn' && target === 'm' && ssim > rnMaxSsim) {
        rnMaxSsim = ssim;
      }
    }

    if (scores.length > 0) {
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const max = Math.max(...scores);
      console.log(`    mean=${mean.toFixed(4)}  max=${max.toFixed(4)}\n`);
    } else {
      console.log(`    No valid renders\n`);
      anyFailure = true;
    }
  }

  // Negative controls: pairs with extreme width ratios
  console.log('--- Negative controls (should score LOW or be filtered) ---\n');

  let negativeMaxSsim = 0;

  for (const [seq, target] of NEGATIVE_PAIRS) {
    console.log(`  "${seq}" vs "${target}":`);

    for (const font of activeFonts) {
      const seqResult = renderSequence(seq, font);
      const charResult = renderCharacter(target, font);

      if (!seqResult || !charResult) {
        console.log(`    ${font}: SKIP (render returned null)`);
        continue;
      }

      // Compute ink widths and width ratio
      const seqDecoded = await decodeAndFindBounds(seqResult.pngBuffer);
      const charDecoded = await decodeAndFindBounds(charResult.pngBuffer);
      const seqInkW = getInkWidth(seqDecoded);
      const charInkW = getInkWidth(charDecoded);

      let widthRatio: number | null = null;
      let widthFiltered = false;
      if (seqInkW && charInkW) {
        widthRatio = Math.max(seqInkW, charInkW) / Math.min(seqInkW, charInkW);
        widthFiltered = widthRatio > WIDTH_RATIO_MAX;
      }

      const [seqNorm, charNorm] = await normalisePair(
        seqResult.pngBuffer,
        charResult.pngBuffer,
      );

      // Check ink coverage
      const seqInk = inkCoverage(seqNorm.rawPixels);
      const charInk = inkCoverage(charNorm.rawPixels);
      const inkFiltered = seqInk < INK_COVERAGE_MIN || charInk < INK_COVERAGE_MIN;

      const ssim = computeSsim(seqNorm, charNorm);
      const filtered = widthFiltered || inkFiltered;
      const effectiveScore = filtered ? null : ssim;

      // Save debug PNGs
      const safeFont = font.replace(/\s+/g, '-');
      fs.writeFileSync(path.join(DEBUG_DIR, `neg_${seq}_${safeFont}_pair.png`), seqNorm.pngBuffer);
      fs.writeFileSync(path.join(DEBUG_DIR, `neg_${target}_${safeFont}_pair.png`), charNorm.pngBuffer);

      const ratioStr = widthRatio ? widthRatio.toFixed(2) + 'x' : 'N/A';
      const filterTag = filtered ? ' [FILTERED]' : '';
      console.log(`    ${font.padEnd(20)} SSIM=${ssim.toFixed(4)}  wRatio=${ratioStr}  ink=${(seqInk * 100).toFixed(1)}%/${(charInk * 100).toFixed(1)}%${filterTag}`);

      if (!filtered && ssim > negativeMaxSsim) {
        negativeMaxSsim = ssim;
      }
    }
    console.log('');
  }

  // Gate check
  console.log('=== GATE CHECK ===\n');
  if (rnMaxSsim > 0.75) {
    console.log(`  PASS: "rn"/"m" max SSIM = ${rnMaxSsim.toFixed(4)} (> 0.75)`);
  } else {
    console.log(`  FAIL: "rn"/"m" max SSIM = ${rnMaxSsim.toFixed(4)} (need > 0.75)`);
    anyFailure = true;
  }

  // Negative control gate: unfiltered scores must be < 0.5
  if (negativeMaxSsim < 0.5) {
    console.log(`  PASS: Negative controls max unfiltered SSIM = ${negativeMaxSsim.toFixed(4)} (< 0.5 or all filtered)`);
  } else {
    console.log(`  FAIL: Negative controls max unfiltered SSIM = ${negativeMaxSsim.toFixed(4)} (need < 0.5 or filtered)`);
    anyFailure = true;
  }

  if (anyFailure) {
    console.log('\n  Phase 1 gate FAILED. Do not proceed to Phase 2.\n');
    process.exit(1);
  } else {
    console.log('\n  Phase 1 gate PASSED. Safe to proceed to Phase 2.\n');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
