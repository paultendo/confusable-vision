/**
 * render-m2b-blog-image.ts
 *
 * Generates a comparison image for the M2b blog post, showing selected
 * CJK/Hangul/logographic confusable pairs side by side with their Latin
 * targets. Same visual format as the M2 novel-discoveries.png.
 *
 * Output: data/output/m2b-blog-pairs.png
 *
 * Usage:
 *   npx tsx scripts/render-m2b-blog-image.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas } from 'canvas';
import { initFonts, queryFontCoverage, discoverFontForCodepoint } from '../src/fonts.js';
import { renderCharacter } from '../src/renderer.js';
import { normaliseImage } from '../src/normalise-image.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'data/output/m2b-blog-pairs.png');

// Top 3 vertical strokes + top 3 circles
const PAIRS: Array<{
  source: string;
  sourceLabel: string;
  target: string;
  ssim: string;
  fontHint: string;
}> = [
  // === Top 3 vertical strokes ===
  {
    source: '\u3021',        // 〡 Hangzhou Numeral One
    sourceLabel: 'U+3021 Hangzhou One vs l',
    target: 'l',
    ssim: '0.928',
    fontHint: 'Heiti SC',
  },
  {
    source: '\u4E28',        // 丨 CJK Vertical Stroke
    sourceLabel: 'U+4E28 CJK Stroke vs l',
    target: 'l',
    ssim: '0.879',
    fontHint: 'Heiti SC',
  },
  {
    source: '\u1175',        // ᅵ Hangul Jungseong I
    sourceLabel: 'U+1175 Hangul Jungseong I vs l',
    target: 'l',
    ssim: '0.847',
    fontHint: 'Apple SD Gothic Neo',
  },
  // === Top 3 circles ===
  {
    source: '\u{130C9}',    // 𓃉 U+130C9 Egyptian Hieroglyph
    sourceLabel: 'U+130C9 Egyptian Hieroglyph vs o',
    target: 'o',
    ssim: '0.790',
    fontHint: 'Noto Sans Egyptian Hieroglyphs',
  },
  {
    source: '\u3147',        // ㅇ Hangul Ieung
    sourceLabel: 'U+3147 Hangul Ieung vs o',
    target: 'o',
    ssim: '0.738',
    fontHint: 'Apple SD Gothic Neo',
  },
  {
    source: '\u110B',        // ᄋ Hangul Choseong Ieung
    sourceLabel: 'U+110B Hangul Choseong Ieung vs o',
    target: 'o',
    ssim: '0.737',
    fontHint: 'Apple SD Gothic Neo',
  },
];

const COLS = 3;
const ROWS = 2;
const CELL_W = 432;
const CELL_H = 270;
const GLYPH_SIZE = 160;
const GAP = 12;
const LABEL_H = 24;
const CAPTION_H = 20;
const PADDING = 16;

async function main() {
  console.log('=== render-m2b-blog-image ===\n');

  const fonts = initFonts();
  const availableFonts = fonts.filter(f => f.available);
  const standardFonts = availableFonts.filter(f => f.category === 'standard');

  const imgW = COLS * CELL_W + (COLS + 1) * PADDING;
  const imgH = ROWS * CELL_H + (ROWS + 1) * PADDING;

  const canvas = createCanvas(imgW, imgH);
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, imgW, imgH);

  for (let i = 0; i < PAIRS.length; i++) {
    const pair = PAIRS[i]!;
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = PADDING + col * (CELL_W + PADDING);
    const y = PADDING + row * (CELL_H + PADDING);

    // Render source character
    const srcCp = pair.source.codePointAt(0)!;
    let srcFont = pair.fontHint;

    // Try the hint font first, fall back to coverage query
    let srcResult = renderCharacter(pair.source, srcFont);
    if (!srcResult) {
      const covered = queryFontCoverage(srcCp, availableFonts);
      if (covered.length > 0) {
        srcFont = covered[0]!.family;
        srcResult = renderCharacter(pair.source, srcFont);
      }
      if (!srcResult) {
        const discovered = discoverFontForCodepoint(srcCp);
        if (discovered) {
          srcFont = discovered.family;
          srcResult = renderCharacter(pair.source, srcFont);
        }
      }
    }

    // Render target in a standard font that looks good
    // Try to match the source font first for same-font comparison
    let tgtFont = standardFonts.find(f => f.family === srcFont)?.family ?? 'Helvetica';
    let tgtResult = renderCharacter(pair.target, tgtFont);
    if (!tgtResult) {
      tgtFont = 'Arial';
      tgtResult = renderCharacter(pair.target, tgtFont);
    }

    if (!srcResult || !tgtResult) {
      console.log(`  Skipping pair ${i}: could not render (src=${!!srcResult}, tgt=${!!tgtResult})`);
      continue;
    }

    // Normalise both to greyscale
    const srcNorm = await normaliseImage(srcResult.pngBuffer);
    const tgtNorm = await normaliseImage(tgtResult.pngBuffer);

    // Upscale to GLYPH_SIZE
    const srcUpscaled = await sharp(srcNorm.pngBuffer)
      .resize(GLYPH_SIZE, GLYPH_SIZE, { kernel: 'nearest' })
      .png()
      .toBuffer();
    const tgtUpscaled = await sharp(tgtNorm.pngBuffer)
      .resize(GLYPH_SIZE, GLYPH_SIZE, { kernel: 'nearest' })
      .png()
      .toBuffer();

    // Draw label
    ctx.fillStyle = '#333333';
    ctx.font = '14px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(pair.sourceLabel, x + CELL_W / 2, y + LABEL_H - 4);

    // Draw glyphs side by side
    const glyphY = y + LABEL_H + 4;
    const totalGlyphW = GLYPH_SIZE * 2 + GAP;
    const glyphX = x + (CELL_W - totalGlyphW) / 2;

    // We need to composite the upscaled PNGs onto the canvas
    // Since node-canvas can load images, use that
    const { loadImage } = await import('canvas');
    const srcImg = await loadImage(srcUpscaled);
    const tgtImg = await loadImage(tgtUpscaled);

    ctx.drawImage(srcImg, glyphX, glyphY, GLYPH_SIZE, GLYPH_SIZE);
    ctx.drawImage(tgtImg, glyphX + GLYPH_SIZE + GAP, glyphY, GLYPH_SIZE, GLYPH_SIZE);

    // Draw caption
    ctx.fillStyle = '#666666';
    ctx.font = '13px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      `SSIM ${pair.ssim} (${srcFont})`,
      x + CELL_W / 2,
      glyphY + GLYPH_SIZE + CAPTION_H,
    );

    console.log(`  [${i + 1}/${PAIRS.length}] ${pair.sourceLabel} -- rendered in ${srcFont}`);
  }

  // Write output
  const pngBuffer = canvas.toBuffer('image/png');
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, pngBuffer);
  console.log(`\nWritten to: ${OUTPUT_PATH} (${(pngBuffer.length / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
