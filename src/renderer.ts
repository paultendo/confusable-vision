import { createCanvas } from 'canvas';
import type { RenderResult } from './types.js';

const CANVAS_SIZE = 64;
const FONT_FILL_RATIO = 0.75; // Fill ~75% of canvas height

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
  const blankPixels = getBlankPixels(ctx);
  const replacementPixels = renderToPixels(ctx, '\uFFFD');

  if (buffersEqual(targetPixels, blankPixels)) {
    return null;
  }
  if (buffersEqual(targetPixels, replacementPixels)) {
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

function buffersEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return a.compare(b) === 0;
}
