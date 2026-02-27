/**
 * render-bpe-blog-image.ts
 *
 * Generates a visual showing how confusable characters fragment into
 * multi-byte BPE tokens, illustrating the Denial of Spend mechanism.
 *
 * Layout:
 *   Top: "not" as 1 token vs "поŧ" as 3 tokens (close-up)
 *   Bottom: full clause clean (9 tokens) vs flood (33+ tokens)
 *
 * Output: data/output/bpe-tokens-blog.png
 *
 * Usage:
 *   npx tsx scripts/render-bpe-blog-image.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, registerFont } from 'canvas';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'data/output/bpe-tokens-blog.png');

// Token definitions: each token is a string segment
interface Token {
  text: string;
  isConfusable: boolean; // true = confusable character (red), false = normal (green)
}

// "not" as a single token
const CLEAN_WORD: Token[] = [
  { text: 'not', isConfusable: false },
];

// "поŧ" as 3 tokens (each confusable char is its own token)
const FLOOD_WORD: Token[] = [
  { text: 'п', isConfusable: true },
  { text: 'о', isConfusable: true },
  { text: 'ŧ', isConfusable: true },
];

// Clean clause tokens (approximate BPE for GPT-4 class)
const CLEAN_CLAUSE: Token[] = [
  { text: 'shall', isConfusable: false },
  { text: ' not', isConfusable: false },
  { text: ' be', isConfusable: false },
  { text: ' limited', isConfusable: false },
  { text: ' to', isConfusable: false },
  { text: ' the', isConfusable: false },
  { text: ' total', isConfusable: false },
  { text: ' fees', isConfusable: false },
  { text: ' paid', isConfusable: false },
];

// Flood clause tokens: each confusable char is its own token, ASCII chars merge
const FLOOD_CLAUSE: Token[] = [
  // ᵴɦaꟾꟾ
  { text: 'ᵴ', isConfusable: true },
  { text: 'ɦ', isConfusable: true },
  { text: 'a', isConfusable: false },
  { text: 'ꟾ', isConfusable: true },
  { text: 'ꟾ', isConfusable: true },
  // space + пoŧ
  { text: ' ', isConfusable: false },
  { text: 'п', isConfusable: true },
  { text: 'o', isConfusable: false },
  { text: 'ŧ', isConfusable: true },
  // space + 𐑇e
  { text: ' ', isConfusable: false },
  { text: '𐑇', isConfusable: true },
  { text: 'e', isConfusable: false },
  // space + ꟾİmİŧeꝱ
  { text: ' ', isConfusable: false },
  { text: 'ꟾ', isConfusable: true },
  { text: 'İ', isConfusable: true },
  { text: 'm', isConfusable: false },
  { text: 'İ', isConfusable: true },
  { text: 'ŧ', isConfusable: true },
  { text: 'e', isConfusable: false },
  { text: 'ꝱ', isConfusable: true },
  // space + ŧo
  { text: ' ', isConfusable: false },
  { text: 'ŧ', isConfusable: true },
  { text: 'o', isConfusable: false },
  // space + ŧɦe
  { text: ' ', isConfusable: false },
  { text: 'ŧ', isConfusable: true },
  { text: 'ɦ', isConfusable: true },
  { text: 'e', isConfusable: false },
  // space + ŧoŧaꟾ
  { text: ' ', isConfusable: false },
  { text: 'ŧ', isConfusable: true },
  { text: 'o', isConfusable: false },
  { text: 'ŧ', isConfusable: true },
  { text: 'a', isConfusable: false },
  { text: 'ꟾ', isConfusable: true },
  // space + ƭeeᵴ
  { text: ' ', isConfusable: false },
  { text: 'ƭ', isConfusable: true },
  { text: 'ee', isConfusable: false },
  { text: 'ᵴ', isConfusable: true },
  // space + ᶈaİꝱ
  { text: ' ', isConfusable: false },
  { text: 'ᶈ', isConfusable: true },
  { text: 'a', isConfusable: false },
  { text: 'İ', isConfusable: true },
  { text: 'ꝱ', isConfusable: true },
];

// Colours
const BG = '#0e1520';
const TEXT_PRIMARY = '#cdd8e8';
const TEXT_MUTED = '#8899aa';
const GREEN = '#1ed760';
const GREEN_BG = 'rgba(30, 215, 96, 0.12)';
const GREEN_BORDER = 'rgba(30, 215, 96, 0.5)';
const RED = '#ff5a5a';
const RED_BG = 'rgba(255, 90, 90, 0.12)';
const RED_BORDER = 'rgba(255, 90, 90, 0.5)';
const GREY_BG = 'rgba(255, 255, 255, 0.05)';
const GREY_BORDER = 'rgba(255, 255, 255, 0.15)';

// Register Geneva for confusable character rendering
try {
  registerFont('/System/Library/Fonts/Geneva.ttf', { family: 'Geneva' });
} catch { /* may already be available */ }

