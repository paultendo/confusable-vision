/**
 * render-hero-oy.ts -- Hero image: "oy" vs ѹ in 5 fonts
 * Usage: npx tsx scripts/render-hero-oy.ts
 */
import fs from 'node:fs';
import { createCanvas } from 'canvas';
import { initFonts } from '../src/fonts.js';

initFonts();

const FONTS = ['Helvetica', 'Arial Unicode MS', 'Geneva', 'Iowan Old Style', 'Charter'];
const GLYPH_SIZE = 64;
const ROW_H = 100;
const COL_W = 180;
const LABEL_W = 200;
const CANVAS_W = LABEL_W + COL_W * 2 + 40;
const HEADER_H = 56;
const CANVAS_H = HEADER_H + ROW_H * FONTS.length + 16;

const canvas = createCanvas(CANVAS_W, CANVAS_H);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

ctx.fillStyle = '#222222';
ctx.font = 'bold 20px "Helvetica Neue"';
ctx.textBaseline = 'middle';
ctx.textAlign = 'left';
ctx.fillText('"oy" vs \u0479 (U+0479, Cyrillic uk)', 16, HEADER_H / 2);

ctx.fillStyle = '#f0f0f0';
ctx.fillRect(0, HEADER_H - 14, CANVAS_W, 28);
ctx.fillStyle = '#666666';
ctx.font = 'bold 13px "Helvetica Neue"';
ctx.textAlign = 'center';
ctx.fillText('Font', LABEL_W / 2, HEADER_H);
ctx.fillText('"oy" (Latin bigram)', LABEL_W + COL_W / 2, HEADER_H);
ctx.fillText('\u0479 (Cyrillic uk)', LABEL_W + COL_W + COL_W / 2, HEADER_H);

const startY = HEADER_H + 20;
const L2: Record<string, number> = {
  'Helvetica': 0.000, 'Arial Unicode MS': 0.033, 'Geneva': 0.093,
  'Iowan Old Style': 1.162, 'Charter': 1.173,
};

for (let i = 0; i < FONTS.length; i++) {
  const font = FONTS[i]!;
  const y = startY + i * ROW_H;
  const centerY = y + ROW_H / 2;

  if (i % 2 === 1) {
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(0, y, CANVAS_W, ROW_H);
  }

  ctx.fillStyle = '#333333';
  ctx.font = '14px "Helvetica Neue"';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(font, 16, centerY - 10);
  ctx.fillStyle = '#888888';
  ctx.font = '12px "Menlo"';
  ctx.fillText('L2 = ' + L2[font]!.toFixed(3), 16, centerY + 10);

  ctx.fillStyle = '#000000';
  ctx.font = `${GLYPH_SIZE}px "${font}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('oy', LABEL_W + COL_W / 2, centerY);
  ctx.fillText('\u0479', LABEL_W + COL_W + COL_W / 2, centerY);
}

ctx.strokeStyle = '#e0e0e0';
ctx.lineWidth = 1;
ctx.beginPath();
ctx.moveTo(LABEL_W, startY);
ctx.lineTo(LABEL_W, startY + FONTS.length * ROW_H);
ctx.moveTo(LABEL_W + COL_W, startY);
ctx.lineTo(LABEL_W + COL_W, startY + FONTS.length * ROW_H);
ctx.stroke();

const buf = canvas.toBuffer('image/png');
fs.writeFileSync('data/output/oy-uk-hero.png', buf);
console.log('Written: data/output/oy-uk-hero.png (' + (buf.length / 1024).toFixed(0) + ' KB)');
