/**
 * render-din-noise.ts -- DIN Condensed "ti" vs accented characters (noise example)
 * Usage: npx tsx scripts/render-din-noise.ts
 */
import fs from 'node:fs';
import { createCanvas } from 'canvas';
import { initFonts } from '../src/fonts.js';

initFonts();

const PAIRS = [
  { target: '\u0169', cp: 'U+0169', name: 'u with tilde', l2: 1.332 },
  { target: '\u016D', cp: 'U+016D', name: 'u with breve', l2: 1.349 },
  { target: '\u016B', cp: 'U+016B', name: 'u with macron', l2: 1.393 },
  { target: '\u00FC', cp: 'U+00FC', name: 'u with diaeresis', l2: 1.408 },
  { target: '\u00F1', cp: 'U+00F1', name: 'n with tilde', l2: 1.638 },
  { target: '\u00FB', cp: 'U+00FB', name: 'u with circumflex', l2: 1.663 },
];

const FONT = 'DIN Condensed';
const GLYPH_SIZE = 56;
const ROW_H = 88;
const BIGRAM_W = 140;
const TARGET_W = 140;
const LABEL_W = 220;
const CANVAS_W = LABEL_W + BIGRAM_W + TARGET_W + 40;
const HEADER_H = 56;
const CANVAS_H = HEADER_H + ROW_H * PAIRS.length + 16;

const canvas = createCanvas(CANVAS_W, CANVAS_H);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

ctx.fillStyle = '#222222';
ctx.font = 'bold 18px "Helvetica Neue"';
ctx.textBaseline = 'middle';
ctx.textAlign = 'left';
ctx.fillText('DIN Condensed: "ti" vs accented characters', 16, HEADER_H / 2);

ctx.fillStyle = '#f0f0f0';
ctx.fillRect(0, HEADER_H - 14, CANVAS_W, 28);
ctx.fillStyle = '#666666';
ctx.font = 'bold 12px "Helvetica Neue"';
ctx.textAlign = 'center';
ctx.fillText('Target / L2', LABEL_W / 2, HEADER_H);
ctx.fillText('"ti"', LABEL_W + BIGRAM_W / 2, HEADER_H);
ctx.fillText('Target', LABEL_W + BIGRAM_W + TARGET_W / 2, HEADER_H);

const startY = HEADER_H + 20;
for (let i = 0; i < PAIRS.length; i++) {
  const p = PAIRS[i]!;
  const y = startY + i * ROW_H;
  const centerY = y + ROW_H / 2;

  if (i % 2 === 1) {
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(0, y, CANVAS_W, ROW_H);
  }

  ctx.fillStyle = '#333333';
  ctx.font = '13px "Helvetica Neue"';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.name + ' (' + p.cp + ')', 16, centerY - 10);
  ctx.fillStyle = '#888888';
  ctx.font = '11px "Menlo"';
  ctx.fillText('L2 = ' + p.l2.toFixed(3), 16, centerY + 10);

  ctx.fillStyle = '#000000';
  ctx.font = `${GLYPH_SIZE}px "${FONT}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ti', LABEL_W + BIGRAM_W / 2, centerY);
  ctx.fillText(p.target, LABEL_W + BIGRAM_W + TARGET_W / 2, centerY);
}

ctx.strokeStyle = '#e0e0e0';
ctx.lineWidth = 1;
ctx.beginPath();
ctx.moveTo(LABEL_W, startY);
ctx.lineTo(LABEL_W, startY + PAIRS.length * ROW_H);
ctx.moveTo(LABEL_W + BIGRAM_W, startY);
ctx.lineTo(LABEL_W + BIGRAM_W, startY + PAIRS.length * ROW_H);
ctx.stroke();

const buf = canvas.toBuffer('image/png');
fs.writeFileSync('data/output/din-condensed-noise.png', buf);
console.log('Written: data/output/din-condensed-noise.png (' + (buf.length / 1024).toFixed(0) + ' KB)');
