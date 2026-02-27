import { ssim } from 'ssim.js';
import { ssimGrey } from 'ssim-grey';
import sharp from 'sharp';
import type { NormalisedResult, PairComparison } from './types.js';

/**
 * Compute SSIM between two normalised greyscale images.
 * ssim.js requires RGBA input, so we expand greyscale to RGBA.
 * Used by validation scripts that need the reference ssim.js path.
 */
export function computeSsim(img1: NormalisedResult, img2: NormalisedResult): number {
  const rgba1 = greyToRgba(img1.rawPixels);
  const rgba2 = greyToRgba(img2.rawPixels);

  const result = ssim(
    { data: rgba1, width: img1.width, height: img1.height },
    { data: rgba2, width: img2.width, height: img2.height },
  );

  return result.mssim;
}

/**
 * Compute SSIM directly on greyscale buffers (no RGBA expansion).
 * Drop-in replacement for computeSsim in hot loops.
 */
export function computeSsimFast(img1: NormalisedResult, img2: NormalisedResult): number {
  return ssimGrey(img1.rawPixels, img2.rawPixels, img1.width, img1.height);
}

/**
 * Compute a 64-bit perceptual hash from a greyscale image.
 * Steps: resize to 8x8, compute mean, set bits where pixel > mean.
 */
export async function computePHash(
  greyBuffer: Buffer,
  width: number,
  height: number,
): Promise<bigint> {
  // Resize to 8x8 greyscale
  const tiny = await sharp(greyBuffer, {
    raw: { width, height, channels: 1 },
  })
    .resize(8, 8, { fit: 'fill' })
    .raw()
    .toBuffer();

  // Compute mean pixel value
  let sum = 0;
  for (let i = 0; i < 64; i++) {
    sum += tiny[i]!;
  }
  const mean = sum / 64;

  // Build 64-bit hash
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (tiny[i]! > mean) {
      hash |= 1n << BigInt(63 - i);
    }
  }

  return hash;
}

/** Hamming distance between two 64-bit hashes */
function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

/** Similarity score from two pHash values (0-1, where 1 is identical) */
export function pHashSimilarity(a: bigint, b: bigint): number {
  return 1 - hammingDistance(a, b) / 64;
}

/**
 * Compare two normalised images, returning SSIM and pHash similarity.
 * Returns null if either input is null.
 */
export async function compareImages(
  img1: NormalisedResult | null,
  img2: NormalisedResult | null,
): Promise<PairComparison | null> {
  if (!img1 || !img2) return null;

  const ssimScore = computeSsim(img1, img2);

  const hash1 = await computePHash(img1.rawPixels, img1.width, img1.height);
  const hash2 = await computePHash(img2.rawPixels, img2.width, img2.height);
  const pHashScore = pHashSimilarity(hash1, hash2);

  return { ssim: ssimScore, pHash: pHashScore };
}

/** Expand single-channel greyscale buffer to RGBA (R=G=B=grey, A=255) */
function greyToRgba(grey: Buffer): Uint8Array {
  const rgba = new Uint8Array(grey.length * 4);
  for (let i = 0; i < grey.length; i++) {
    const v = grey[i]!;
    const offset = i * 4;
    rgba[offset] = v;
    rgba[offset + 1] = v;
    rgba[offset + 2] = v;
    rgba[offset + 3] = 255;
  }
  return rgba;
}
