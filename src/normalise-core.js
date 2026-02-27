/**
 * Pure JS normalisation functions for single-channel greyscale images.
 * No TypeScript, no sharp, no native dependencies.
 *
 * Extracted from normalise-image.ts so worker threads can import directly.
 * Type definitions in normalise-core.d.ts.
 */

const TARGET_SIZE = 48;

/** Catmull-Rom basis function (a = -0.5). */
function catmullRom(t) {
  const abs = Math.abs(t);
  if (abs <= 1) return 1.5 * abs * abs * abs - 2.5 * abs * abs + 1;
  if (abs <= 2) return -0.5 * abs * abs * abs + 2.5 * abs * abs - 4 * abs + 2;
  return 0;
}

/**
 * Resize a single-channel greyscale buffer using Catmull-Rom interpolation.
 * Uses centre-pixel mapping: (i + 0.5) * srcDim / dstDim - 0.5.
 * 4x4 neighbourhood sampling, output clamped to [0, 255].
 */
function bicubicResize(src, srcW, srcH, dstW, dstH) {
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
        sum += src[y * srcW + sx] * w;
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
        sum += tmp[sy * dstW + x] * w;
        wSum += w;
      }
      dst[y * dstW + x] = Math.min(255, Math.max(0, Math.round(sum / wSum)));
    }
  }

  return dst;
}

/**
 * Centre src in a targetSize x targetSize canvas filled with bgValue.
 * Row-level Buffer.copy for speed.
 */
function padToTarget(src, srcW, srcH, targetSize, bgValue) {
  const out = Buffer.alloc(targetSize * targetSize, bgValue);
  const offX = Math.floor((targetSize - srcW) / 2);
  const offY = Math.floor((targetSize - srcH) / 2);
  for (let y = 0; y < srcH; y++) {
    src.copy(out, (offY + y) * targetSize + offX, y * srcW, y * srcW + srcW);
  }
  return out;
}

/** Crop a rectangle from a single-channel greyscale pixel buffer. */
function cropGreyPixels(pixels, srcWidth, left, top, width, height) {
  const out = Buffer.allocUnsafe(width * height);
  for (let y = 0; y < height; y++) {
    const srcOffset = (top + y) * srcWidth + left;
    const dstOffset = y * width;
    pixels.copy(out, dstOffset, srcOffset, srcOffset + width);
  }
  return out;
}

/** Synchronous blank result: 48x48 white buffer. */
function blankResultSync() {
  return {
    pngBuffer: Buffer.alloc(0),
    rawPixels: Buffer.alloc(TARGET_SIZE * TARGET_SIZE, 255),
    width: TARGET_SIZE,
    height: TARGET_SIZE,
  };
}

/** Synchronous normalise for a single cached image (blank-partner edge case). */
function normaliseFromCachedSync(cached) {
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
 * Normalise a pair of pre-decoded greyscale images.
 * Pure JS: crops, bicubic resize via Catmull-Rom, pad into 48x48.
 * Fully synchronous (no native calls, no thread pool).
 */
export function normalisePairCached(cachedA, cachedB) {
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

  const croppedA = cropGreyPixels(cachedA.pixels, cachedA.width, boundsA.left, cropTopA, cropWA, cropH);
  const croppedB = cropGreyPixels(cachedB.pixels, cachedB.width, boundsB.left, cropTopB, cropWB, cropH);

  const maxW = Math.max(cropWA, cropWB);
  const scale = Math.min(TARGET_SIZE / maxW, TARGET_SIZE / cropH);

  function applyScale(croppedPixels, cropW) {
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

/**
 * Fraction of ink (non-white) pixels in a single-channel greyscale buffer.
 * Ink = any pixel whose value is below (255 - threshold).
 */
export function inkCoverage(rawPixels, threshold = 10) {
  const cutoff = 255 - threshold;
  let inkCount = 0;
  for (let i = 0; i < rawPixels.length; i++) {
    if (rawPixels[i] < cutoff) inkCount++;
  }
  return inkCount / rawPixels.length;
}

/**
 * Find the ink bounding box in a greyscale image.
 * Ink = any pixel darker than (255 - threshold). Returns null for blank images.
 */
export function findInkBounds(pixels, width, height, threshold = 10) {
  const cutoff = 255 - threshold;
  let top = height, bottom = 0, left = width, right = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] < cutoff) {
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
 * Decode a PNG buffer to greyscale pixels + dimensions using fast-png (pure JS).
 * Converts RGBA/RGB/greyscale to single-channel greyscale.
 */
export function decodePngToGrey(decode, pngBuffer) {
  const d = decode(pngBuffer);
  const pixelCount = d.width * d.height;
  const grey = Buffer.allocUnsafe(pixelCount);
  const ch = d.channels;
  if (ch === 1) {
    // Already greyscale
    grey.set(d.data);
  } else if (ch === 2) {
    // Greyscale + alpha
    for (let i = 0; i < pixelCount; i++) {
      grey[i] = d.data[i * 2];
    }
  } else {
    // RGB or RGBA: ITU-R BT.709 luma
    for (let i = 0; i < pixelCount; i++) {
      const off = i * ch;
      grey[i] = Math.round(0.2126 * d.data[off] + 0.7152 * d.data[off + 1] + 0.0722 * d.data[off + 2]);
    }
  }
  return { pixels: grey, width: d.width, height: d.height };
}

/**
 * Decode a PNG and find its ink bounds in one pass (pure JS, no sharp).
 */
export function decodeAndFindBoundsJS(decode, pngBuffer) {
  const { pixels, width, height } = decodePngToGrey(decode, pngBuffer);
  const bounds = findInkBounds(pixels, width, height);
  return { pixels, width, height, bounds };
}

/**
 * Extract ink width from decoded image with bounds.
 */
export function getInkWidthFromBounds(bounds) {
  if (!bounds) return null;
  return bounds.right - bounds.left + 1;
}
