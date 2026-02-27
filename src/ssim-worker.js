/**
 * Worker thread for normalisation + ink check + SSIM computation.
 * Receives raw decoded greyscale data with bounds, returns SSIM scores.
 *
 * Does normalise (Catmull-Rom bicubic resize) + ink coverage check + WASM SSIM
 * all in the worker, keeping the main thread free for filtering and dispatch.
 *
 * Plain JS so it can be loaded by worker_threads without tsx.
 * Type definitions are in ssim-worker.ts.
 */

import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';
import { normalisePairCached, inkCoverage } from './normalise-core.js';

const require = createRequire(import.meta.url);
const wasm = require('ssim-grey/wasm');

parentPort.on('message', (batch) => {
  const results = new Array(batch.length);
  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];

    // Reconstruct Buffers (structured clone sends Uint8Array)
    const cachedA = {
      pixels: Buffer.from(item.pixelsA),
      width: item.widthA,
      height: item.heightA,
      bounds: item.boundsA,
    };
    const cachedB = {
      pixels: Buffer.from(item.pixelsB),
      width: item.widthB,
      height: item.heightB,
      bounds: item.boundsB,
    };

    const [srcNorm, tgtNorm] = normalisePairCached(cachedA, cachedB);

    const srcInk = inkCoverage(srcNorm.rawPixels);
    const tgtInk = inkCoverage(tgtNorm.rawPixels);

    if (srcInk < item.inkCoverageMin || tgtInk < item.inkCoverageMin) {
      results[i] = { idx: item.idx, ssim: null, inkSkipped: true };
    } else {
      results[i] = {
        idx: item.idx,
        ssim: wasm.ssim_grey(srcNorm.rawPixels, tgtNorm.rawPixels, srcNorm.width, srcNorm.height),
        inkSkipped: false,
      };
    }
  }
  parentPort.postMessage(results);
});
