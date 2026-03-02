/**
 * discover-singlechar-sdf.ts -- Full cross-script single-character confusable discovery via SDF
 *
 * Uses the signature bank (precomputed ray signatures + advance widths) to run
 * a three-stage filter cascade across all 66 cross-script pairs:
 *
 * 1. Advance width filter -- reject pairs whose widths differ by >15%
 * 2. Ray topology filter -- compareCountArrays() on precomputed bank signatures
 * 3. SDF scoring -- compute 128x128 SDF distance for survivors
 *
 * Both source and target codepoints are in the bank, so stages 1-2 are pure
 * arithmetic lookups. Only stage 3 requires glyph path extraction and SDF
 * computation via worker threads.
 *
 * Output: JSONL with per-font resume capability.
 *
 * Usage: npm run discover-singlechar-sdf
 *        npx tsx scripts/discover-singlechar-sdf.ts --scorer=ray   (default, no SDF)
 *        npx tsx scripts/discover-singlechar-sdf.ts --scorer=sdf   (ray pre-filter + SDF gate)
 *        npx tsx scripts/discover-singlechar-sdf.ts --scorer=both  (ray gate + SDF for comparison)
 */

import fs from 'node:fs';
import os from 'node:os';
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
import {
  loadFullBankByFont,
  compareEnrichedArrays,
} from '../src/signature-bank.js';
import type { FontEntry, PathSegment, SDFGrid } from '../src/types.js';
import type { CompactBankTarget } from '../src/signature-bank.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BANK_PATH = path.join(ROOT, 'data/output/signature-bank.jsonl.gz');
const SETS_PATH = path.join(ROOT, 'data/output/cross-script-sets.json');
const OUTPUT_PATH = path.join(ROOT, 'data/output/singlechar-sdf-discoveries.jsonl');
const WORKER_PATH = path.resolve(import.meta.dirname, 'compute-worker.mjs');

const GRID_SIZE = 128;
const NUM_ANGLES = 36;
const RAYS_PER_ANGLE = 50;
const WIDTH_TOLERANCE = 0.15;
const RAY_THRESHOLD = 2.0;
const SDF_L2_THRESHOLD = 15.0;
const SDF_NCC_FLOOR = 0.85; // Minimum NCC to count as a discovery

// ---- Scorer mode ----

type ScorerMode = 'ray' | 'sdf' | 'both';
const scorerArg = process.argv.find(a => a.startsWith('--scorer='));
const SCORER: ScorerMode = (scorerArg?.split('=')[1] as ScorerMode) ?? 'ray';
if (!['ray', 'sdf', 'both'].includes(SCORER)) {
  console.error(`Invalid --scorer value: ${SCORER}. Use ray, sdf, or both.`);
  process.exit(1);
}

// ---- Types ----

interface ScriptSet {
  name: string;
  codepoints: Set<number>;
}

interface Discovery {
  source: string;
  sourceCodepoint: string;
  sourceScript: string;
  target: string;
  targetCodepoint: string;
  targetScript: string;
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

// ---- Load cross-script sets ----

function loadScriptSets(): ScriptSet[] {
  if (!fs.existsSync(SETS_PATH)) {
    console.error(`Cross-script sets not found: ${SETS_PATH}`);
    console.error('Run: npx tsx scripts/define-cross-script-sets.ts');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(SETS_PATH, 'utf-8'));
  const scripts: ScriptSet[] = [];

  for (const [name, info] of Object.entries(data.scripts) as [string, any][]) {
    const codepoints = new Set<number>();
    for (const char of info.characters) {
      const cp = parseInt(char.codepoint.replace('U+', ''), 16);
      codepoints.add(cp);
    }
    scripts.push({ name, codepoints });
  }

  return scripts;
}

/**
 * Generate all cross-script pairs (A, B) where A < B alphabetically.
 * Each pair is scored bidirectionally (A chars vs B chars + B chars vs A chars).
 */
function generateScriptPairs(scripts: ScriptSet[]): Array<[ScriptSet, ScriptSet]> {
  const pairs: Array<[ScriptSet, ScriptSet]> = [];
  for (let i = 0; i < scripts.length; i++) {
    for (let j = i + 1; j < scripts.length; j++) {
      pairs.push([scripts[i]!, scripts[j]!]);
    }
  }
  return pairs;
}

// ---- Resume support ----

function scanCompletedFonts(outputPath: string): Set<string> {
  const completed = new Set<string>();
  if (!fs.existsSync(outputPath)) return completed;

  const content = fs.readFileSync(outputPath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'font-done') completed.add(entry.font);
    } catch { /* skip */ }
  }
  return completed;
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
          source: entry.source,
          sourceCodepoint: entry.sourceCodepoint,
          sourceScript: entry.sourceScript,
          target: entry.target,
          targetCodepoint: entry.targetCodepoint,
          targetScript: entry.targetScript,
          font: entry.font,
          sdfL2: entry.sdfL2,
          sdfNCC: entry.sdfNCC,
          rayDistance: entry.rayDistance,
        });
      }
    } catch { /* skip */ }
  }
  return discoveries;
}

