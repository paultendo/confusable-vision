/**
 * score-multichar-sdf.ts -- Phase 4: multi-character scoring
 *
 * Loads multi-character confusable mappings from confusable-multichar.json
 * (rn->m, cl->d, vv->w, etc.), builds combined paths via extractSequencePath(),
 * and computes SDF distances against single-character targets.
 *
 * Bank-accelerated: single-char target signatures are looked up from the
 * precomputed signature bank via compareCountArrays(), avoiding redundant
 * raycasting. Worker threads handle source signature computation and SDF.
 *
 * Uses JSONL streaming output with per-font resume capability.
 *
 * Output: data/output/multichar-sdf-scores.jsonl
 *
 * Usage: npx tsx scripts/score-multichar-sdf.ts
 *        npx tsx scripts/score-multichar-sdf.ts --scorer=ray   (default, no SDF)
 *        npx tsx scripts/score-multichar-sdf.ts --scorer=sdf   (ray + SDF, original behavior)
 *        npx tsx scripts/score-multichar-sdf.ts --scorer=both  (ray + SDF for comparison)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  loadFont,
  evictFontCache,
  extractGlyphPath,
  concatGlyphPaths,
  getFontMetrics,
  normalizeToGrid,
  getBaselineRow,
} from '../src/glyph-path.js';
import { compareSDF } from '../src/sdf.js';
import { initFonts } from '../src/fonts.js';
import {
  loadBankForCodepoints,
  compareEnrichedArrays,
} from '../src/signature-bank.js';
import type { FontEntry, MulticharConfusable, PathSegment, SDFGrid } from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MULTICHAR_PATH = path.join(ROOT, 'data/input/confusable-multichar.json');
const BANK_PATH = path.join(ROOT, 'data/output/signature-bank.jsonl.gz');
const OUTPUT_PATH = path.join(ROOT, 'data/output/multichar-sdf-scores.jsonl');
const WORKER_PATH = path.resolve(import.meta.dirname, 'compute-worker.mjs');

const GRID_SIZE = 128;
const NUM_ANGLES = 36;
const RAYS_PER_ANGLE = 50;

// ---- Scorer mode ----

type ScorerMode = 'ray' | 'sdf' | 'both';
const scorerArg = process.argv.find(a => a.startsWith('--scorer='));
const SCORER: ScorerMode = (scorerArg?.split('=')[1] as ScorerMode) ?? 'ray';
if (!['ray', 'sdf', 'both'].includes(SCORER)) {
  console.error(`Invalid --scorer value: ${SCORER}. Use ray, sdf, or both.`);
  process.exit(1);
}
const useSdf = SCORER !== 'ray';

interface MulticharMapping {
  source: string;
  target: string;
  sourceLength: number;
}

interface MulticharScore {
  source: string;
  target: string;
  font: string;
  sdfL2: number;
  sdfNCC: number;
  rayDistance: number;
}

// ---- Worker pool ----

class ComputePool {
  private workers: Worker[];
  private pending = new Map<number, (result: unknown) => void>();
  private nextId = 0;

  constructor(numWorkers: number) {
    this.workers = [];
    for (let i = 0; i < numWorkers; i++) {
      const w = new Worker(WORKER_PATH);
      w.on('message', (msg: { id: number; type?: string; counts?: number[]; positions?: number[]; angles?: number[]; pingDistances?: number[]; pingMax?: number[]; data?: Float64Array }) => {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg.type === 'sdf' ? msg.data : { counts: msg.counts, positions: msg.positions, angles: msg.angles, pingDistances: msg.pingDistances, pingMax: msg.pingMax });
        }
      });
      w.on('error', (err) => {
        console.error(`  [worker ${i}] error:`, err.message);
      });
      this.workers.push(w);
    }
  }

  computeSignature(gridSegments: PathSegment[], numAngles: number, raysPerAngle: number): Promise<{ counts: number[]; positions: number[]; angles: number[]; pingDistances: number[]; pingMax: number[] }> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve as (result: unknown) => void);
      const workerIdx = id % this.workers.length;
      this.workers[workerIdx]!.postMessage({ id, gridSegments, numAngles, raysPerAngle });
    });
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

// ---- JSONL types ----

interface JsonlMeta {
  type: 'meta';
  scorer?: string;
  gridSize: number;
  numAngles: number;
  raysPerAngle: number;
  startedAt: string;
}

interface JsonlScore {
  type: 'score';
  source: string;
  target: string;
  font: string;
  sdfL2: number;
  sdfNCC: number;
  rayDistance: number;
}

interface JsonlFontDone {
  type: 'font-done';
  font: string;
  scored: number;
  skipped: number;
  elapsed: number;
}

interface JsonlSummary {
  type: 'summary';
  totalScores: number;
  uniqueMappings: number;
  elapsed: number;
}

// ---- Resume helpers ----

function scanCompletedFonts(outputPath: string): Set<string> {
  const completedFonts = new Set<string>();
  if (!fs.existsSync(outputPath)) return completedFonts;

  const content = fs.readFileSync(outputPath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'font-done') completedFonts.add(entry.font);
    } catch {
      // Skip malformed lines
    }
  }
  return completedFonts;
}

function loadExistingScores(outputPath: string): MulticharScore[] {
  const scores: MulticharScore[] = [];
  if (!fs.existsSync(outputPath)) return scores;

  const content = fs.readFileSync(outputPath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'score') {
        scores.push({
          source: entry.source,
          target: entry.target,
          font: entry.font,
          sdfL2: entry.sdfL2,
          sdfNCC: entry.sdfNCC,
          rayDistance: entry.rayDistance,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return scores;
}

/**
 * Load multi-character mappings from confusable-multichar.json.
 * Run `npm run fetch-confusables` first to generate the file.
 */
