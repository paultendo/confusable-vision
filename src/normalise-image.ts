import sharp from 'sharp';
import type { NormalisedResult } from './types.js';

const TARGET_SIZE = 48;

// ---------------------------------------------------------------------------
// Pure JS Catmull-Rom (bicubic) resize for single-channel greyscale.
// Matches sharp/libvips upscale kernel exactly (a = -0.5).
// ---------------------------------------------------------------------------

/** Catmull-Rom basis function (a = -0.5). */
function catmullRom(t: number): number {
  const abs = Math.abs(t);
  if (abs <= 1) return 1.5 * abs * abs * abs - 2.5 * abs * abs + 1;
  if (abs <= 2) return -0.5 * abs * abs * abs + 2.5 * abs * abs - 4 * abs + 2;
  return 0;
}

/**
 * Resize a single-channel greyscale buffer using Catmull-Rom interpolation.
 * Uses centre-pixel mapping: `(i + 0.5) * srcDim / dstDim - 0.5`.
 * 4x4 neighbourhood sampling, output clamped to [0, 255].
 */
function bicubicResize(
  src: Buffer,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Buffer {
  // Two-pass separable: horizontal then vertical.
  // Pass 1: resize horizontally (srcH rows, dstW columns)
  const tmp = Buffer.allocUnsafe(dstW * srcH);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < dstW; x++) {
      const srcX = (x + 0.5) * srcW / dstW - 0.5;
      const ix = Math.floor(srcX);
      const fx = srcX - ix;
      let sum = 0;
      let wSum = 0;
      for (let k = -1; k <= 2; k++) {
        const sx = Math.min(Math.max(ix + k, 0), srcW - 1);
        const w = catmullRom(fx - k);
        sum += src[y * srcW + sx]! * w;
        wSum += w;
      }
      tmp[y * dstW + x] = Math.min(255, Math.max(0, Math.round(sum / wSum)));
    }
  }

  // Pass 2: resize vertically (dstH rows, dstW columns)
  const dst = Buffer.allocUnsafe(dstW * dstH);
  for (let x = 0; x < dstW; x++) {
    for (let y = 0; y < dstH; y++) {
      const srcY = (y + 0.5) * srcH / dstH - 0.5;
      const iy = Math.floor(srcY);
      const fy = srcY - iy;
      let sum = 0;
      let wSum = 0;
      for (let k = -1; k <= 2; k++) {
        const sy = Math.min(Math.max(iy + k, 0), srcH - 1);
        const w = catmullRom(fy - k);
        sum += tmp[sy * dstW + x]! * w;
        wSum += w;
      }
      dst[y * dstW + x] = Math.min(255, Math.max(0, Math.round(sum / wSum)));
    }
  }

  return dst;
}

/**
 * Centre `src` in a `targetSize x targetSize` canvas filled with `bgValue`.
 * Row-level Buffer.copy for speed.
 */
function padToTarget(
  src: Buffer,
  srcW: number,
  srcH: number,
  targetSize: number,
  bgValue: number,
): Buffer {
  const out = Buffer.alloc(targetSize * targetSize, bgValue);
  const offX = Math.floor((targetSize - srcW) / 2);
  const offY = Math.floor((targetSize - srcH) / 2);
  for (let y = 0; y < srcH; y++) {
    src.copy(out, (offY + y) * targetSize + offX, y * srcW, y * srcW + srcW);
  }
  return out;
}

/** Ink bounding box in canvas pixel coordinates */
export interface InkBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Decoded greyscale image with raw pixel data */
interface DecodedGrey {
  pixels: Buffer;
  width: number;
  height: number;
}

/** Pre-decoded target with cached ink bounds (avoids redundant decode per pair). */
export interface DecodedGreyWithBounds {
  pixels: Buffer;
  width: number;
  height: number;
  bounds: InkBounds | null;
}

/**
 * Normalise a rendered glyph PNG:
 * 1. Convert to greyscale (GlyphNet finding: greyscale outperforms colour)
 * 2. Trim whitespace (threshold 10)
 * 3. Resize to 48x48, fit:contain with white background
 * 4. Return PNG buffer and raw greyscale pixels
 */