function cpToHex(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

// ---- Main ----

async function main(): Promise<void> {
  console.log(`=== Single-Character Cross-Script Discovery (scorer: ${SCORER}) ===\n`);
  const t0 = Date.now();

  const numCpus = os.cpus().length;
  const numWorkers = Math.max(1, numCpus - 1);

  // Load cross-script sets
  console.log('[1/6] Loading cross-script sets...');
  const scripts = loadScriptSets();
  for (const s of scripts) {
    console.log(`  ${s.name}: ${s.codepoints.size} codepoints`);
  }
  const totalChars = scripts.reduce((sum, s) => sum + s.codepoints.size, 0);
  console.log(`  Total: ${totalChars} characters across ${scripts.length} scripts`);

  const scriptPairs = generateScriptPairs(scripts);
  console.log(`  ${scriptPairs.length} cross-script pairs\n`);

  // Build codepoint -> script lookup
  const cpToScript = new Map<number, string>();
  for (const s of scripts) {
    for (const cp of s.codepoints) {
      cpToScript.set(cp, s.name);
    }
  }

  // Init fonts
  console.log('[2/6] Initialising fonts...');
  const allFonts = initFonts();
  const fontRegistry = new Map<string, FontEntry>();
  for (const f of allFonts) {
    if (f.available) fontRegistry.set(f.family, f);
  }
  console.log(`  ${fontRegistry.size} fonts available\n`);

  // Load signature bank
  console.log('[3/6] Loading signature bank...');
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
  console.log(`  ${bankIndex.size} fonts, ${totalBankEntries} total entries`);
  if (bankMeta) {
    console.log(`  Bank params: grid=${bankMeta.gridSize}, angles=${bankMeta.numAngles}, rays=${bankMeta.raysPerAngle}`);
  }
  console.log('');

  // Resume check
  const completedFonts = scanCompletedFonts(OUTPUT_PATH);
  const existingDiscoveries = completedFonts.size > 0 ? loadExistingDiscoveries(OUTPUT_PATH) : [];

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  let fd: number;
  if (completedFonts.size === 0) {
    const meta = {
      type: 'meta',
      scorer: SCORER,
      gridSize: GRID_SIZE,
      numAngles: NUM_ANGLES,
      raysPerAngle: RAYS_PER_ANGLE,
      widthTolerance: WIDTH_TOLERANCE,
      rayThreshold: RAY_THRESHOLD,
      sdfL2Threshold: SDF_L2_THRESHOLD,
      sdfNccFloor: SDF_NCC_FLOOR,
      scriptCount: scripts.length,
      scriptPairCount: scriptPairs.length,
      totalCharacters: totalChars,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(meta) + '\n');
    fd = fs.openSync(OUTPUT_PATH, 'a');
  } else {
    console.log(`  Resuming: ${completedFonts.size} fonts done, ${existingDiscoveries.length} existing discoveries\n`);
    fd = fs.openSync(OUTPUT_PATH, 'a');
  }

  const useSdf = SCORER !== 'ray';
  console.log(`[4/6] Running discovery pipeline (${useSdf ? numWorkers + ' workers' : 'ray-only, no workers'})...\n`);

  const pool = useSdf ? new ComputePool(numWorkers) : null;
  const fontLRU = new FontLRU(30);

  const discoveries: Discovery[] = [...existingDiscoveries];
  let totalPairs = 0;
  let totalWidthFiltered = 0;
  let totalRayFiltered = 0;
  let totalSdfComputed = 0;

  // Process font by font
  const bankFontFamilies = [...bankIndex.keys()].sort();
  let fontIdx = 0;

  for (const fontFamily of bankFontFamilies) {
    fontIdx++;

    if (completedFonts.has(fontFamily)) continue;

    const fontEntry = fontRegistry.get(fontFamily);
    if (!fontEntry) continue;

    const font = fontLRU.get(fontEntry.path);
    if (!font) continue;

    const metrics = getFontMetrics(font);
    const baselineRow = getBaselineRow(metrics, GRID_SIZE);
    const fontTargets = bankIndex.get(fontFamily)!;

    // Partition bank entries by script for this font, sorted by advance width
    interface WidthSortedEntry { cp: number; bank: CompactBankTarget }
    const byScript = new Map<string, WidthSortedEntry[]>();
    for (const [cp, target] of fontTargets) {
      const script = cpToScript.get(cp);
      if (!script) continue;
      let arr = byScript.get(script);
      if (!arr) {
        arr = [];
        byScript.set(script, arr);
      }
      arr.push({ cp, bank: target });
    }
    // Sort each script's entries by advance width for binary search
    for (const arr of byScript.values()) {
      arr.sort((a, b) => a.bank.advanceWidth - b.bank.advanceWidth);
    }

    // SDF cache for this font (cleared after each font)
    const sdfCache = useSdf ? new Map<number, SDFGrid>() : null;

    let fontWidthFiltered = 0;
    let fontRayFiltered = 0;
    let fontSdfComputed = 0;
    let fontDiscoveries = 0;
    let fontSkippedPairs = 0;
    const fontT0 = Date.now();

    // For each cross-script pair
    for (const [scriptA, scriptB] of scriptPairs) {
      const charsA = byScript.get(scriptA.name);
      const charsB = byScript.get(scriptB.name);
      if (!charsA || !charsB) continue;

      // Width range pre-check: skip entire script pair if width ranges
      // don't overlap (with tolerance). O(1) instead of O(N*M).
      const minA = charsA[0]!.bank.advanceWidth;
      const maxA = charsA[charsA.length - 1]!.bank.advanceWidth;
      const minB = charsB[0]!.bank.advanceWidth;
      const maxB = charsB[charsB.length - 1]!.bank.advanceWidth;
      // Expand ranges by tolerance
      const expandedMinA = minA * (1 - WIDTH_TOLERANCE);
      const expandedMaxA = maxA * (1 + WIDTH_TOLERANCE);
      if (expandedMaxA < minB || maxB * (1 + WIDTH_TOLERANCE) < minA) {
        fontSkippedPairs += charsA.length * charsB.length;
        continue;
      }

      // For very large script pairs (e.g. Han x Hangul), tighten the ray
      // threshold to reduce the comparison count. These pairs rarely produce
      // security-relevant confusables, so a stricter filter is acceptable.
      const pairSize = charsA.length * charsB.length;
      const effectiveRayThreshold = pairSize > 500_000 ? RAY_THRESHOLD * 0.5 : RAY_THRESHOLD;

      // For each char in A, binary search for width-compatible chars in B
      for (const entryA of charsA) {
        const wA = entryA.bank.advanceWidth;
        if (wA <= 0) continue;

        // Width tolerance bounds for B
        const loW = wA / (1 + WIDTH_TOLERANCE); // min B width
        const hiW = wA * (1 + WIDTH_TOLERANCE); // max B width (approximate)

        // Binary search for lower bound in sorted B array
        let lo = 0;
        let hi = charsB.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (charsB[mid]!.bank.advanceWidth < loW) lo = mid + 1;
          else hi = mid;
        }
        const startIdx = lo;

        // Binary search for upper bound
        hi = charsB.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (charsB[mid]!.bank.advanceWidth <= hiW) lo = mid + 1;
          else hi = mid;
        }
        const endIdx = lo;

        // Count filtered-out pairs
        fontWidthFiltered += charsB.length - (endIdx - startIdx);
        totalPairs += charsB.length;

        // Iterate only over width-compatible chars in B
        for (let bi = startIdx; bi < endIdx; bi++) {
          const entryB = charsB[bi]!;

          // Stage 2: Ray topology filter
          const rayDist = compareEnrichedArrays(entryA.bank.counts, entryA.bank.positions, entryB.bank.counts, entryB.bank.positions, NUM_ANGLES, RAYS_PER_ANGLE, entryA.bank.angles, entryB.bank.angles, entryA.bank.pingDistances, entryB.bank.pingDistances, entryA.bank.pingMax, entryB.bank.pingMax);
          if (rayDist > effectiveRayThreshold) {
            fontRayFiltered++;
            continue;
          }

          // ---- Scorer-dependent final gate ----

          if (!useSdf) {
            // Ray-only mode: ray threshold is the final gate
            const discovery: Discovery = {
              source: String.fromCodePoint(entryA.cp),
              sourceCodepoint: cpToHex(entryA.cp),
              sourceScript: scriptA.name,
              target: String.fromCodePoint(entryB.cp),
              targetCodepoint: cpToHex(entryB.cp),
              targetScript: scriptB.name,
              font: fontFamily,
              sdfL2: -1,
              sdfNCC: -1,
              rayDistance: Math.round(rayDist * 10000) / 10000,
            };
            discoveries.push(discovery);
            fontDiscoveries++;
            fs.writeSync(fd, JSON.stringify({ type: 'discovery', ...discovery }) + '\n');
            continue;
          }

          // SDF or both mode: compute SDF
          let sdfA = sdfCache!.get(entryA.cp);
          let sdfB = sdfCache!.get(entryB.cp);

          const promises: Promise<void>[] = [];

          if (!sdfA) {
            const pathA = extractGlyphPath(font, entryA.cp);
            if (!pathA) continue;
            if (pathA.segments.length > 5000) continue;
            const gridA = normalizeToGrid(pathA, metrics, GRID_SIZE);
            if (gridA.length === 0) continue;
            promises.push(
              pool!.computeSDF(gridA, GRID_SIZE, GRID_SIZE, baselineRow).then(data => {
                sdfA = { width: GRID_SIZE, height: GRID_SIZE, data, baselineRow };
                sdfCache!.set(entryA.cp, sdfA!);
              })
            );
          }

          if (!sdfB) {
            const pathB = extractGlyphPath(font, entryB.cp);
            if (!pathB) continue;
            if (pathB.segments.length > 5000) continue;
            const gridB = normalizeToGrid(pathB, metrics, GRID_SIZE);
            if (gridB.length === 0) continue;
            promises.push(
              pool!.computeSDF(gridB, GRID_SIZE, GRID_SIZE, baselineRow).then(data => {
                sdfB = { width: GRID_SIZE, height: GRID_SIZE, data, baselineRow };
                sdfCache!.set(entryB.cp, sdfB!);
              })
            );
          }

          if (promises.length > 0) {
            await Promise.all(promises);
          }

          if (!sdfA || !sdfB) continue;

          const result = compareSDF(sdfA, sdfB);
          fontSdfComputed++;

          // In 'sdf' mode: gate on SDF thresholds. In 'both' mode: record everything.
          const isDiscovery = SCORER === 'both'
            || (result.l2 < SDF_L2_THRESHOLD && result.ncc >= SDF_NCC_FLOOR);

          if (isDiscovery) {
            const discovery: Discovery = {
              source: String.fromCodePoint(entryA.cp),
              sourceCodepoint: cpToHex(entryA.cp),
              sourceScript: scriptA.name,
              target: String.fromCodePoint(entryB.cp),
              targetCodepoint: cpToHex(entryB.cp),
              targetScript: scriptB.name,
              font: fontFamily,
              sdfL2: Math.round(result.l2 * 10000) / 10000,
              sdfNCC: Math.round(result.ncc * 10000) / 10000,
              rayDistance: Math.round(rayDist * 10000) / 10000,
            };

            discoveries.push(discovery);
            fontDiscoveries++;

            fs.writeSync(fd, JSON.stringify({ type: 'discovery', ...discovery }) + '\n');
          }
        }
      }
    }

    totalWidthFiltered += fontWidthFiltered;
    totalRayFiltered += fontRayFiltered;
    totalSdfComputed += fontSdfComputed;

    // Write font-done marker
    const fontElapsed = (Date.now() - fontT0) / 1000;
    const fontDone = {
      type: 'font-done',
      font: fontFamily,
      scriptsFound: byScript.size,
      widthFiltered: fontWidthFiltered,
      rayFiltered: fontRayFiltered,
      sdfComputed: fontSdfComputed,
      discoveries: fontDiscoveries,
      elapsed: Math.round(fontElapsed * 10) / 10,
    };
    fs.writeSync(fd, JSON.stringify(fontDone) + '\n');

    // Clear SDF cache for this font
    sdfCache?.clear();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      `  [${fontIdx}/${bankFontFamilies.length}] ${fontFamily}: ` +
      `scripts=${byScript.size}, sdf=${fontSdfComputed}, ` +
      `discoveries=${fontDiscoveries} (${fontElapsed.toFixed(1)}s, total ${elapsed}s)`,
    );
  }

  if (pool) await pool.shutdown();

  // --- Summary ---
  console.log('\n[5/6] Pipeline Summary\n');
  console.log(`  Total pairs considered: ${totalPairs.toLocaleString()}`);
  console.log(`  Width filtered:         ${totalWidthFiltered.toLocaleString()} (${totalPairs > 0 ? (totalWidthFiltered / totalPairs * 100).toFixed(1) : 0}%)`);
  console.log(`  Ray filtered:           ${totalRayFiltered.toLocaleString()}`);
  console.log(`  SDF computed:           ${totalSdfComputed.toLocaleString()}`);
  console.log(`  Discoveries:            ${discoveries.length}`);

  // Group by source->target pair
  const byPair = new Map<string, Discovery[]>();
  for (const d of discoveries) {
    const key = `${d.sourceCodepoint}|${d.targetCodepoint}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(d);
  }

  console.log(`  Unique pairs: ${byPair.size}`);

  // Top discoveries
  console.log('\n[6/6] Top discoveries (by best L2 across fonts)\n');
  const sortedPairs = [...byPair.entries()]
    .map(([key, fontResults]) => {
      const best = fontResults.reduce((a, b) => a.sdfL2 < b.sdfL2 ? a : b);
      const avgL2 = fontResults.reduce((s, d) => s + d.sdfL2, 0) / fontResults.length;
      const avgNCC = fontResults.reduce((s, d) => s + d.sdfNCC, 0) / fontResults.length;
      return { key, best, avgL2, avgNCC, fontCount: fontResults.length };
    })
    .sort((a, b) => a.avgL2 - b.avgL2);

  for (const p of sortedPairs.slice(0, 40)) {
    const { best } = p;
    console.log(
      `  ${best.source} (${best.sourceCodepoint}, ${best.sourceScript}) -> ` +
      `${best.target} (${best.targetCodepoint}, ${best.targetScript})  ` +
      `avgL2=${p.avgL2.toFixed(2)}  avgNCC=${p.avgNCC.toFixed(3)}  fonts=${p.fontCount}`,
    );
  }

  // Script pair breakdown
  console.log('\n  Discoveries by script pair:');
  const byScriptPair = new Map<string, number>();
  for (const d of discoveries) {
    const key = `${d.sourceScript}-${d.targetScript}`;
    byScriptPair.set(key, (byScriptPair.get(key) ?? 0) + 1);
  }
  const sortedScriptPairs = [...byScriptPair.entries()].sort(([, a], [, b]) => b - a);
  for (const [pair, count] of sortedScriptPairs) {
    console.log(`    ${pair}: ${count}`);
  }

  // Write summary
  const elapsed = (Date.now() - t0) / 1000;
  const summary = {
    type: 'summary',
    totalDiscoveries: discoveries.length,
    uniquePairs: byPair.size,
    totalPairsConsidered: totalPairs,
    widthFiltered: totalWidthFiltered,
    rayFiltered: totalRayFiltered,
    sdfComputed: totalSdfComputed,
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