function loadMulticharMappings(): MulticharMapping[] {
  if (!fs.existsSync(MULTICHAR_PATH)) {
    console.error(`confusable-multichar.json not found: ${MULTICHAR_PATH}`);
    console.error('Run: npm run fetch-confusables');
    process.exit(1);
  }

  const raw: MulticharConfusable[] = JSON.parse(fs.readFileSync(MULTICHAR_PATH, 'utf-8'));
  return raw.map(m => ({
    source: m.source,
    target: m.target,
    sourceLength: [...m.source].length,
  }));
}

async function main(): Promise<void> {
  console.log(`=== Multi-Character Scoring (scorer: ${SCORER}) ===\n`);
  const t0 = Date.now();

  const numCpus = os.cpus().length;
  const numWorkers = Math.max(1, numCpus - 1);

  console.log('[1/5] Initialising fonts...\n');
  const allFonts = initFonts();
  const availableFonts = allFonts.filter(f => f.available);
  console.log(`  ${availableFonts.length} fonts available (all categories)\n`);

  console.log('[2/5] Parsing multi-character mappings...');
  const mappings = loadMulticharMappings();
  console.log(`  ${mappings.length} multi-character mappings (processing all)\n`);

  if (mappings.length === 0) {
    console.log('No multi-character mappings to process.');
    return;
  }

  // Collect single-char target codepoints for bank lookup
  const singleCharTargetCps = new Set<number>();
  for (const m of mappings) {
    if ([...m.target].length === 1) {
      singleCharTargetCps.add(m.target.codePointAt(0)!);
    }
  }

  console.log('[3/5] Loading signature bank for target codepoints...');
  let bankData = new Map<number, import('../src/types.js').BankEntry[]>();
  if (fs.existsSync(BANK_PATH) && singleCharTargetCps.size > 0) {
    bankData = await loadBankForCodepoints(BANK_PATH, singleCharTargetCps);
    console.log(`  Bank loaded: ${bankData.size} codepoints with entries\n`);
  } else {
    console.log('  Bank not found or no single-char targets; computing all signatures on the fly\n');
  }

  // ---- Resume check ----
  const completedFonts = scanCompletedFonts(OUTPUT_PATH);
  const existingScores = completedFonts.size > 0 ? loadExistingScores(OUTPUT_PATH) : [];

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  let fd: number;
  if (completedFonts.size === 0) {
    const meta: JsonlMeta = {
      type: 'meta',
      scorer: SCORER,
      gridSize: GRID_SIZE,
      numAngles: NUM_ANGLES,
      raysPerAngle: RAYS_PER_ANGLE,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(meta) + '\n');
    fd = fs.openSync(OUTPUT_PATH, 'a');
  } else {
    console.log(`  Resuming: ${completedFonts.size} fonts already processed, ${existingScores.length} existing scores`);
    fd = fs.openSync(OUTPUT_PATH, 'a');
  }

  console.log(`[4/5] Computing SDF scores (${numWorkers} workers, ${GRID_SIZE}x${GRID_SIZE} SDF)...\n`);

  const pool = new ComputePool(numWorkers);
  const fontLRU = new FontLRU(30);
  const scores: MulticharScore[] = [...existingScores];
  let totalProcessed = 0;
  let totalSkipped = 0;

  // Batch by font: outer loop = fonts, inner = mappings
  for (let fi = 0; fi < availableFonts.length; fi++) {
    const fontEntry = availableFonts[fi]!;

    // Skip already-completed fonts (resume)
    if (completedFonts.has(fontEntry.family)) continue;

    const font = fontLRU.get(fontEntry.path);
    if (!font) continue;

    const metrics = getFontMetrics(font);
    const baselineRow = getBaselineRow(metrics, GRID_SIZE);

    let fontProcessed = 0;
    let fontSkipped = 0;
    const fontT0 = Date.now();

    for (const mapping of mappings) {
      // Extract source path -- all multichar-confusable sources are single
      // codepoints, so use extractGlyphPath (cmap lookup only, no layout engine)
      const sourcePath = [...mapping.source].length === 1
        ? extractGlyphPath(font, mapping.source.codePointAt(0)!)
        : concatGlyphPaths(font, mapping.source);
      if (!sourcePath) { fontSkipped++; continue; }

      // Extract target path -- use concatGlyphPaths to avoid font.layout()
      // which triggers V8-fatal OOM in fontkit on certain complex-script fonts
      const targetPath = [...mapping.target].length === 1
        ? extractGlyphPath(font, mapping.target.codePointAt(0)!)
        : concatGlyphPaths(font, mapping.target);
      if (!targetPath) { fontSkipped++; continue; }

      // Skip pathologically complex glyphs (guards against OOM in SDF/raycasting)
      if (sourcePath.segments.length + targetPath.segments.length > 5000) {
        fontSkipped++;
        continue;
      }

      const gridSource = normalizeToGrid(sourcePath, metrics, GRID_SIZE);
      const gridTarget = normalizeToGrid(targetPath, metrics, GRID_SIZE);

      // Raycasting: source always via worker
      const sourceSigPromise = pool.computeSignature(gridSource, NUM_ANGLES, RAYS_PER_ANGLE);

      // Target raycasting: try bank lookup for single-char targets
      let rayDistance: number;
      const targetIsSingleChar = [...mapping.target].length === 1;
      const targetCp = targetIsSingleChar ? mapping.target.codePointAt(0)! : -1;

      const bankEntries = targetIsSingleChar ? bankData.get(targetCp) : undefined;
      const bankEntry = bankEntries?.find(e => e.font === fontEntry.family);

      const sourceSig = await sourceSigPromise;

      if (bankEntry) {
        // Bank hit: direct array comparison
        rayDistance = compareEnrichedArrays(sourceSig.counts, sourceSig.positions, bankEntry.counts, bankEntry.positions, NUM_ANGLES, RAYS_PER_ANGLE, sourceSig.angles, bankEntry.angles, sourceSig.pingDistances, bankEntry.pingDistances, sourceSig.pingMax, bankEntry.pingMax);
      } else {
        // No bank entry: compute target signature via worker
        const targetSig = await pool.computeSignature(gridTarget, NUM_ANGLES, RAYS_PER_ANGLE);
        rayDistance = compareEnrichedArrays(sourceSig.counts, sourceSig.positions, targetSig.counts, targetSig.positions, NUM_ANGLES, RAYS_PER_ANGLE, sourceSig.angles, targetSig.angles, sourceSig.pingDistances, targetSig.pingDistances, sourceSig.pingMax, targetSig.pingMax);
      }

      // SDF scoring (conditional on scorer mode)
      let sdfL2 = -1;
      let sdfNCC = -1;
      if (useSdf) {
        const [sourceSdfData, targetSdfData] = await Promise.all([
          pool.computeSDF(gridSource, GRID_SIZE, GRID_SIZE, baselineRow),
          pool.computeSDF(gridTarget, GRID_SIZE, GRID_SIZE, baselineRow),
        ]);
        const sdfSource: SDFGrid = { width: GRID_SIZE, height: GRID_SIZE, data: sourceSdfData, baselineRow };
        const sdfTarget: SDFGrid = { width: GRID_SIZE, height: GRID_SIZE, data: targetSdfData, baselineRow };
        const sdfResult = compareSDF(sdfSource, sdfTarget);
        sdfL2 = sdfResult.l2;
        sdfNCC = sdfResult.ncc;
      }

      const score: MulticharScore = {
        source: mapping.source,
        target: mapping.target,
        font: fontEntry.family,
        sdfL2,
        sdfNCC,
        rayDistance,
      };

      scores.push(score);
      fontProcessed++;

      // Write score to JSONL
      const jsonlEntry: JsonlScore = { type: 'score', ...score };
      fs.writeSync(fd, JSON.stringify(jsonlEntry) + '\n');
    }

    totalProcessed += fontProcessed;
    totalSkipped += fontSkipped;

    // Write font-done marker
    const fontElapsed = (Date.now() - fontT0) / 1000;
    const fontDone: JsonlFontDone = {
      type: 'font-done',
      font: fontEntry.family,
      scored: fontProcessed,
      skipped: fontSkipped,
      elapsed: Math.round(fontElapsed * 10) / 10,
    };
    fs.writeSync(fd, JSON.stringify(fontDone) + '\n');

    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `  [${fi + 1}/${availableFonts.length}] ${fontEntry.family}: ` +
      `${fontProcessed} scored, ${fontSkipped} skipped (${elapsed}s)`,
    );
  }

  await pool.shutdown();

  console.log(`\n  Total: ${totalProcessed} processed, ${totalSkipped} skipped\n`);

  // --- Summary ---
  console.log('[5/5] Summary\n');

  // Group by mapping, aggregate across fonts
  const byMapping = new Map<string, MulticharScore[]>();
  for (const s of scores) {
    const key = `${s.source} -> ${s.target}`;
    if (!byMapping.has(key)) byMapping.set(key, []);
    byMapping.get(key)!.push(s);
  }

  // Sort by mean SDF L2 (most similar first)
  const ranked = [...byMapping.entries()]
    .map(([key, fontScores]) => ({
      key,
      meanL2: fontScores.reduce((a, b) => a + b.sdfL2, 0) / fontScores.length,
      meanNCC: fontScores.reduce((a, b) => a + b.sdfNCC, 0) / fontScores.length,
      fontCount: fontScores.length,
      perFont: fontScores,
    }))
    .sort((a, b) => a.meanL2 - b.meanL2);

  console.log('  Top 20 most similar multi-character pairs:\n');
  for (const r of ranked.slice(0, 20)) {
    console.log(`    ${r.key.padEnd(30)} L2=${r.meanL2.toFixed(4)} NCC=${r.meanNCC.toFixed(4)} (${r.fontCount} fonts)`);
  }

  // Write summary line
  const elapsed = (Date.now() - t0) / 1000;
  const summary: JsonlSummary = {
    type: 'summary',
    totalScores: scores.length,
    uniqueMappings: byMapping.size,
    elapsed: Math.round(elapsed * 10) / 10,
  };
  fs.writeSync(fd, JSON.stringify(summary) + '\n');
  fs.closeSync(fd);

  console.log(`\n  Written: ${OUTPUT_PATH}`);
  console.log(`\nDone in ${elapsed.toFixed(1)}s.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
