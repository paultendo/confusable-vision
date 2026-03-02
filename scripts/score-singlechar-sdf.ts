/**
 * score-singlechar-sdf.ts -- Re-score existing single-char confusable pairs with SDF
 *
 * Loads pairs from confusable-discoveries.json, candidate-discoveries.json,
 * and cross-script-discoveries.json. Computes SDF L2/NCC for each pair
 * across all available fonts. Outputs JSONL for comparison against
 * existing SSIM-based scores.
 *
 * Usage: npx tsx scripts/score-singlechar-sdf.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  loadFont,
  evictFontCache,
  extractGlyphPath,
  getFontMetrics,
  normalizeToGrid,
  getBaselineRow,
} from '../src/glyph-path.js';
import { compareSDF } from '../src/sdf.js';
import { initFonts } from '../src/fonts.js';
import type { PathSegment, SDFGrid } from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'data/output/singlechar-sdf-scores.jsonl');
const WORKER_PATH = path.resolve(import.meta.dirname, 'compute-worker.mjs');

const GRID_SIZE = 128;

// ---- Types ----

interface Pair {
  source: string;
  sourceCodepoint: string;
  target: string;
  targetCodepoint: string;
  ssimMean: number;
  ssimMax: number;
  ssimFontCount: number;
  dataSource: 'tr39' | 'novel' | 'cross-script';
}

// ---- Worker pool (copied from score-multichar-sdf.ts) ----

class ComputePool {
  private workers: Worker[];
  private pending = new Map<number, (result: unknown) => void>();
  private nextId = 0;

  constructor(numWorkers: number) {
    this.workers = [];
    for (let i = 0; i < numWorkers; i++) {
      const w = new Worker(WORKER_PATH);
      w.on('message', (msg: { id: number; type?: string; data?: Float64Array }) => {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg.data);
        }
      });
      w.on('error', (err) => {
        console.error(`  [worker ${i}] error:`, err.message);
      });
      this.workers.push(w);
    }
  }

  computeSDF(segments: PathSegment[], width: number, height: number, baselineRow: number): Promise<Float64Array> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve as (result: unknown) => void);
      const workerIdx = id % this.workers.length;
      this.workers[workerIdx]!.postMessage({ id, type: 'sdf', segments, width, height, baselineRow });
    });
  }

  async shutdown(): Promise<void> {
    const exits = this.workers.map(w =>
      new Promise<void>(resolve => {
        w.on('exit', () => resolve());
        w.postMessage({ type: 'exit' });
      }),
    );
    await Promise.all(exits);
  }
}

// ---- Font LRU cache ----

class FontLRU {
  private cache = new Map<string, ReturnType<typeof loadFont>>();
  private order: string[] = [];

  constructor(private maxSize: number) {}

  get(fontPath: string): ReturnType<typeof loadFont> {
    const existing = this.cache.get(fontPath);
    if (existing !== undefined) {
      const idx = this.order.indexOf(fontPath);
      if (idx >= 0) { this.order.splice(idx, 1); this.order.push(fontPath); }
      return existing;
    }
    const font = loadFont(fontPath);
    if (!font) return null;
    this.cache.set(fontPath, font);
    this.order.push(fontPath);
    while (this.order.length > this.maxSize) {
      const evicted = this.order.shift()!;
      this.cache.delete(evicted);
      evictFontCache(evicted);
    }
    return font;
  }
}

// ---- Load pairs from all three discovery files ----

function cpToHex(char: string): string {
  const cp = char.codePointAt(0)!;
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

function loadPairs(): Pair[] {
  const pairs = new Map<string, Pair>(); // key: "source|target"

  // 1. TR39 confusable discoveries
  const tr39Path = path.join(ROOT, 'data/output/confusable-discoveries.json');
  if (fs.existsSync(tr39Path)) {
    const data = JSON.parse(fs.readFileSync(tr39Path, 'utf-8'));
    for (const p of data.pairs) {
      const key = `${p.source}|${p.target}`;
      if (!pairs.has(key)) {
        const ssimScores = p.fonts
          .filter((f: { ssim: number | null }) => f.ssim !== null)
          .map((f: { ssim: number }) => f.ssim);
        pairs.set(key, {
          source: p.source,
          sourceCodepoint: p.sourceCodepoint,
          target: p.target,
          targetCodepoint: cpToHex(p.target),
          ssimMean: p.summary.meanSsim ?? 0,
          ssimMax: ssimScores.length > 0 ? Math.max(...ssimScores) : 0,
          ssimFontCount: p.summary.validFontCount,
          dataSource: 'tr39',
        });
      }
    }
    console.log(`[load] TR39: ${data.pairs.length} pairs`);
  }

  // 2. Novel candidate discoveries
  const candidatePath = path.join(ROOT, 'data/output/candidate-discoveries.json');
  if (fs.existsSync(candidatePath)) {
    const data = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));
    for (const p of data.pairs) {
      const key = `${p.source}|${p.target}`;
      if (!pairs.has(key)) {
        const ssimScores = p.fonts
          .filter((f: { ssim: number | null }) => f.ssim !== null)
          .map((f: { ssim: number }) => f.ssim);
        pairs.set(key, {
          source: p.source,
          sourceCodepoint: p.sourceCodepoint,
          target: p.target,
          targetCodepoint: cpToHex(p.target),
          ssimMean: p.summary.meanSsim ?? 0,
          ssimMax: ssimScores.length > 0 ? Math.max(...ssimScores) : 0,
          ssimFontCount: p.summary.validFontCount,
          dataSource: 'novel',
        });
      }
    }
    console.log(`[load] Novel: ${data.pairs.length} pairs`);
  }

  // 3. Cross-script discoveries (different field names)
  const crossPath = path.join(ROOT, 'data/output/cross-script-discoveries.json');
  if (fs.existsSync(crossPath)) {
    const data = JSON.parse(fs.readFileSync(crossPath, 'utf-8'));
    for (const p of data.pairs) {
      const key = `${p.charA}|${p.charB}`;
      if (!pairs.has(key)) {
        pairs.set(key, {
          source: p.charA,
          sourceCodepoint: p.codepointA,
          target: p.charB,
          targetCodepoint: p.codepointB,
          ssimMean: p.summary.meanSsim ?? 0,
          ssimMax: p.bestFont?.ssim ?? p.summary.meanSsim ?? 0,
          ssimFontCount: p.summary.validFontCount,
          dataSource: 'cross-script',
        });
      }
    }
    console.log(`[load] Cross-script: ${data.pairs.length} pairs`);
  }

  const result = Array.from(pairs.values());
  console.log(`[load] Total unique pairs: ${result.length}`);
  return result;
}

// ---- Resume support ----

function loadCompletedFonts(): Set<string> {
  const completed = new Set<string>();
  if (!fs.existsSync(OUTPUT_PATH)) return completed;
  const lines = fs.readFileSync(OUTPUT_PATH, 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'font-done') completed.add(obj.font);
    } catch { /* skip malformed lines */ }
  }
  return completed;
}

