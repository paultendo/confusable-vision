/**
 * render-top50-multichar.ts -- Visual audit of top multi-char confusables
 *
 * Aggregates discoveries by (bigram, target) pair, applies a diversity filter
 * (max 3 rows per unique target), and renders the top 50 pairs side-by-side
 * in their best-matching font.
 *
 * Usage: npx tsx scripts/render-top50-multichar.ts
 */

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { createCanvas } from 'canvas';
import { initFonts } from '../src/fonts.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const JSONL_PATH = path.join(ROOT, 'data/output/multichar-discoveries-sdf.jsonl');
const OUTPUT_DIR = path.join(ROOT, 'data/output');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'top-50-multichar-confusables.png');

const N = 50;
const MAX_PER_TARGET = 3; // diversity cap: max rows per unique target
const MIN_FONTS = 3;      // minimum confirming fonts for inclusion
const MIN_NCC = 0.96;     // minimum mean NCC for visual quality

const ROW_H = 80;
const GLYPH_SIZE = 48;
const LABEL_W = 280;
const CELL_W = 140;
const SCORES_W = 220;
const CANVAS_W = LABEL_W + CELL_W * 2 + SCORES_W;
const HEADER_H = 56;

interface Discovery {
  bigram: string;
  target: string;
  targetCodepoint: string;
  font: string;
  sdfL2: number;
  sdfNCC: number;
}

interface AggregatedPair {
  bigram: string;
  target: string;
  targetCodepoint: string;
  numFonts: number;
  meanL2: number;
  meanNCC: number;
  bestFont: string;    // font with lowest L2
  bestL2: number;
  bestNCC: number;
  fonts: string[];     // all confirming fonts
}

