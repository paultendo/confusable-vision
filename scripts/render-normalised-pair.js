import { createRequire } from 'node:module';
import fs from 'node:fs';
import sharp from 'sharp';
import { decode } from 'fast-png';
import { encode } from 'fast-png';
import {
  decodePngToGrey,
  findInkBounds,
  normalisePairCached,
} from '../src/normalise-core.js';

const srcPath = process.argv[2];
const tgtPath = process.argv[3];
const outPath = process.argv[4] || '/tmp/normalised-comparison.png';

if (!srcPath || !tgtPath) {
  console.error('Usage: node render-normalised-pair.js <src.png> <tgt.png> [out.png]');
  process.exit(1);
}

const srcPng = fs.readFileSync(srcPath);
const tgtPng = fs.readFileSync(tgtPath);

// Decode to greyscale + find ink bounds (same as scoring pipeline)
const srcDec = decodePngToGrey(decode, srcPng);
const srcBounds = findInkBounds(srcDec.pixels, srcDec.width, srcDec.height);
const tgtDec = decodePngToGrey(decode, tgtPng);
const tgtBounds = findInkBounds(tgtDec.pixels, tgtDec.width, tgtDec.height);

console.log('Source:', srcDec.width, 'x', srcDec.height, 'bounds:', srcBounds);
console.log('Target:', tgtDec.width, 'x', tgtDec.height, 'bounds:', tgtBounds);

// Run exact same normalisation as workers
const [srcNorm, tgtNorm] = normalisePairCached(
  { pixels: srcDec.pixels, width: srcDec.width, height: srcDec.height, bounds: srcBounds },
  { pixels: tgtDec.pixels, width: tgtDec.width, height: tgtDec.height, bounds: tgtBounds },
);

console.log('Normalised size:', srcNorm.width, 'x', srcNorm.height);

// Compute SSIM
const require2 = createRequire(import.meta.url);
const wasm = require2('ssim-grey/wasm');
const ssim = wasm.ssim_grey(srcNorm.rawPixels, tgtNorm.rawPixels, srcNorm.width, srcNorm.height);
console.log('SSIM:', ssim.toFixed(4));

// Build comparison: scale up with nearest-neighbor, side by side
const normSize = srcNorm.width; // 96
const scale = 5;
const cellSize = normSize * scale;
const gap = 20;
const labelH = 40;
const totalW = cellSize * 2 + gap;
const totalH = cellSize + labelH;

// Scale up by manually expanding pixels (no sharp rounding issues)
function scaleUp(rawPixels, size, factor) {
  const outSize = size * factor;
  const out = Buffer.alloc(outSize * outSize * 3);
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      const srcX = Math.floor(x / factor);
      const srcY = Math.floor(y / factor);
      const val = rawPixels[srcY * size + srcX];
      const idx = (y * outSize + x) * 3;
      out[idx] = val;
      out[idx + 1] = val;
      out[idx + 2] = val;
    }
  }
  return out;
}

const srcScaled = scaleUp(srcNorm.rawPixels, normSize, scale);
const tgtScaled = scaleUp(tgtNorm.rawPixels, normSize, scale);

async function main() {
  const srcPngBuf = await sharp(srcScaled, { raw: { width: cellSize, height: cellSize, channels: 3 } })
    .png()
    .toBuffer();

  const tgtPngBuf = await sharp(tgtScaled, { raw: { width: cellSize, height: cellSize, channels: 3 } })
    .png()
    .toBuffer();

  await sharp({
    create: { width: totalW, height: totalH, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .composite([
      { input: srcPngBuf, left: 0, top: labelH },
      { input: tgtPngBuf, left: cellSize + gap, top: labelH },
    ])
    .png()
    .toFile(outPath);

  console.log('Written to:', outPath);
  console.log('Image:', totalW, 'x', totalH, '(cells', cellSize, 'x', cellSize, ')');
}

main();
