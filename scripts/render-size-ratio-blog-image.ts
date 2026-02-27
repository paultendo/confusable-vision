/**
 * render-size-ratio-blog-image.ts
 *
 * Generates a comparison image for the size-ratio blog post. Shows selected
 * pairs at their natural rendering size (left) and after normalisation (right),
 * illustrating how normalisation hides size differences that would be obvious
 * in running text.
 *
 * Layout: 3 columns x 2 rows
 *   Row 1: Extreme cases (丄/l 8.8x, ₄/4 2.1x height, ḻ/l 2.8x)
 *   Row 2: Clean comparisons for contrast (pairs with ~1.0x ratio + high SSIM)
 *
 * Each cell shows: raw 64x64 renders (natural size) on the left,
 * normalised 48x48 renders (scaled up) on the right, with ratio annotation.
 *
 * Output: data/output/size-ratio-blog.png
 *
 * Usage:
 *   npx tsx scripts/render-size-ratio-blog-image.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas, loadImage } from 'canvas';
import { initFonts, discoverFontForCodepoint } from '../src/fonts.js';
import { renderCharacter } from '../src/renderer.js';
import { normaliseImage } from '../src/normalise-image.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'data/output/size-ratio-blog.png');

interface PairSpec {
  source: string;
  sourceLabel: string;
  target: string;
  font: string;
  ssim: string;
  widthRatio: string;
  heightRatio: string;
  flagged: boolean;
}

// Row 1: Flagged pairs (size difference hides in normalisation)
// Row 2: Clean pairs (similar size, genuine confusables)
const PAIRS: PairSpec[] = [
  // === Row 1: Flagged ===
  {
    source: '\u4E04',     // 丄
    sourceLabel: 'CJK 丄 vs Latin l',
    target: 'l',
    font: 'STSong',
    ssim: '0.852',
    widthRatio: '8.8x',
    heightRatio: '1.1x',
    flagged: true,
  },
  {
    source: '\u2084',     // ₄
    sourceLabel: 'Subscript ₄ vs Latin 4',
    target: '4',
    font: 'Helvetica',
    ssim: '0.936',
    widthRatio: '1.9x',
    heightRatio: '2.1x',
    flagged: true,
  },
  {
    source: '\u1E3B',     // ḻ
    sourceLabel: 'Latin ḻ vs Latin l',
    target: 'l',
    font: 'Thonburi',
    ssim: '0.926',
    widthRatio: '2.8x',
    heightRatio: '1.3x',
    flagged: true,
  },
  // === Row 2: Clean (similar size, genuine confusable) ===
  {
    source: '\u0430',     // а Cyrillic
    sourceLabel: 'Cyrillic а vs Latin a',
    target: 'a',
    font: 'Helvetica',
    ssim: '0.998',
    widthRatio: '1.0x',
    heightRatio: '1.0x',
    flagged: false,
  },
  {
    source: '\u03BF',     // ο Greek omicron
    sourceLabel: 'Greek ο vs Latin o',
    target: 'o',
    font: 'Helvetica',
    ssim: '0.998',
    widthRatio: '1.0x',
    heightRatio: '1.0x',
    flagged: false,
  },
  {
    source: '\u0455',     // ѕ Cyrillic es
    sourceLabel: 'Cyrillic ѕ vs Latin s',
    target: 's',
    font: 'Helvetica',
    ssim: '0.998',
    widthRatio: '1.0x',
    heightRatio: '1.0x',
    flagged: false,
  },
];

const COLS = 3;
const ROWS = 2;
const CELL_W = 480;
const CELL_H = 320;
const RAW_SIZE = 120;         // Display size for raw 64x64 renders
const NORM_SIZE = 120;        // Display size for normalised 48x48 renders
const GAP = 8;
const SECTION_GAP = 32;      // Gap between "raw" and "normalised" sections
const LABEL_H = 24;
const CAPTION_H = 20;
const PADDING = 16;
const ROW_LABEL_H = 28;

async function main() {
  console.log('=== render-size-ratio-blog-image ===\n');

  initFonts();

  const imgW = COLS * CELL_W + (COLS + 1) * PADDING;
  const imgH = ROWS * (CELL_H + ROW_LABEL_H) + (ROWS + 1) * PADDING;

  const canvas = createCanvas(imgW, imgH);
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, imgW, imgH);

  // Row labels
  const rowLabels = ['Size mismatch hidden by normalisation', 'Genuine confusables (similar natural size)'];

  for (let i = 0; i < PAIRS.length; i++) {
    const pair = PAIRS[i]!;
    const col = i % COLS;
    const row = Math.floor(i / COLS);

    const cellX = PADDING + col * (CELL_W + PADDING);
    const cellY = PADDING + row * (CELL_H + ROW_LABEL_H + PADDING);

    // Row label (only on first column)
    if (col === 0) {
      ctx.fillStyle = pair.flagged ? '#c0392b' : '#27ae60';
      ctx.font = 'bold 15px "Helvetica Neue", Helvetica, Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(rowLabels[row]!, cellX, cellY + 16);
    }

    const y = cellY + ROW_LABEL_H;

    // Render source
    let srcFont = pair.font;
    let srcResult = renderCharacter(pair.source, srcFont);
    if (!srcResult) {
      const cp = pair.source.codePointAt(0)!;
      discoverFontForCodepoint(cp);
      srcResult = renderCharacter(pair.source, srcFont);
    }

    // Render target
    let tgtResult = renderCharacter(pair.target, pair.font);
    if (!tgtResult) {
      tgtResult = renderCharacter(pair.target, 'Helvetica');
    }

    if (!srcResult || !tgtResult) {
      console.log(`  Skipping pair ${i}: could not render`);
      continue;
    }

    // Normalise both
    const srcNorm = await normaliseImage(srcResult.pngBuffer);
    const tgtNorm = await normaliseImage(tgtResult.pngBuffer);

    // Upscale raw renders (64x64 -> RAW_SIZE, nearest neighbour to preserve pixels)
    const srcRawUp = await sharp(srcResult.pngBuffer)
      .greyscale()
      .resize(RAW_SIZE, RAW_SIZE, { kernel: 'nearest' })
      .png()
      .toBuffer();
    const tgtRawUp = await sharp(tgtResult.pngBuffer)
      .greyscale()
      .resize(RAW_SIZE, RAW_SIZE, { kernel: 'nearest' })
      .png()
      .toBuffer();

    // Upscale normalised renders (48x48 -> NORM_SIZE)
    const srcNormUp = await sharp(srcNorm.pngBuffer)
      .resize(NORM_SIZE, NORM_SIZE, { kernel: 'nearest' })
      .png()
      .toBuffer();
    const tgtNormUp = await sharp(tgtNorm.pngBuffer)
      .resize(NORM_SIZE, NORM_SIZE, { kernel: 'nearest' })
      .png()
      .toBuffer();

    // Draw pair label
    ctx.fillStyle = '#333333';
    ctx.font = '13px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(pair.sourceLabel, cellX + CELL_W / 2, y + LABEL_H - 6);

    const glyphY = y + LABEL_H + 2;

    // Layout: [raw src] [raw tgt]  arrow  [norm src] [norm tgt]
    // Left section: raw renders
    const rawSectionW = RAW_SIZE * 2 + GAP;
    const normSectionW = NORM_SIZE * 2 + GAP;
    const totalW = rawSectionW + SECTION_GAP + normSectionW;
    const startX = cellX + (CELL_W - totalW) / 2;

    // Draw raw section label
    ctx.fillStyle = '#999999';
    ctx.font = '11px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Natural size', startX + rawSectionW / 2, glyphY - 2);

    // Draw normalised section label
    ctx.fillText('After normalisation', startX + rawSectionW + SECTION_GAP + normSectionW / 2, glyphY - 2);

    // Draw raw glyphs
    const srcRawImg = await loadImage(srcRawUp);
    const tgtRawImg = await loadImage(tgtRawUp);
    ctx.drawImage(srcRawImg, startX, glyphY + 2, RAW_SIZE, RAW_SIZE);
    ctx.drawImage(tgtRawImg, startX + RAW_SIZE + GAP, glyphY + 2, RAW_SIZE, RAW_SIZE);

    // Draw arrow between sections
    const arrowX = startX + rawSectionW + SECTION_GAP / 2;
    const arrowY = glyphY + RAW_SIZE / 2 + 2;
    ctx.fillStyle = '#999999';
    ctx.font = '20px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('\u2192', arrowX, arrowY + 6);

    // Draw normalised glyphs
    const normStartX = startX + rawSectionW + SECTION_GAP;
    const srcNormImg = await loadImage(srcNormUp);
    const tgtNormImg = await loadImage(tgtNormUp);
    ctx.drawImage(srcNormImg, normStartX, glyphY + 2, NORM_SIZE, NORM_SIZE);
    ctx.drawImage(tgtNormImg, normStartX + NORM_SIZE + GAP, glyphY + 2, NORM_SIZE, NORM_SIZE);

    // Draw border around normalised section if flagged (highlight the deception)
    if (pair.flagged) {
      ctx.strokeStyle = '#e74c3c44';
      ctx.lineWidth = 2;
      ctx.strokeRect(normStartX - 4, glyphY - 2, normSectionW + 8, NORM_SIZE + 8);
    }

    // Draw caption line 1: SSIM score
    const captionY = glyphY + RAW_SIZE + 18;
    ctx.fillStyle = '#666666';
    ctx.font = '12px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      `SSIM ${pair.ssim} (${srcFont})`,
      cellX + CELL_W / 2,
      captionY,
    );

    // Draw caption line 2: ratio
    const ratioColor = pair.flagged ? '#c0392b' : '#27ae60';
    ctx.fillStyle = ratioColor;
    ctx.font = 'bold 12px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillText(
      `Width ${pair.widthRatio}  Height ${pair.heightRatio}`,
      cellX + CELL_W / 2,
      captionY + 16,
    );

    console.log(`  [${i + 1}/${PAIRS.length}] ${pair.sourceLabel} -- ${srcFont}`);
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
