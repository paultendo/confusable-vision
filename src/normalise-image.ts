import sharp from 'sharp';
import type { NormalisedResult } from './types.js';
// @ts-ignore -- plain JS module, types inferred from usage
import { normalisePairCached as _normalisePairCached, inkCoverage as _inkCoverage } from './normalise-core.js';

const TARGET_SIZE = 48;

// Re-export pure JS functions from normalise-core.js (used by workers directly)
export const normalisePairCached: (
  cachedA: DecodedGreyWithBounds,
  cachedB: DecodedGreyWithBounds,
) => [NormalisedResult, NormalisedResult] = _normalisePairCached;

export const inkCoverage: (rawPixels: Buffer, threshold?: number) => number = _inkCoverage;

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