// ---- Main ----

async function main(): Promise<void> {
  console.log('=== Single-Character SDF Re-Scoring ===\n');

  const pairs = loadPairs();
  const allFonts = initFonts();
  const availableFonts = allFonts.filter(f => f.available);
  console.log(`[fonts] ${availableFonts.length} fonts available\n`);

  const completedFonts = loadCompletedFonts();
  if (completedFonts.size > 0) {
    console.log(`[resume] ${completedFonts.size} fonts already completed, skipping\n`);
  }

  const numWorkers = Math.max(1, Math.min(8, Math.floor(availableFonts.length / 4)));
  const pool = new ComputePool(numWorkers);
  const fontLRU = new FontLRU(30);

  const fd = fs.openSync(OUTPUT_PATH, completedFonts.size > 0 ? 'a' : 'w');

  // Write meta if starting fresh
  if (completedFonts.size === 0) {
    fs.writeSync(fd, JSON.stringify({
      type: 'meta',
      gridSize: GRID_SIZE,
      pairCount: pairs.length,
      startedAt: new Date().toISOString(),
    }) + '\n');
  }

  let totalScored = 0;
  const t0 = performance.now();

  for (let fi = 0; fi < availableFonts.length; fi++) {
    const fontEntry = availableFonts[fi]!;
    if (completedFonts.has(fontEntry.family)) continue;

    const fontT0 = performance.now();
    const font = fontLRU.get(fontEntry.path);
    if (!font) {
      console.log(`  [${fi + 1}/${availableFonts.length}] ${fontEntry.family}: SKIP (load failed)`);
      continue;
    }

    const metrics = getFontMetrics(font);
    const baselineRow = getBaselineRow(metrics, GRID_SIZE);

    let scored = 0;
    let skipped = 0;

    for (const pair of pairs) {
      const sourceCp = pair.source.codePointAt(0)!;
      const targetCp = pair.target.codePointAt(0)!;

      const sourcePath = extractGlyphPath(font, sourceCp);
      const targetPath = extractGlyphPath(font, targetCp);
      if (!sourcePath || !targetPath) { skipped++; continue; }

      // Skip pathological glyphs
      if (sourcePath.segments.length + targetPath.segments.length > 5000) {
        skipped++;
        continue;
      }

      const gridSource = normalizeToGrid(sourcePath, metrics, GRID_SIZE);
      const gridTarget = normalizeToGrid(targetPath, metrics, GRID_SIZE);

      if (gridSource.length === 0 || gridTarget.length === 0) { skipped++; continue; }

      const [sourceSdfData, targetSdfData] = await Promise.all([
        pool.computeSDF(gridSource, GRID_SIZE, GRID_SIZE, baselineRow),
        pool.computeSDF(gridTarget, GRID_SIZE, GRID_SIZE, baselineRow),
      ]);

      const sdfSource: SDFGrid = { width: GRID_SIZE, height: GRID_SIZE, data: sourceSdfData, baselineRow };
      const sdfTarget: SDFGrid = { width: GRID_SIZE, height: GRID_SIZE, data: targetSdfData, baselineRow };
      const result = compareSDF(sdfSource, sdfTarget);

      fs.writeSync(fd, JSON.stringify({
        type: 'score',
        source: pair.source,
        sourceCodepoint: pair.sourceCodepoint,
        target: pair.target,
        targetCodepoint: pair.targetCodepoint,
        font: fontEntry.family,
        sdfL2: Math.round(result.l2 * 10000) / 10000,
        sdfNCC: Math.round(result.ncc * 10000) / 10000,
        ssimMean: pair.ssimMean,
        dataSource: pair.dataSource,
      }) + '\n');

      scored++;
    }

    const elapsed = ((performance.now() - fontT0) / 1000).toFixed(1);
    totalScored += scored;

    fs.writeSync(fd, JSON.stringify({
      type: 'font-done',
      font: fontEntry.family,
      scored,
      skipped,
      elapsed: parseFloat(elapsed),
    }) + '\n');

    console.log(`  [${fi + 1}/${availableFonts.length}] ${fontEntry.family}: ${scored} scored, ${skipped} skipped (${elapsed}s)`);
  }

  const totalElapsed = ((performance.now() - t0) / 1000).toFixed(1);

  fs.writeSync(fd, JSON.stringify({
    type: 'summary',
    totalScored,
    uniquePairs: pairs.length,
    fontsProcessed: availableFonts.length - completedFonts.size,
    elapsed: parseFloat(totalElapsed),
  }) + '\n');

  fs.closeSync(fd);

  console.log(`\n[done] ${totalScored} scores across ${availableFonts.length} fonts in ${totalElapsed}s`);
  console.log(`[done] Output: ${OUTPUT_PATH}`);

  await pool.shutdown();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
