/**
 * validate-ssim-grey.ts
 *
 * Cross-validation: compares ssim.js (via computeSsim) against ssim-grey
 * (direct greyscale SSIM) on real confusable-vision normalised images.
 *
 * Gate: max absolute delta < 0.005
 *
 * Usage:
 *   npx tsx scripts/validate-ssim-grey.ts
 */

import { initFonts } from '../src/fonts.js';
import { renderSequence, renderCharacter } from '../src/renderer.js';
import { normalisePair } from '../src/normalise-image.js';
import { computeSsim } from '../src/compare.js';
import { ssimGrey } from '../../ssim-grey/src/index.js';

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
  ['ww', 'n'],
  ['mm', 'n'],
  ['aa', 'm'],
];

const MAX_DELTA = 0.005;

async function main() {
  console.log('=== validate-ssim-grey: ssim.js vs ssim-grey ===\n');

  const fonts = initFonts();
  const available = new Set(fonts.filter(f => f.available).map(f => f.family));
  const activeFonts = TEST_FONTS.filter(f => available.has(f));
  console.log(`Testing with: ${activeFonts.join(', ')}\n`);

  if (activeFonts.length === 0) {
    console.error('ERROR: No test fonts available.');
    process.exit(1);
  }

  let maxDelta = 0;
  let tested = 0;
  let failed = false;

  for (const [seq, target] of TEST_PAIRS) {
    console.log(`"${seq}" vs "${target}":`);

    for (const font of activeFonts) {
      const seqResult = renderSequence(seq, font);
      const charResult = renderCharacter(target, font);

      if (!seqResult || !charResult) {
        console.log(`  ${font.padEnd(20)} SKIP (render returned null)`);
        continue;
      }

      // Normalise via sharp (both paths use the same normalised images)
      const [normA, normB] = await normalisePair(
        seqResult.pngBuffer,
        charResult.pngBuffer,
      );

      // ssim.js path (via computeSsim which does greyToRgba expansion)
      const refSsim = computeSsim(normA, normB);

      // ssim-grey path (direct greyscale)
      const greySsim = ssimGrey(
        normA.rawPixels,
        normB.rawPixels,
        normA.width,
        normA.height,
      );

      const delta = Math.abs(refSsim - greySsim);
      if (delta > maxDelta) maxDelta = delta;
      tested++;

      const status = delta > MAX_DELTA ? 'FAIL' : 'ok';
      if (delta > MAX_DELTA) failed = true;

      console.log(
        `  ${font.padEnd(20)} ssim.js=${refSsim.toFixed(6)}  grey=${greySsim.toFixed(6)}  delta=${delta.toFixed(6)}  ${status}`,
      );
    }
    console.log('');
  }

  console.log('=== RESULT ===\n');
  console.log(`Tested: ${tested} pair/font combinations`);
  console.log(`Max delta: ${maxDelta.toFixed(6)} (threshold: ${MAX_DELTA})`);

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