export async function normaliseImage(pngBuffer: Buffer): Promise<NormalisedResult> {
  let pipeline = sharp(pngBuffer).greyscale();

  // Try to trim whitespace; if image is blank/near-blank, trimming may fail
  let trimmed: Buffer;
  try {
    trimmed = await pipeline.trim({ threshold: 10 }).toBuffer();
  } catch {
    // Trim failed (e.g. blank image) -- return all-white 48x48
    const white = await sharp({
      create: {
        width: TARGET_SIZE,
        height: TARGET_SIZE,
        channels: 1,
        background: { r: 255 },
      },
    })
      .png()
      .toBuffer();

    const rawPixels = await sharp(white).raw().toBuffer();
    return {
      pngBuffer: white,
      rawPixels,
      width: TARGET_SIZE,
      height: TARGET_SIZE,
    };
  }

  // Resize trimmed image to target size with white background
  const resized = await sharp(trimmed)
    .resize(TARGET_SIZE, TARGET_SIZE, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255 },
    })
    .greyscale()
    .png()
    .toBuffer();

  const rawPixels = await sharp(resized).greyscale().raw().toBuffer();

  return {
    pngBuffer: resized,
    rawPixels,
    width: TARGET_SIZE,
    height: TARGET_SIZE,
  };
}

/**
 * Decode a PNG to greyscale raw pixels with dimensions.
 */
async function decodeGrey(pngBuffer: Buffer): Promise<DecodedGrey> {
  const { data, info } = await sharp(pngBuffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { pixels: Buffer.from(data), width: info.width, height: info.height };
}

/**
 * Find the ink bounding box in a greyscale image.
 * Ink = any pixel darker than (255 - threshold). Returns null for blank images.
 */
function findInkBounds(
  pixels: Buffer,
  width: number,
  height: number,
  threshold = 10,
): InkBounds | null {
  const cutoff = 255 - threshold;
  let top = height, bottom = 0, left = width, right = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x]! < cutoff) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (top > bottom) return null;
  return { top, bottom, left, right };
}

/**
 * Build a white NormalisedResult (blank image at TARGET_SIZE x TARGET_SIZE).
 */
async function blankResult(): Promise<NormalisedResult> {
  const white = await sharp({
    create: {
      width: TARGET_SIZE,
      height: TARGET_SIZE,
      channels: 1,
      background: { r: 255 },
    },
  })
    .png()
    .toBuffer();

  const rawPixels = await sharp(white).raw().toBuffer();
  return { pngBuffer: white, rawPixels, width: TARGET_SIZE, height: TARGET_SIZE };
}

/**
 * Normalise a pair of rendered glyphs for multi-char vs single-char comparison.
 *
 * Preserves both the natural size relationship AND baseline alignment between
 * the two renders, exactly as a human would see them at the same font size.
 *
 * Both input PNGs must be rendered with textBaseline='middle' at canvasHeight/2
 * (the standard used by renderSequence and renderCharacter).
 *
 * Algorithm:
 * 1. Decode both to greyscale, find each image's ink bounding box
 * 2. Compute the union of both VERTICAL ink ranges (midpoint-relative,
 *    so baseline alignment is preserved even if canvas heights differ)
 * 3. Trim each image HORIZONTALLY to its own ink bounds
 * 4. Crop both to the union vertical range (same height, same baseline)
 * 5. Scale both by the same factor (fits the larger bounding box into 48x48)
 * 6. Center horizontally, preserve vertical position, pad into 48x48
 */