async function main(): Promise<void> {
  console.log('[1/4] Initialising fonts...');
  initFonts();

  console.log('[2/4] Loading and aggregating discoveries...');

  // Stream the JSONL -- file is too large for readFileSync
  const pairMap = new Map<string, Discovery[]>();
  let totalDiscoveries = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(JSONL_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    const obj = JSON.parse(line);
    if (obj.type !== 'discovery') continue;
    totalDiscoveries++;
    const d = obj as Discovery;
    const key = `${d.bigram}\t${d.target}`;
    let arr = pairMap.get(key);
    if (!arr) { arr = []; pairMap.set(key, arr); }
    arr.push(d);
    if (totalDiscoveries % 1_000_000 === 0) {
      console.log(`  ...${(totalDiscoveries / 1_000_000).toFixed(0)}M discoveries loaded`);
    }
  }

  console.log(`  ${totalDiscoveries.toLocaleString()} discoveries -> ${pairMap.size.toLocaleString()} unique pairs`);

  // Aggregate each pair
  const aggregated: AggregatedPair[] = [];
  for (const [, entries] of pairMap) {
    if (entries.length < MIN_FONTS) continue;

    // Sort by L2 ascending to find best font
    entries.sort((a, b) => a.sdfL2 - b.sdfL2);
    const best = entries[0]!;
    const meanL2 = entries.reduce((s, e) => s + e.sdfL2, 0) / entries.length;
    const meanNCC = entries.reduce((s, e) => s + e.sdfNCC, 0) / entries.length;

    if (meanNCC < MIN_NCC) continue;

    aggregated.push({
      bigram: best.bigram,
      target: best.target,
      targetCodepoint: best.targetCodepoint,
      numFonts: entries.length,
      meanL2,
      meanNCC,
      bestFont: best.font,
      bestL2: best.sdfL2,
      bestNCC: best.sdfNCC,
      fonts: entries.map(e => e.font),
    });
  }

  console.log(`  ${aggregated.length.toLocaleString()} pairs with >=${MIN_FONTS} confirming fonts`);

  // Sort by mean L2 ascending (strongest visual matches first), then numFonts desc
  aggregated.sort((a, b) => a.meanL2 - b.meanL2 || b.numFonts - a.numFonts);

  // Apply diversity filter: max MAX_PER_TARGET rows per target character
  const targetCounts = new Map<string, number>();
  const selected: AggregatedPair[] = [];
  for (const pair of aggregated) {
    if (selected.length >= N) break;
    const count = targetCounts.get(pair.target) ?? 0;
    if (count >= MAX_PER_TARGET) continue;
    targetCounts.set(pair.target, count + 1);
    selected.push(pair);
  }

  console.log(`  Selected ${selected.length} pairs (max ${MAX_PER_TARGET} per target)`);
  console.log(`  Targets represented: ${targetCounts.size}`);

  // [3/4] Render
  console.log('[3/4] Rendering...');

  const canvasH = HEADER_H + 28 + ROW_H * selected.length + 16;
  const canvas = createCanvas(CANVAS_W, canvasH);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_W, canvasH);

  // Title
  ctx.fillStyle = '#222222';
  ctx.font = 'bold 18px "Helvetica Neue"';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('Top 50 Multi-Character Confusables (Enriched Raycasting)', 16, 24);
  ctx.fillStyle = '#888888';
  ctx.font = '12px "Helvetica Neue"';
  ctx.fillText(
    `${totalDiscoveries.toLocaleString()} discoveries, ${pairMap.size.toLocaleString()} unique pairs. ` +
    `Diversity-filtered: max ${MAX_PER_TARGET} per target, min ${MIN_FONTS} confirming fonts.`,
    16, 44,
  );

  // Column headers
  const colHeaderY = HEADER_H + 2;
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, colHeaderY - 12, CANVAS_W, 24);
  ctx.fillStyle = '#666666';
  ctx.font = 'bold 11px "Helvetica Neue"';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('#', 8, colHeaderY);
  ctx.fillText('Pair / Font', 30, colHeaderY);
  ctx.fillText('Bigram', LABEL_W + 30, colHeaderY);
  ctx.fillText('Target', LABEL_W + CELL_W + 30, colHeaderY);
  ctx.fillText('Fonts', LABEL_W + CELL_W * 2 + 12, colHeaderY);
  ctx.fillText('Mean L2', LABEL_W + CELL_W * 2 + 60, colHeaderY);
  ctx.fillText('Mean NCC', LABEL_W + CELL_W * 2 + 140, colHeaderY);

  const startY = HEADER_H + 28;

  for (let i = 0; i < selected.length; i++) {
    const p = selected[i]!;
    const y = startY + i * ROW_H;
    const centerY = y + ROW_H / 2;

    // Alternating row background
    if (i % 2 === 1) {
      ctx.fillStyle = '#fafafa';
      ctx.fillRect(0, y, CANVAS_W, ROW_H);
    }

    // Row number
    ctx.fillStyle = '#aaaaaa';
    ctx.font = '11px "Helvetica Neue"';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText(String(i + 1), 22, centerY);

    // Pair description
    ctx.textAlign = 'left';
    ctx.fillStyle = '#333333';
    ctx.font = 'bold 12px "Menlo"';
    ctx.fillText(`"${p.bigram}" -> ${p.target}`, 30, centerY - 16);

    ctx.fillStyle = '#888888';
    ctx.font = '10px "Menlo"';
    ctx.fillText(p.targetCodepoint, 30, centerY);

    ctx.fillStyle = '#aaaaaa';
    ctx.font = '10px "Helvetica Neue"';
    const fontLabel = p.bestFont.length > 28 ? p.bestFont.slice(0, 26) + '..' : p.bestFont;
    ctx.fillText(`Best: ${fontLabel} (L2=${p.bestL2.toFixed(1)})`, 30, centerY + 14);

    // Render bigram in the best font
    const bigramX = LABEL_W + CELL_W / 2;
    ctx.fillStyle = '#000000';
    ctx.font = `${GLYPH_SIZE}px "${p.bestFont}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.bigram, bigramX, centerY);

    // Render target in the same font
    const targetX = LABEL_W + CELL_W + CELL_W / 2;
    ctx.fillText(p.target, targetX, centerY);

    // Scores
    ctx.textAlign = 'left';
    ctx.fillStyle = '#333333';
    ctx.font = 'bold 12px "Menlo"';
    ctx.fillText(String(p.numFonts), LABEL_W + CELL_W * 2 + 20, centerY - 6);

    ctx.fillStyle = '#555555';
    ctx.font = '11px "Menlo"';
    ctx.fillText(p.meanL2.toFixed(2), LABEL_W + CELL_W * 2 + 68, centerY - 6);
    ctx.fillText(p.meanNCC.toFixed(4), LABEL_W + CELL_W * 2 + 140, centerY - 6);

    // Secondary: best-font L2 for reference
    ctx.fillStyle = '#aaaaaa';
    ctx.font = '10px "Helvetica Neue"';
    ctx.fillText(`best: ${p.bestL2.toFixed(2)}`, LABEL_W + CELL_W * 2 + 68, centerY + 10);
  }

  // Vertical divider lines
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  for (const x of [LABEL_W, LABEL_W + CELL_W, LABEL_W + CELL_W * 2]) {
    ctx.beginPath();
    ctx.moveTo(x, startY);
    ctx.lineTo(x, startY + selected.length * ROW_H);
    ctx.stroke();
  }

  // Horizontal dividers
  for (let i = 0; i <= selected.length; i++) {
    const lineY = startY + i * ROW_H;
    ctx.beginPath();
    ctx.moveTo(0, lineY);
    ctx.lineTo(CANVAS_W, lineY);
    ctx.stroke();
  }

  // [4/4] Save
  console.log('[4/4] Saving...');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(OUTPUT_PATH, buf);
  console.log(`Written: ${OUTPUT_PATH}`);
  console.log(`Size: ${(buf.length / 1024).toFixed(0)} KB, ${CANVAS_W}x${canvasH}px`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
