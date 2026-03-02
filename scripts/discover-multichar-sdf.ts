/**
 * discover-multichar-sdf.ts -- Phase 5: multi-character discovery
 *
 * Bank-accelerated three-stage filter pipeline to discover novel
 * multi-character confusables:
 *
 * 1. Advance width filter -- reject bigrams whose combined width is >15% off
 *    from the bank target's stored advanceWidth
 * 2. Ray topology filter -- compareCountArrays() on flat count arrays
 *    from worker (bigram) vs bank (target), no object allocation
 * 3. SDF scoring -- compute 128x128 SDF distance for surviving pairs
 *
 * Search space: 676 Latin bigrams x all bank entries (~133K) x all fonts.
 * The width filter eliminates 95%+ immediately, keeping comparison count
 * tractable. Cross-script discoveries (Latin bigram matching Cyrillic/Greek/
 * Armenian single character) are the novel findings.
 *
 * Output includes per-font attribution for each discovery.
 * Uses JSONL streaming output with per-font resume capability.
 *
 * Usage: npx tsx scripts/discover-multichar-sdf.ts
 *        npx tsx scripts/discover-multichar-sdf.ts --scorer=ray   (default, no SDF)
 *        npx tsx scripts/discover-multichar-sdf.ts --scorer=sdf   (ray pre-filter + SDF gate)
 *        npx tsx scripts/discover-multichar-sdf.ts --scorer=both  (ray gate + SDF for comparison)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  loadFont,
  evictFontCache,
  concatGlyphPaths,
  extractGlyphPath,
  getFontMetrics,
  normalizeToGrid,
  getBaselineRow,
} from '../src/glyph-path.js';
import { compareSDF } from '../src/sdf.js';
import { initFonts } from '../src/fonts.js';
import {
  loadFullBankByFont,
  compareEnrichedArrays,
} from '../src/signature-bank.js';
import type { FontEntry, PathSegment, SDFGrid } from '../src/types.js';
import type { CompactBankTarget } from '../src/signature-bank.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BANK_PATH = path.join(ROOT, 'data/output/signature-bank.jsonl.gz');
const OUTPUT_PATH = path.join(ROOT, 'data/output/multichar-discoveries-sdf.jsonl');
const WORKER_PATH = path.resolve(import.meta.dirname, 'compute-worker.mjs');

const GRID_SIZE = 128;
const NUM_ANGLES = 36;
const RAYS_PER_ANGLE = 50;
const WIDTH_TOLERANCE = 0.15;
const RAY_THRESHOLD = 2.0;
const SDF_L2_THRESHOLD = 15.0;

// ---- Scorer mode ----

type ScorerMode = 'ray' | 'sdf' | 'both';
const scorerArg = process.argv.find(a => a.startsWith('--scorer='));
const SCORER: ScorerMode = (scorerArg?.split('=')[1] as ScorerMode) ?? 'ray';
if (!['ray', 'sdf', 'both'].includes(SCORER)) {
  console.error(`Invalid --scorer value: ${SCORER}. Use ray, sdf, or both.`);
  process.exit(1);
}
const useSdf = SCORER !== 'ray';

// ---- Bigram generators ----

type BigramGenerator = () => string[];

const LATIN_BIGRAMS: BigramGenerator = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const bigrams: string[] = [];
  for (const a of chars) {
    for (const b of chars) {
      bigrams.push(a + b);
    }
  }
  return bigrams;
};

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

// ---- Types ----

interface Discovery {
  bigram: string;
  target: string;
  targetCodepoint: string;
  font: string;
  sdfL2: number;
  sdfNCC: number;
  rayDistance: number;
}

// ---- JSONL helpers ----

interface JsonlMeta {
  type: 'meta';
  scorer?: string;
  gridSize: number;
  numAngles: number;
  raysPerAngle: number;
  widthTolerance: number;
  rayThreshold: number;
  sdfL2Threshold: number;
  startedAt: string;
}

interface JsonlDiscovery {
  type: 'discovery';
  bigram: string;
  target: string;
  targetCodepoint: string;
  font: string;
  sdfL2: number;
  sdfNCC: number;
  rayDistance: number;
}

interface JsonlFontDone {
  type: 'font-done';
  font: string;
  targets: number;
  widthFiltered: number;
  rayFiltered: number;
  sdfComputed: number;
  discoveries: number;
  elapsed: number;
}

interface JsonlSummary {
  type: 'summary';
  totalDiscoveries: number;
  uniquePairs: number;
  elapsed: number;
}

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

function loadExistingDiscoveries(outputPath: string): Discovery[] {
  const discoveries: Discovery[] = [];
  if (!fs.existsSync(outputPath)) return discoveries;

  const content = fs.readFileSync(outputPath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'discovery') {
        discoveries.push({
          bigram: entry.bigram,
          target: entry.target,
          targetCodepoint: entry.targetCodepoint,
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
  return discoveries;
}

async function main(): Promise<void> {
  console.log(`=== Multi-Character Discovery (scorer: ${SCORER}) ===\n`);
  const t0 = Date.now();

  const numCpus = os.cpus().length;
  const numWorkers = Math.max(1, numCpus - 1);

  console.log('[1/6] Initialising fonts...\n');
  const allFonts = initFonts();

  // Build font registry keyed by family name for bank cross-reference
  const fontRegistry = new Map<string, FontEntry>();
  for (const f of allFonts) {
    if (f.available) fontRegistry.set(f.family, f);
  }

  console.log('[2/6] Loading signature bank...');
  if (!fs.existsSync(BANK_PATH)) {
    console.error(`  Signature bank not found: ${BANK_PATH}`);
    console.error('  Run: npm run build-signature-bank');
    process.exit(1);
  }

  const { meta: bankMeta, index: bankIndex } = await loadFullBankByFont(BANK_PATH);
  let totalBankEntries = 0;
  for (const fontMap of bankIndex.values()) {
    totalBankEntries += fontMap.size;
  }
  console.log(`  ${bankIndex.size} fonts, ${totalBankEntries} total entries loaded`);
  if (bankMeta) {
    console.log(`  Bank params: grid=${bankMeta.gridSize}, angles=${bankMeta.numAngles}, rays=${bankMeta.raysPerAngle}`);
  }
  console.log('');

  const generateBigrams = LATIN_BIGRAMS;
  const bigrams = generateBigrams();
  console.log(`[3/6] Search space: ${bigrams.length} bigrams x ${bankIndex.size} fonts\n`);

  // ---- Resume check ----
  const completedFonts = scanCompletedFonts(OUTPUT_PATH);
  const existingDiscoveries = completedFonts.size > 0 ? loadExistingDiscoveries(OUTPUT_PATH) : [];

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  let fd: number;
  if (completedFonts.size === 0) {
    // Fresh start: write meta line
    const meta: JsonlMeta = {
      type: 'meta',
      scorer: SCORER,
      gridSize: GRID_SIZE,
      numAngles: NUM_ANGLES,
      raysPerAngle: RAYS_PER_ANGLE,
      widthTolerance: WIDTH_TOLERANCE,
      rayThreshold: RAY_THRESHOLD,
      sdfL2Threshold: SDF_L2_THRESHOLD,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(meta) + '\n');
    fd = fs.openSync(OUTPUT_PATH, 'a');
  } else {
    console.log(`  Resuming: ${completedFonts.size} fonts already processed, ${existingDiscoveries.length} existing discoveries`);
    fd = fs.openSync(OUTPUT_PATH, 'a');
  }

  console.log(`[4/6] Running discovery pipeline (${numWorkers} workers)...\n`);

  const pool = new ComputePool(numWorkers);
  const fontLRU = new FontLRU(30);

  const discoveries: Discovery[] = [...existingDiscoveries];
  let totalPairs = 0;
  let totalWidthFiltered = 0;
  let totalRayFiltered = 0;
  let totalSdfComputed = 0;

  // Process font by font: each font in the bank index
  const bankFontFamilies = [...bankIndex.keys()].sort();
  let fontIdx = 0;

  for (const fontFamily of bankFontFamilies) {
    fontIdx++;

    // Skip already-completed fonts (resume)
    if (completedFonts.has(fontFamily)) continue;

    const fontEntry = fontRegistry.get(fontFamily);
    if (!fontEntry) continue;

    const font = fontLRU.get(fontEntry.path);
    if (!font) continue;

    const metrics = getFontMetrics(font);
    const baselineRow = getBaselineRow(metrics, GRID_SIZE);
    const fontTargets = bankIndex.get(fontFamily)!;

    // Per-font target SDF cache (lazily populated, cleared each font)
    const targetSdfCache = useSdf ? new Map<number, SDFGrid>() : null;

    let fontWidthFiltered = 0;
    let fontRayFiltered = 0;
    let fontSdfComputed = 0;
    let fontDiscoveries = 0;
    const fontT0 = Date.now();

    for (const bigram of bigrams) {
      const seqPath = concatGlyphPaths(font, bigram);
      if (!seqPath) continue;

      const seqAdvance = seqPath.advanceWidth;
      const seqGrid = normalizeToGrid(seqPath, metrics, GRID_SIZE);

      // Stage 1: Width filter against all bank targets for this font
      const widthSurvivors: Array<[number, CompactBankTarget]> = [];
      for (const [cp, target] of fontTargets) {
        totalPairs++;
        const maxW = Math.max(seqAdvance, target.advanceWidth);
        if (maxW <= 0) continue;
        const ratio = Math.abs(seqAdvance - target.advanceWidth) / maxW;
        if (ratio > WIDTH_TOLERANCE) {
          fontWidthFiltered++;
          continue;
        }
        widthSurvivors.push([cp, target]);
      }

      if (widthSurvivors.length === 0) continue;

      // Compute bigram ray signature via worker (once per bigram per font)
      const bigramSig = await pool.computeSignature(seqGrid, NUM_ANGLES, RAYS_PER_ANGLE);

      // Stage 2: Ray topology filter (store ray distance for recording)
      const raySurvivors: Array<[number, CompactBankTarget, number]> = [];
      for (const [cp, target] of widthSurvivors) {
        const dist = compareEnrichedArrays(bigramSig.counts, bigramSig.positions, target.counts, target.positions, NUM_ANGLES, RAYS_PER_ANGLE, bigramSig.angles, target.angles, bigramSig.pingDistances, target.pingDistances, bigramSig.pingMax, target.pingMax);
        if (dist > RAY_THRESHOLD) {
          fontRayFiltered++;
          continue;
        }
        raySurvivors.push([cp, target, dist]);
      }

      if (raySurvivors.length === 0) continue;

      // ---- Scorer-dependent final gate ----

      if (!useSdf) {
        // Ray-only mode: ray threshold is the final gate
        for (const [cp, , rayDist] of raySurvivors) {
          const cpHex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
          const discovery: Discovery = {
            bigram,
            target: String.fromCodePoint(cp),
            targetCodepoint: cpHex,
            font: fontFamily,
            sdfL2: -1,
            sdfNCC: -1,
            rayDistance: Math.round(rayDist * 10000) / 10000,
          };
          discoveries.push(discovery);
          fontDiscoveries++;
          const jsonlEntry: JsonlDiscovery = { type: 'discovery', ...discovery };
          fs.writeSync(fd, JSON.stringify(jsonlEntry) + '\n');
        }
        continue;
      }

      // SDF or both mode: compute SDF at full resolution
      const bigramSdfP = pool.computeSDF(seqGrid, GRID_SIZE, GRID_SIZE, baselineRow);

      // Dispatch all uncached target SDFs in parallel
      const uncachedSurvivors: Array<{ cp: number; promise: Promise<Float64Array> }> = [];
      for (const [cp] of raySurvivors) {
        if (!targetSdfCache!.has(cp)) {
          const targetPath = extractGlyphPath(font, cp);
          if (!targetPath) continue;
          const targetGrid = normalizeToGrid(targetPath, metrics, GRID_SIZE);
          uncachedSurvivors.push({ cp, promise: pool.computeSDF(targetGrid, GRID_SIZE, GRID_SIZE, baselineRow) });
        }
      }

      // Await bigram + all uncached targets simultaneously
      const [bigramSdfData, ...newTargetSdfDatas] = await Promise.all([
        bigramSdfP,
        ...uncachedSurvivors.map(s => s.promise),
      ]);

      const bigramSdf: SDFGrid = { width: GRID_SIZE, height: GRID_SIZE, data: bigramSdfData, baselineRow };

      // Populate cache with newly computed target SDFs
      for (let i = 0; i < uncachedSurvivors.length; i++) {
        const sdfData = newTargetSdfDatas[i]!;
        targetSdfCache!.set(uncachedSurvivors[i]!.cp, {
          width: GRID_SIZE,
          height: GRID_SIZE,
          data: sdfData,
          baselineRow,
        });
      }

      for (const [cp, , rayDist] of raySurvivors) {
        const targetSdf = targetSdfCache!.get(cp);
        if (!targetSdf) continue;

        const sdfResult = compareSDF(bigramSdf, targetSdf);
        fontSdfComputed++;

        // In 'sdf' mode: gate on SDF threshold. In 'both' mode: record everything.
        const isDiscovery = SCORER === 'both' || sdfResult.l2 < SDF_L2_THRESHOLD;

        if (isDiscovery) {
          const cpHex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
          const discovery: Discovery = {
            bigram,
            target: String.fromCodePoint(cp),
            targetCodepoint: cpHex,
            font: fontFamily,
            sdfL2: sdfResult.l2,
            sdfNCC: sdfResult.ncc,
            rayDistance: Math.round(rayDist * 10000) / 10000,
          };

          discoveries.push(discovery);
          fontDiscoveries++;

          // Write discovery to JSONL
          const jsonlEntry: JsonlDiscovery = { type: 'discovery', ...discovery };
          fs.writeSync(fd, JSON.stringify(jsonlEntry) + '\n');
        }
      }
    }

    totalWidthFiltered += fontWidthFiltered;
    totalRayFiltered += fontRayFiltered;
    totalSdfComputed += fontSdfComputed;

    // Write font-done marker
    const fontElapsed = (Date.now() - fontT0) / 1000;
    const fontDone: JsonlFontDone = {
      type: 'font-done',
      font: fontFamily,
      targets: fontTargets.size,
      widthFiltered: fontWidthFiltered,
      rayFiltered: fontRayFiltered,
      sdfComputed: fontSdfComputed,
      discoveries: fontDiscoveries,
      elapsed: Math.round(fontElapsed * 10) / 10,
    };
    fs.writeSync(fd, JSON.stringify(fontDone) + '\n');

    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `  [${fontIdx}/${bankFontFamilies.length}] ${fontFamily}: ` +
      `targets=${fontTargets.size}, width-pass=${fontTargets.size * bigrams.length - fontWidthFiltered - fontRayFiltered - fontSdfComputed}, ` +
      `ray-pass=${fontSdfComputed}, discoveries=${fontDiscoveries} (${elapsed}s)`,
    );

    // Clear target SDF cache for this font
    targetSdfCache?.clear();
  }

  await pool.shutdown();

  // --- Summary ---
  console.log(`\n[5/6] Pipeline Summary\n`);
  console.log(`  Total pairs considered: ${totalPairs}`);
  console.log(`  Width filtered:         ${totalWidthFiltered} (${totalPairs > 0 ? (totalWidthFiltered / totalPairs * 100).toFixed(1) : 0}%)`);
  console.log(`  Ray filtered:           ${totalRayFiltered}`);
  console.log(`  SDF computed:           ${totalSdfComputed}`);
  console.log(`  Discoveries:            ${discoveries.length}`);

  // Sort discoveries by SDF L2
  discoveries.sort((a, b) => a.sdfL2 - b.sdfL2);

  console.log(`\n[6/6] Top discoveries\n`);
  for (const d of discoveries.slice(0, 30)) {
    console.log(`  "${d.bigram}" -> "${d.target}" (${d.targetCodepoint}) in ${d.font}: L2=${d.sdfL2.toFixed(3)}, NCC=${d.sdfNCC.toFixed(3)}, Ray=${d.rayDistance.toFixed(3)}`);
  }

  // Group by bigram->target, show which fonts found each
  const byPair = new Map<string, Discovery[]>();
  for (const d of discoveries) {
    const key = `${d.bigram} -> ${d.target}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(d);
  }

  console.log(`\n  Unique bigram->target pairs: ${byPair.size}`);
  console.log('  Cross-font consistency:');
  const sortedPairs = [...byPair.entries()]
    .sort(([, a], [, b]) => {
      const avgA = a.reduce((s, d) => s + d.sdfL2, 0) / a.length;
      const avgB = b.reduce((s, d) => s + d.sdfL2, 0) / b.length;
      return avgA - avgB;
    });
  for (const [key, fontResults] of sortedPairs.slice(0, 20)) {
    const fonts = fontResults.map(r => r.font).join(', ');
    const avgL2 = fontResults.reduce((a, b) => a + b.sdfL2, 0) / fontResults.length;
    console.log(`    ${key.padEnd(20)} L2=${avgL2.toFixed(3)} (${fontResults.length} fonts: ${fonts})`);
  }

  // Write summary line
  const elapsed = (Date.now() - t0) / 1000;
  const summary: JsonlSummary = {
    type: 'summary',
    totalDiscoveries: discoveries.length,
    uniquePairs: byPair.size,
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
