import { createCanvas } from 'canvas';
import type { RenderResult } from './types.js';

const CANVAS_SIZE = 64;
const FONT_FILL_RATIO = 0.75; // Fill ~75% of canvas height

// Wider canvas for multi-character sequences (e.g. "rn", "WW").
// 128px fits the widest 2-char combo at 48px with room to spare.
// normaliseImage trims whitespace anyway, so extra width is harmless.
const SEQ_CANVAS_WIDTH = 128;
const SEQ_CANVAS_HEIGHT = 64;

// Cache blank and FFFD reference renders per font to avoid recomputing
// them on every renderCharacter call (~2/3 render time savings).
const blankCache = new Map<string, Buffer>();
const fffdCache = new Map<string, Buffer>();

// Separate blank cache for the wider sequence canvas (128x64 vs 64x64).
const blankSeqCache = new Map<string, Buffer>();

/**
 * Render a single character on a white background in the given font.
 * Returns PNG buffer + raw pixels, or null if the font lacks this glyph (.notdef).
 *
 * Raw pixels are included so callers can detect silent OS font fallback
 * by comparing against known fallback font renders.
 */
export function renderCharacter(
  char: string,
  fontFamily: string,
): RenderResult | null {
  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Calculate font size to fill canvas
  const fontSize = Math.round(CANVAS_SIZE * FONT_FILL_RATIO);
  ctx.font = `${fontSize}px "${fontFamily}"`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  // .notdef detection: compare target render against blank + replacement char
  const targetPixels = renderToPixels(ctx, char);

  // Use cached blank/FFFD for this font, or render and cache them
  let blankPixels = blankCache.get(fontFamily);
  if (!blankPixels) {
    blankPixels = getBlankPixels(ctx);
    blankCache.set(fontFamily, blankPixels);
  }

  let fffdPixels = fffdCache.get(fontFamily);
  if (!fffdPixels) {
    fffdPixels = renderToPixels(ctx, '\uFFFD');
    fffdCache.set(fontFamily, fffdPixels);
  }

  if (buffersEqual(targetPixels, blankPixels)) {
    return null;
  }
  if (buffersEqual(targetPixels, fffdPixels)) {
    return null;
  }
  if (isLastResortRender(targetPixels, CANVAS_SIZE)) {
    return null;
  }

  // Re-render the actual character for PNG output
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.fillStyle = '#000000';
  ctx.fillText(char, CANVAS_SIZE / 2, CANVAS_SIZE / 2);

  return {
    pngBuffer: canvas.toBuffer('image/png'),
    rawPixels: targetPixels,
  };
}

/**
 * Detect if a render was produced by OS font fallback rather than the requested font.
 * Compares raw pixel data against pre-rendered reference images from known fallback fonts.
 *
 * Returns the name of the matching fallback font, or null if the render is native.
 */
export function detectFallback(
  rawPixels: Buffer,
  fallbackRenders: Map<string, Buffer>,
): string | null {
  for (const [fontName, fbPixels] of fallbackRenders) {
    if (buffersEqual(rawPixels, fbPixels)) {
      return fontName;
    }
  }
  return null;
}

/**
 * Render a multi-character string (e.g. "rn") on a white background.
 * Uses a 128x64 canvas with the same fixed 48px font as renderCharacter()
 * so source and target renders are at identical scale.
 * Returns PNG buffer + raw pixels, or null if nothing rendered.
 *
 * .notdef detection is simplified: just check for a blank canvas.
 */
export function renderSequence(
  sequence: string,
  fontFamily: string,
): RenderResult | null {
  const canvas = createCanvas(SEQ_CANVAS_WIDTH, SEQ_CANVAS_HEIGHT);
  const ctx = canvas.getContext('2d');

  // Fixed font size -- same as renderCharacter() uses
  const fontSize = Math.round(CANVAS_SIZE * FONT_FILL_RATIO);
  ctx.font = `${fontSize}px "${fontFamily}"`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  // Render
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SEQ_CANVAS_WIDTH, SEQ_CANVAS_HEIGHT);
  ctx.fillStyle = '#000000';
  ctx.fillText(sequence, SEQ_CANVAS_WIDTH / 2, SEQ_CANVAS_HEIGHT / 2);

  const pixels = Buffer.from(
    ctx.getImageData(0, 0, SEQ_CANVAS_WIDTH, SEQ_CANVAS_HEIGHT).data,
  );
  // Capture PNG now, before blank-cache generation can overwrite the canvas
  const pngBuffer = canvas.toBuffer('image/png');

  // Blank detection using the sequence-sized blank cache
  let blankPixels = blankSeqCache.get(fontFamily);
  if (!blankPixels) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SEQ_CANVAS_WIDTH, SEQ_CANVAS_HEIGHT);
    blankPixels = Buffer.from(
      ctx.getImageData(0, 0, SEQ_CANVAS_WIDTH, SEQ_CANVAS_HEIGHT).data,
    );
    blankSeqCache.set(fontFamily, blankPixels);
  }
  if (buffersEqual(pixels, blankPixels)) {
    return null;
  }

  return {
    pngBuffer,
    rawPixels: pixels,
  };
}

function renderToPixels(
  ctx: CanvasRenderingContext2D,
  char: string,
): Buffer {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.fillStyle = '#000000';
  ctx.fillText(char, CANVAS_SIZE / 2, CANVAS_SIZE / 2);
  return Buffer.from(ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data);
}

function getBlankPixels(
  ctx: CanvasRenderingContext2D,
): Buffer {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  return Buffer.from(ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data);
}

/**
 * Detect macOS "Last Resort" font rendering. When no installed font contains
 * a glyph, macOS renders the codepoint as hex digits inside a rectangular
 * bordered box (e.g. "2D4F" in a box for U+2D4F). Real character glyphs
 * virtually never have a solid rectangular border on all four edges.
 *
 * Algorithm: find the ink bounding box, then check whether all four edges
 * of that bounding box are mostly-dark pixels (the border lines).
 */
function isLastResortRender(pixels: Buffer, canvasSize: number): boolean {
  // R channel at (x, y). Lower value = darker pixel.
  const r = (x: number, y: number) => pixels[(y * canvasSize + x) * 4]!;

  // Find bounding box of ink (anything darker than near-white)
  let top = canvasSize;
  let bottom = 0;
  let left = canvasSize;
  let right = 0;
  for (let y = 0; y < canvasSize; y++) {
    for (let x = 0; x < canvasSize; x++) {
      if (r(x, y) < 200) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }

  const bboxW = right - left + 1;
  const bboxH = bottom - top + 1;

  // Last Resort boxes are relatively large and roughly square
  if (bboxW < 15 || bboxH < 15) return false;

  // Check border continuity on all 4 edges of the bounding box
  let topDark = 0;
  let bottomDark = 0;
  let leftDark = 0;
  let rightDark = 0;

  for (let x = left; x <= right; x++) {
    if (r(x, top) < 200) topDark++;
    if (r(x, bottom) < 200) bottomDark++;
  }
  for (let y = top; y <= bottom; y++) {
    if (r(left, y) < 200) leftDark++;
    if (r(right, y) < 200) rightDark++;
  }

  const threshold = 0.75;
  return (
    topDark / bboxW > threshold &&
    bottomDark / bboxW > threshold &&
    leftDark / bboxH > threshold &&
    rightDark / bboxH > threshold
  );
}

function buffersEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return a.compare(b) === 0;
}
