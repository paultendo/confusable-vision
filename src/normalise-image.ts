import sharp from 'sharp';
import type { NormalisedResult } from './types.js';

const TARGET_SIZE = 48;

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
