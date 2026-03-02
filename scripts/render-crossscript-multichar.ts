/**
 * render-crossscript-multichar.ts -- Visual audit of cross-script multi-char confusables
 *
 * Like render-top50-multichar.ts but filtered to non-ASCII targets only,
 * showing the cross-script discoveries (Cyrillic, IPA, ligatures, symbols).
 *
 * Usage: npx tsx scripts/render-crossscript-multichar.ts
 */

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { createCanvas } from 'canvas';
import { initFonts } from '../src/fonts.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const JSONL_PATH = path.join(ROOT, 'data/output/multichar-discoveries-sdf.jsonl');
const OUTPUT_DIR = path.join(ROOT, 'data/output');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'crossscript-multichar-confusables.png');

const N = 50;
const MAX_PER_TARGET = 3;
const MIN_FONTS = 2;     // lower threshold -- cross-script pairs have fewer fonts
const MIN_NCC = 0.96;    // minimum mean NCC for visual quality

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
  bestFont: string;
  bestL2: number;
  bestNCC: number;
}

/** Returns true if target character is non-ASCII (cross-script or special symbol) */
function isCrossScript(target: string): boolean {
  const cp = target.codePointAt(0)!;
  // Exclude basic ASCII (0x20-0x7E) -- keep everything else
  return cp > 0x7E;
}

async function main(): Promise<void> {
  console.log('[1/4] Initialising fonts...');
  initFonts();

  console.log('[2/4] Loading and aggregating cross-script discoveries...');

  const pairMap = new Map<string, Discovery[]>();
  let totalDiscoveries = 0;
  let crossScriptCount = 0;

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

    // Only keep cross-script targets
    if (!isCrossScript(d.target)) continue;
    crossScriptCount++;

    const key = `${d.bigram}\t${d.target}`;
    let arr = pairMap.get(key);
    if (!arr) { arr = []; pairMap.set(key, arr); }
    arr.push(d);

    if (totalDiscoveries % 1_000_000 === 0) {
      console.log(`  ...${(totalDiscoveries / 1_000_000).toFixed(0)}M scanned`);
    }
  }

  console.log(`  ${totalDiscoveries.toLocaleString()} total, ${crossScriptCount.toLocaleString()} cross-script`);
  console.log(`  ${pairMap.size.toLocaleString()} unique cross-script pairs`);

  // Aggregate each pair
  const aggregated: AggregatedPair[] = [];
  for (const [, entries] of pairMap) {
    if (entries.length < MIN_FONTS) continue;

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
    });
  }

  console.log(`  ${aggregated.length.toLocaleString()} pairs with >=${MIN_FONTS} confirming fonts`);

  // Sort by mean L2 ascending (strongest visual matches first), then numFonts desc
  aggregated.sort((a, b) => a.meanL2 - b.meanL2 || b.numFonts - a.numFonts);

  // Diversity filter
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

  // Render
  console.log('[3/4] Rendering...');

  const canvasH = HEADER_H + 28 + ROW_H * selected.length + 16;
  const canvas = createCanvas(CANVAS_W, canvasH);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CANVAS_W, canvasH);

  // Title
  ctx.fillStyle = '#222222';
  ctx.font = 'bold 18px "Helvetica Neue"';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('Cross-Script Multi-Character Confusables', 16, 24);
  ctx.fillStyle = '#888888';
  ctx.font = '12px "Helvetica Neue"';
  ctx.fillText(
    `Non-ASCII targets only. ${crossScriptCount.toLocaleString()} cross-script discoveries from ` +
    `${totalDiscoveries.toLocaleString()} total. Min ${MIN_FONTS} confirming fonts.`,
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

    // Render bigram
    const bigramX = LABEL_W + CELL_W / 2;
    ctx.fillStyle = '#000000';
    ctx.font = `${GLYPH_SIZE}px "${p.bestFont}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.bigram, bigramX, centerY);

    // Render target
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

    ctx.fillStyle = '#aaaaaa';
    ctx.font = '10px "Helvetica Neue"';
    ctx.fillText(`best: ${p.bestL2.toFixed(2)}`, LABEL_W + CELL_W * 2 + 68, centerY + 10);
  }

  // Dividers
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  for (const x of [LABEL_W, LABEL_W + CELL_W, LABEL_W + CELL_W * 2]) {
    ctx.beginPath();
    ctx.moveTo(x, startY);
    ctx.lineTo(x, startY + selected.length * ROW_H);
    ctx.stroke();
  }
  for (let i = 0; i <= selected.length; i++) {
    const lineY = startY + i * ROW_H;
    ctx.beginPath();
    ctx.moveTo(0, lineY);
    ctx.lineTo(CANVAS_W, lineY);
    ctx.stroke();
  }

  // Save
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