export async function normalisePair(
  pngA: Buffer,
  pngB: Buffer,
): Promise<[NormalisedResult, NormalisedResult]> {
  const decA = await decodeGrey(pngA);
  const decB = await decodeGrey(pngB);

  const boundsA = findInkBounds(decA.pixels, decA.width, decA.height);
  const boundsB = findInkBounds(decB.pixels, decB.width, decB.height);

  if (!boundsA && !boundsB) {
    return [await blankResult(), await blankResult()];
  }
  if (!boundsA) return [await blankResult(), await normaliseImage(pngB)];
  if (!boundsB) return [await normaliseImage(pngA), await blankResult()];

  // Convert vertical ink bounds to midpoint-relative coordinates.
  // Both renders use textBaseline='middle' at canvasHeight/2, so the
  // midpoint is the shared vertical reference.
  const midA = decA.height / 2;
  const midB = decB.height / 2;

  const relTopA = boundsA.top - midA;
  const relBotA = boundsA.bottom - midA;
  const relTopB = boundsB.top - midB;
  const relBotB = boundsB.bottom - midB;

  // Union vertical range (preserves baseline alignment)
  const unionRelTop = Math.min(relTopA, relTopB);
  const unionRelBot = Math.max(relBotA, relBotB);

  // Convert back to canvas coordinates for cropping
  const cropTopA = Math.max(0, Math.floor(midA + unionRelTop));
  const cropTopB = Math.max(0, Math.floor(midB + unionRelTop));
  const cropBotA = Math.min(decA.height - 1, Math.ceil(midA + unionRelBot));
  const cropBotB = Math.min(decB.height - 1, Math.ceil(midB + unionRelBot));

  // Both crops have the same height (baseline-aligned)
  const cropH = Math.max(cropBotA - cropTopA + 1, cropBotB - cropTopB + 1);

  // Horizontal: each image's own ink bounds
  const cropWA = boundsA.right - boundsA.left + 1;
  const cropWB = boundsB.right - boundsB.left + 1;

  // Extract the baseline-aligned crops from the original PNGs
  const croppedA = await sharp(pngA)
    .greyscale()
    .extract({ left: boundsA.left, top: cropTopA, width: cropWA, height: cropH })
    .toBuffer();
  const croppedB = await sharp(pngB)
    .greyscale()
    .extract({ left: boundsB.left, top: cropTopB, width: cropWB, height: cropH })
    .toBuffer();

  // Unified scale factor: fit the larger of the two crops into TARGET_SIZE
  const maxW = Math.max(cropWA, cropWB);
  const scale = Math.min(TARGET_SIZE / maxW, TARGET_SIZE / cropH);

  async function applyScale(
    cropped: Buffer,
    cropW: number,
  ): Promise<NormalisedResult> {
    const scaledW = Math.max(1, Math.round(cropW * scale));
    const scaledH = Math.max(1, Math.round(cropH * scale));

    // Resize, then center horizontally and vertically in TARGET_SIZE box
    const resized = await sharp(cropped)
      .resize(scaledW, scaledH, { fit: 'fill' })
      .greyscale()
      .extend({
        top: Math.floor((TARGET_SIZE - scaledH) / 2),
        bottom: Math.ceil((TARGET_SIZE - scaledH) / 2),
        left: Math.floor((TARGET_SIZE - scaledW) / 2),
        right: Math.ceil((TARGET_SIZE - scaledW) / 2),
        background: { r: 255, g: 255, b: 255 },
      })
      .png()
      .toBuffer();

    const rawPixels = await sharp(resized).greyscale().raw().toBuffer();
    return { pngBuffer: resized, rawPixels, width: TARGET_SIZE, height: TARGET_SIZE };
  }

  return [
    await applyScale(croppedA, cropWA),
    await applyScale(croppedB, cropWB),
  ];
}

/**
 * Decode a PNG to greyscale and find its ink bounds in one pass.
 * Use this to pre-cache target data so normalisePairCached() can skip
 * redundant decodes.
 */
export async function decodeAndFindBounds(pngBuffer: Buffer): Promise<DecodedGreyWithBounds> {
  const decoded = await decodeGrey(pngBuffer);
  const bounds = findInkBounds(decoded.pixels, decoded.width, decoded.height);
  return { pixels: decoded.pixels, width: decoded.width, height: decoded.height, bounds };
}

/** Synchronous blank result: 48x48 white buffer. No sharp needed. */
function blankResultSync(): NormalisedResult {
  return {
    pngBuffer: Buffer.alloc(0),
    rawPixels: Buffer.alloc(TARGET_SIZE * TARGET_SIZE, 255),
    width: TARGET_SIZE,
    height: TARGET_SIZE,
  };
}

/** Synchronous normalise for a single cached image (blank-partner edge case). */
function normaliseFromCachedSync(cached: DecodedGreyWithBounds): NormalisedResult {
  if (!cached.bounds) return blankResultSync();
  const { top, bottom, left, right } = cached.bounds;
  const cropW = right - left + 1;
  const cropH = bottom - top + 1;
  const cropped = cropGreyPixels(cached.pixels, cached.width, left, top, cropW, cropH);

  const scale = Math.min(TARGET_SIZE / cropW, TARGET_SIZE / cropH);
  const scaledW = Math.max(1, Math.round(cropW * scale));
  const scaledH = Math.max(1, Math.round(cropH * scale));

  const resized = bicubicResize(cropped, cropW, cropH, scaledW, scaledH);
  return {
    pngBuffer: Buffer.alloc(0),
    rawPixels: padToTarget(resized, scaledW, scaledH, TARGET_SIZE, 255),
    width: TARGET_SIZE,
    height: TARGET_SIZE,
  };
}