const IMG_W = 1400;
const IMG_H = 500;
const PADDING = 40;
const TOKEN_H = 36;
const TOKEN_PAD = 6;
const TOKEN_GAP = 2;
const FONT = '"Geneva", "Menlo", monospace';
const LABEL_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

function drawTokenRow(
  ctx: CanvasRenderingContext2D,
  tokens: Token[],
  x: number,
  y: number,
  fontSize: number,
): number {
  ctx.font = `${fontSize}px ${FONT}`;
  let cx = x;

  for (const token of tokens) {
    const metrics = ctx.measureText(token.text);
    const w = metrics.width + TOKEN_PAD * 2;

    // Token background
    ctx.fillStyle = token.isConfusable ? RED_BG : GREEN_BG;
    ctx.beginPath();
    ctx.roundRect(cx, y, w, TOKEN_H, 6);
    ctx.fill();

    // Token border
    ctx.strokeStyle = token.isConfusable ? RED_BORDER : GREEN_BORDER;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(cx, y, w, TOKEN_H, 6);
    ctx.stroke();

    // Token text
    ctx.fillStyle = token.isConfusable ? RED : GREEN;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(token.text, cx + w / 2, y + TOKEN_H / 2 + 1);

    cx += w + TOKEN_GAP;
  }

  return cx - x - TOKEN_GAP; // total width drawn
}

function countTokens(tokens: Token[]): { total: number; confusable: number } {
  return {
    total: tokens.length,
    confusable: tokens.filter(t => t.isConfusable).length,
  };
}

async function main() {
  console.log('=== render-bpe-blog-image ===\n');

  const canvas = createCanvas(IMG_W, IMG_H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, IMG_W, IMG_H);

  let y = PADDING;

  // === Section 1: Word-level close-up ===
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = `bold 16px ${LABEL_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Same word. Same pixels. Different token count.', PADDING, y);
  y += 32;

  // Left: clean "not"
  const leftX = PADDING;
  ctx.fillStyle = TEXT_MUTED;
  ctx.font = `13px ${LABEL_FONT}`;
  ctx.fillText('Clean:', leftX, y);

  drawTokenRow(ctx, CLEAN_WORD, leftX + 60, y - 6, 22);

  // Token count badge
  const cleanCount = countTokens(CLEAN_WORD);
  ctx.fillStyle = GREEN;
  ctx.font = `bold 13px ${LABEL_FONT}`;
  ctx.fillText(`${cleanCount.total} token`, leftX + 180, y);

  // Right: flood "поŧ"
  const rightX = IMG_W / 2 + 40;
  ctx.fillStyle = TEXT_MUTED;
  ctx.font = `13px ${LABEL_FONT}`;
  ctx.fillText('Confusable:', rightX, y);

  drawTokenRow(ctx, FLOOD_WORD, rightX + 100, y - 6, 22);

  const floodCount = countTokens(FLOOD_WORD);
  ctx.fillStyle = RED;
  ctx.font = `bold 13px ${LABEL_FONT}`;
  ctx.fillText(`${floodCount.total} tokens`, rightX + 280, y);

  y += 52;

  // Arrow between them
  ctx.fillStyle = TEXT_MUTED;
  ctx.font = `16px ${LABEL_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('Both render as "not" in Geneva. Both mean "not" to the LLM. One costs 3x more.', IMG_W / 2, y);

  y += 44;

  // Divider
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING, y);
  ctx.lineTo(IMG_W - PADDING, y);
  ctx.stroke();
  y += 24;

  // === Section 2: Full clause comparison ===
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = `bold 16px ${LABEL_FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('Scale to a full clause:', PADDING, y);
  y += 32;

  // Clean clause
  ctx.fillStyle = GREEN;
  ctx.font = `bold 13px ${LABEL_FONT}`;
  ctx.fillText(`Clean: ${CLEAN_CLAUSE.length} tokens`, PADDING, y);
  y += 22;

  drawTokenRow(ctx, CLEAN_CLAUSE, PADDING, y, 13);
  y += TOKEN_H + 28;

  // Flood clause
  const floodClauseCount = countTokens(FLOOD_CLAUSE);
  ctx.fillStyle = RED;
  ctx.font = `bold 13px ${LABEL_FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(
    `Flood: ${floodClauseCount.total} tokens (${floodClauseCount.confusable} confusable fragments)`,
    PADDING, y,
  );
  y += 22;

  drawTokenRow(ctx, FLOOD_CLAUSE, PADDING, y, 13);
  y += TOKEN_H + 28;

  // Bottom callout
  ctx.fillStyle = TEXT_MUTED;
  ctx.font = `14px ${LABEL_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(
    'Full document: 881 tokens clean, 4,567 tokens flooded.  Same meaning.  5.2x the API bill.',
    IMG_W / 2, y,
  );

  // Write output
  const pngBuffer = canvas.toBuffer('image/png');
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, pngBuffer);
  console.log(`Written to: ${OUTPUT_PATH} (${(pngBuffer.length / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
