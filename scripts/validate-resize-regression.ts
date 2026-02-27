/**
 * validate-resize-regression.ts
 *
 * Regression test: compares the sharp-based normalisePair() path against
 * the pure JS normalisePairCached() path. Both should produce nearly
 * identical SSIM scores for the same input pairs.
 *
 * Gate: max absolute SSIM delta < 0.02
 *
 * Usage:
 *   npx tsx scripts/validate-resize-regression.ts
 */

import { initFonts } from '../src/fonts.js';
import { renderSequence, renderCharacter } from '../src/renderer.js';
import { normalisePair, normalisePairCached, decodeAndFindBounds } from '../src/normalise-image.js';
import { computeSsim } from '../src/compare.js';

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
  ['ww', 'n'],
  ['mm', 'n'],
  ['aa', 'm'],
];

const MAX_DELTA = 0.02;

async function main() {
  console.log('=== validate-resize-regression: sharp vs pure JS ===\n');

  const fonts = initFonts();
  const available = new Set(fonts.filter(f => f.available).map(f => f.family));
  const activeFonts = TEST_FONTS.filter(f => available.has(f));
  const missing = TEST_FONTS.filter(f => !available.has(f));
  if (missing.length > 0) {
    console.log(`Skipping unavailable fonts: ${missing.join(', ')}`);
  }
  console.log(`Testing with: ${activeFonts.join(', ')}\n`);

  if (activeFonts.length === 0) {
    console.error('ERROR: No test fonts available.');
    process.exit(1);
  }

  const allPairs = [...TEST_PAIRS, ...NEGATIVE_PAIRS];
  let maxDelta = 0;
  let tested = 0;
  let failed = false;

  for (const [seq, target] of allPairs) {
    console.log(`"${seq}" vs "${target}":`);

    for (const font of activeFonts) {
      const seqResult = renderSequence(seq, font);
      const charResult = renderCharacter(target, font);

      if (!seqResult || !charResult) {
        console.log(`  ${font.padEnd(20)} SKIP (render returned null)`);
        continue;
      }

      // Sharp path (reference)
      const [sharpA, sharpB] = await normalisePair(
        seqResult.pngBuffer,
        charResult.pngBuffer,
      );
      const sharpSsim = computeSsim(sharpA, sharpB);

      // Pure JS path
      const cachedA = await decodeAndFindBounds(seqResult.pngBuffer);
      const cachedB = await decodeAndFindBounds(charResult.pngBuffer);
      const [jsA, jsB] = normalisePairCached(cachedA, cachedB);
      const jsSsim = computeSsim(jsA, jsB);

      const delta = Math.abs(sharpSsim - jsSsim);
      if (delta > maxDelta) maxDelta = delta;
      tested++;

      const status = delta > MAX_DELTA ? 'FAIL' : 'ok';
      if (delta > MAX_DELTA) failed = true;

      console.log(
        `  ${font.padEnd(20)} sharp=${sharpSsim.toFixed(4)}  js=${jsSsim.toFixed(4)}  delta=${delta.toFixed(4)}  ${status}`,
      );
    }
    console.log('');
  }

  console.log('=== RESULT ===\n');
  console.log(`Tested: ${tested} pair/font combinations`);
  console.log(`Max delta: ${maxDelta.toFixed(4)} (threshold: ${MAX_DELTA})`);

  if (failed) {
    console.log('\nFAILED: One or more deltas exceeded threshold.\n');
    process.exit(1);
  } else {
    console.log('\nPASSED: All deltas within threshold.\n');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