/**
 * Like normalisePair, but accepts pre-decoded data for BOTH source (A)
 * and target (B), eliminating all sharp calls from the hot loop.
 *
 * Pure JS: crops from raw pixel buffers, bicubic resize via Catmull-Rom,
 * pad into 48x48. Fully synchronous (no native calls, no thread pool).
 * Returns raw pixels only (pngBuffer is empty since computeSsim ignores it).
 */
export function normalisePairCached(
  cachedA: DecodedGreyWithBounds,
  cachedB: DecodedGreyWithBounds,
): [NormalisedResult, NormalisedResult] {
  const boundsA = cachedA.bounds;
  const boundsB = cachedB.bounds;

  if (!boundsA && !boundsB) {
    return [blankResultSync(), blankResultSync()];
  }
  if (!boundsA) {
    return [blankResultSync(), normaliseFromCachedSync(cachedB)];
  }
  if (!boundsB) {
    return [normaliseFromCachedSync(cachedA), blankResultSync()];
  }

  const midA = cachedA.height / 2;
  const midB = cachedB.height / 2;

  const relTopA = boundsA.top - midA;
  const relBotA = boundsA.bottom - midA;
  const relTopB = boundsB.top - midB;
  const relBotB = boundsB.bottom - midB;

  const unionRelTop = Math.min(relTopA, relTopB);
  const unionRelBot = Math.max(relBotA, relBotB);

  const cropTopA = Math.max(0, Math.floor(midA + unionRelTop));
  const cropTopB = Math.max(0, Math.floor(midB + unionRelTop));
  const cropBotA = Math.min(cachedA.height - 1, Math.ceil(midA + unionRelBot));
  const cropBotB = Math.min(cachedB.height - 1, Math.ceil(midB + unionRelBot));

  const cropH = Math.max(cropBotA - cropTopA + 1, cropBotB - cropTopB + 1);

  const cropWA = boundsA.right - boundsA.left + 1;
  const cropWB = boundsB.right - boundsB.left + 1;

  // Crop from raw pixel buffers in pure JS (no sharp)
  const croppedA = cropGreyPixels(cachedA.pixels, cachedA.width, boundsA.left, cropTopA, cropWA, cropH);
  const croppedB = cropGreyPixels(cachedB.pixels, cachedB.width, boundsB.left, cropTopB, cropWB, cropH);

  const maxW = Math.max(cropWA, cropWB);
  const scale = Math.min(TARGET_SIZE / maxW, TARGET_SIZE / cropH);

  function applyScale(croppedPixels: Buffer, cropW: number): NormalisedResult {
    const scaledW = Math.max(1, Math.round(cropW * scale));
    const scaledH = Math.max(1, Math.round(cropH * scale));
    const resized = bicubicResize(croppedPixels, cropW, cropH, scaledW, scaledH);
    return {
      pngBuffer: Buffer.alloc(0),
      rawPixels: padToTarget(resized, scaledW, scaledH, TARGET_SIZE, 255),
      width: TARGET_SIZE,
      height: TARGET_SIZE,
    };
  }

  return [applyScale(croppedA, cropWA), applyScale(croppedB, cropWB)];
}

/** Crop a rectangle from a single-channel greyscale pixel buffer. */
function cropGreyPixels(
  pixels: Buffer,
  srcWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
): Buffer {
  const out = Buffer.allocUnsafe(width * height);
  for (let y = 0; y < height; y++) {
    const srcOffset = (top + y) * srcWidth + left;
    const dstOffset = y * width;
    pixels.copy(out, dstOffset, srcOffset, srcOffset + width);
  }
  return out;
}

/**
 * Fraction of ink (non-white) pixels in a single-channel greyscale buffer.
 * Ink = any pixel whose value is below (255 - threshold).
 */
export function inkCoverage(rawPixels: Buffer, threshold = 10): number {
  const cutoff = 255 - threshold;
  let inkCount = 0;
  for (let i = 0; i < rawPixels.length; i++) {
    if (rawPixels[i]! < cutoff) inkCount++;
  }
  return inkCount / rawPixels.length;
}

/**
 * Extract ink width from a pre-decoded image with bounds.
 * Returns null if the image is blank (no ink bounds).
 */
export function getInkWidth(cached: DecodedGreyWithBounds): number | null {
  if (!cached.bounds) return null;
  return cached.bounds.right - cached.bounds.left + 1;
}

/**
 * Extract ink height from a pre-decoded image with bounds.
 * Returns null if the image is blank (no ink bounds).
 */
export function getInkHeight(cached: DecodedGreyWithBounds): number | null {
  if (!cached.bounds) return null;
  return cached.bounds.bottom - cached.bounds.top + 1;
}

