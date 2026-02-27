/**
 * score-cross-script.ts -- Milestone 5, Step 3
 *
 * Scores all 66 cross-script pairs (12 choose 2). For each pair, compares
 * every character from script A against every character from script B using
 * pHash prefilter + SSIM via worker threads.
 *
 * Sorted by expected yield: high-value pairs first (Cyrillic-Greek,
 * Armenian-Georgian, Latin-Cyrillic), Han pairs last.
 *
 * Output per pair: data/output/cross-script-scores/{ScriptA}-{ScriptB}.json.gz
 *
 * Prerequisite:
 *   npx tsx scripts/define-cross-script-sets.ts
 *   npx tsx scripts/build-index-cross-script.ts
 *
 * Usage:
 *   npx tsx scripts/score-cross-script.ts                  # all pairs
 *   npx tsx scripts/score-cross-script.ts --fresh           # force fresh
 *   npx tsx scripts/score-cross-script.ts --pair Greek Cyrillic  # single pair
 */

process.env.UV_THREADPOOL_SIZE = '16';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { decode as decodePng } from 'fast-png';
import { pHashSimilarity } from '../src/compare.js';
import { createGzWriter } from '../src/gz-json.js';
// @ts-ignore -- plain JS module
import { decodeAndFindBoundsJS, getInkWidthFromBounds } from '../src/normalise-core.js';
import type { NormWorkItem, NormWorkResult } from '../src/ssim-worker.js';
import type {
  RenderIndex,
  IndexRenderEntry,
  PairFontResult,
  PairSummary,
  CrossScriptPairResult,
  RenderStatus,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PHASH_THRESHOLD = 0.3;
const WIDTH_RATIO_MAX = 1.5;
const INK_COVERAGE_MIN = 0.03;
const HAN_CHUNK_SIZE = 2000;
const WORKER_COUNT = Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1);
const WORKER_SCRIPT = path.resolve(import.meta.dirname, '..', 'src', 'ssim-worker.js');
const FORCE_FRESH = process.argv.includes('--fresh');

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX_ROOT = path.join(ROOT, 'data/output/cross-script-index');
const SCORES_DIR = path.join(ROOT, 'data/output/cross-script-scores');

const SINGLE_PAIR = (() => {
  const idx = process.argv.indexOf('--pair');
  return idx >= 0 ? [process.argv[idx + 1]!, process.argv[idx + 2]!] as [string, string] : null;
})();

// ---------------------------------------------------------------------------
// Worker pool (reused from score-multichar.ts)
// ---------------------------------------------------------------------------

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

function createWorkerPool(): PoolWorker[] {
  const pool: PoolWorker[] = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    pool.push({ worker: new Worker(WORKER_SCRIPT), busy: false });
  }
  return pool;
}

function runSsimBatch(pool: PoolWorker[], items: NormWorkItem[]): Promise<NormWorkResult[]> {
  if (items.length === 0) return Promise.resolve([]);

  const chunkSize = Math.ceil(items.length / pool.length);
  const chunks: NormWorkItem[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }

  return new Promise((resolve) => {
    const allResults: NormWorkResult[] = [];
    let pending = chunks.length;

    for (let i = 0; i < chunks.length; i++) {
      const pw = pool[i]!;
      pw.busy = true;

      const handler = (results: NormWorkResult[]) => {
        pw.worker.removeListener('message', handler);
        pw.busy = false;
        allResults.push(...results);
        if (--pending === 0) resolve(allResults);
      };

      pw.worker.on('message', handler);
      pw.worker.postMessage(chunks[i]);
    }
  });
}

function terminatePool(pool: PoolWorker[]): void {
  for (const pw of pool) pw.worker.terminate();
}

// ---------------------------------------------------------------------------
// Script pair enumeration (sorted by expected yield)
// ---------------------------------------------------------------------------

const SCRIPT_ORDER = [
  'Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian',
  'Arabic', 'Devanagari', 'Thai',
  'Hiragana', 'Katakana', 'Hangul', 'Han',
];

function enumeratePairs(): [string, string][] {
  const pairs: [string, string][] = [];
  // High-value first: scripts with shared ancestry
  const highValue: [string, string][] = [
    ['Cyrillic', 'Greek'],
    ['Armenian', 'Georgian'],
    ['Latin', 'Cyrillic'],
    ['Latin', 'Greek'],
    ['Latin', 'Armenian'],
    ['Hiragana', 'Katakana'],
  ];
  for (const pair of highValue) pairs.push(pair);

  // All remaining pairs in script order
  const seen = new Set(highValue.map(([a, b]) => `${a}-${b}`));
  for (let i = 0; i < SCRIPT_ORDER.length; i++) {
    for (let j = i + 1; j < SCRIPT_ORDER.length; j++) {
      const key = `${SCRIPT_ORDER[i]}-${SCRIPT_ORDER[j]}`;
      if (!seen.has(key)) {
        pairs.push([SCRIPT_ORDER[i], SCRIPT_ORDER[j]]);
        seen.add(key);
      }
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CachedDecode {
  pixels: Buffer;
  width: number;
  height: number;
  bounds: { top: number; bottom: number; left: number; right: number } | null;
}

interface DecodedChar {
  char: string;
  codepoint: string;
  fonts: Map<string, {
    entry: IndexRenderEntry;
    pHash: bigint;
    decoded: CachedDecode;
    inkWidth: number | null;
  }>;
}

interface PairProgressEntry {
  charA: string;
  pairs: CrossScriptPairResult[];
  ssimComputed: number;
  ssimSkipped: number;
  widthRatioSkipped: number;
  inkCoverageSkipped: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computePairSummary(fontResults: PairFontResult[]): PairSummary {
  const sourceFonts = new Map<string, RenderStatus>();
  for (const r of fontResults) {
    if (!sourceFonts.has(r.sourceFont)) {
      sourceFonts.set(r.sourceFont, r.sourceRenderStatus);
    }
  }
  const nativeCount = [...sourceFonts.values()].filter(s => s === 'native').length;
  const fallbackCount = [...sourceFonts.values()].filter(s => s === 'fallback').length;

  const ssimValues = fontResults.map(r => r.ssim).filter((v): v is number => v !== null);
  const pHashValues = fontResults.map(r => r.pHash).filter((v): v is number => v !== null);

  return {
    meanSsim: ssimValues.length > 0 ? mean(ssimValues) : null,
    meanPHash: pHashValues.length > 0 ? mean(pHashValues) : null,
    nativeFontCount: nativeCount,
    fallbackFontCount: fallbackCount,
    notdefFontCount: 0,
    validFontCount: fontResults.length,
  };
}

function formatCp(char: string): string {
  return 'U+' + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
}

function loadPairProgress(progressPath: string): Map<string, PairProgressEntry> {
  const completed = new Map<string, PairProgressEntry>();
  if (!fs.existsSync(progressPath)) return completed;

  const lines = fs.readFileSync(progressPath, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj: PairProgressEntry = JSON.parse(line);
      completed.set(obj.charA, obj);
    } catch {
      // Tolerate corrupt last line
    }
  }
  return completed;
}

// ---------------------------------------------------------------------------
// Load and decode a script index
// ---------------------------------------------------------------------------

/** Lightweight entry: pHash + inkWidth but no decoded pixels */
// ---------------------------------------------------------------------------
// Fast pHash comparison using 32-bit integers (avoids BigInt overhead)
// ---------------------------------------------------------------------------

function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

/** Convert a 64-bit pHash bigint to [hi32, lo32] for fast comparison */
function pHashToInts(hash: bigint): [number, number] {
  return [Number((hash >> 32n) & 0xFFFFFFFFn) | 0, Number(hash & 0xFFFFFFFFn) | 0];
}

/** Fast pHash similarity using pre-split 32-bit integers. Returns 0..1 */
function pHashSimFast(aHi: number, aLo: number, bHi: number, bLo: number): number {
  return 1 - (popcount32(aHi ^ bHi) + popcount32(aLo ^ bLo)) / 64;
}

interface LightEntry {
  char: string;
  font: string;
  entry: IndexRenderEntry;
  pHashHi: number;
  pHashLo: number;
  inkWidth: number | null;
}

/**
 * Load only pHash/metadata for a script (no pixel decoding).
 * Used for pre-filtering large scripts like Han before loading pixels.
 */
function loadScriptIndexLight(scriptName: string): LightEntry[] {
  const indexPath = path.join(INDEX_ROOT, scriptName, 'index.json');
  if (!fs.existsSync(indexPath)) {
    console.error(`ERROR: Index not found: ${indexPath}. Run build-index-cross-script.ts first.`);
    process.exit(1);
  }
  const index: RenderIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const entries: LightEntry[] = [];

  for (const [char, renders] of Object.entries(index.sources)) {
    if (!renders || renders.length === 0) continue;
    for (const entry of renders) {
      const hash = BigInt('0x' + entry.pHash);
      const [hi, lo] = pHashToInts(hash);
      entries.push({
        char,
        font: entry.font,
        entry,
        pHashHi: hi,
        pHashLo: lo,
        inkWidth: entry.inkWidth ?? null,
      });
    }
  }
  return entries;
}

/**
 * Load and decode a script index. When filterChars is provided, only loads
 * those characters (used for chunked Han processing).
 */
function loadScriptIndex(scriptName: string, filterChars?: Set<string>): DecodedChar[] {
  const indexPath = path.join(INDEX_ROOT, scriptName, 'index.json');
  const rendersDir = path.join(INDEX_ROOT, scriptName, 'renders');

  if (!fs.existsSync(indexPath)) {
    console.error(`ERROR: Index not found: ${indexPath}. Run build-index-cross-script.ts first.`);
    process.exit(1);
  }

  const index: RenderIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const chars: DecodedChar[] = [];

  for (const [char, entries] of Object.entries(index.sources)) {
    if (!entries || entries.length === 0) continue;
    if (filterChars && !filterChars.has(char)) continue;

    const fonts = new Map<string, {
      entry: IndexRenderEntry;
      pHash: bigint;
      decoded: CachedDecode;
      inkWidth: number | null;
    }>();

    for (const entry of entries) {
      const pngPath = path.join(rendersDir, entry.png);
      if (!fs.existsSync(pngPath)) continue;

      const rawPng = fs.readFileSync(pngPath);
      const pHash = BigInt('0x' + entry.pHash);
      const decoded: CachedDecode = decodeAndFindBoundsJS(decodePng, rawPng);
      const inkWidth = getInkWidthFromBounds(decoded.bounds);

      fonts.set(entry.font, { entry, pHash, decoded, inkWidth });
    }

    if (fonts.size > 0) {
      chars.push({ char, codepoint: formatCp(char), fonts });
    }
  }

  return chars;
}

// ---------------------------------------------------------------------------
// Score one script pair
// ---------------------------------------------------------------------------

async function scorePair(
  scriptA: string,
  scriptB: string,
  charsA: DecodedChar[],
  charsB: DecodedChar[],
  pool: PoolWorker[],
): Promise<void> {
  const pairName = `${scriptA}-${scriptB}`;
  const outputPath = path.join(SCORES_DIR, `${pairName}.json.gz`);
  const progressPath = path.join(SCORES_DIR, `${pairName}-progress.jsonl`);

  console.log(`\n--- ${pairName} (${charsA.length} x ${charsB.length} = ${charsA.length * charsB.length} char pairs) ---`);

  // Check if already complete
  if (!FORCE_FRESH && fs.existsSync(outputPath) && !fs.existsSync(progressPath)) {
    console.log('  Already complete, skipping.');
    return;
  }

  // Load resume state
  let completedProgress: Map<string, PairProgressEntry>;
  if (FORCE_FRESH || !fs.existsSync(progressPath)) {
    if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath);
    completedProgress = new Map();
  } else {
    completedProgress = loadPairProgress(progressPath);
    console.log(`  Resuming: ${completedProgress.size}/${charsA.length} chars done`);
  }

  const progressFd = fs.openSync(progressPath, 'a');
  const scoreStart = Date.now();

  const allResults: CrossScriptPairResult[] = [];
  let ssimComputed = 0;
  let ssimSkipped = 0;
  let widthRatioSkipped = 0;
  let inkCoverageSkipped = 0;
  let skippedResume = 0;

  // Build font lookup for B: Map<fontName, Map<char, ...>>
  const bByFont = new Map<string, Map<string, DecodedChar>>();
  for (const charB of charsB) {
    for (const [fontName] of charB.fonts) {
      if (!bByFont.has(fontName)) bByFont.set(fontName, new Map());
      bByFont.get(fontName)!.set(charB.char, charB);
    }
  }

  // Build flat pHash index for B (for cross-font top-1-by-pHash)
  // Uses pre-split 32-bit integers for fast comparison
  const bPHashIndex: Array<{ charB: DecodedChar; font: string; pHash: bigint; pHi: number; pLo: number }> = [];
  for (const charB of charsB) {
    for (const [font, data] of charB.fonts) {
      const [pHi, pLo] = pHashToInts(data.pHash);
      bPHashIndex.push({ charB, font, pHash: data.pHash, pHi, pLo });
    }
  }

  for (let i = 0; i < charsA.length; i++) {
    const charA = charsA[i];

    // Resume
    if (completedProgress.has(charA.char)) {
      const prev = completedProgress.get(charA.char)!;
      allResults.push(...prev.pairs);
      ssimComputed += prev.ssimComputed;
      ssimSkipped += prev.ssimSkipped;
      widthRatioSkipped += prev.widthRatioSkipped;
      inkCoverageSkipped += prev.inkCoverageSkipped;
      skippedResume++;
      continue;
    }

    const progressInterval = charsB.length > 5000 ? 5 : 50;
    if ((i - skippedResume) > 0 && (i - skippedResume) % progressInterval === 0) {
      const elapsed = (Date.now() - scoreStart) / 1000;
      const scored = i - skippedResume;
      const rate = scored / elapsed;
      const eta = Math.round((charsA.length - i) / rate);
      console.log(`  [${i}/${charsA.length}] ${rate.toFixed(0)} chars/s, ETA ${eta}s  (SSIM: ${ssimComputed}, skip: pHash ${ssimSkipped}, wRatio ${widthRatioSkipped}, ink ${inkCoverageSkipped})`);
    }

    const normWork: NormWorkItem[] = [];
    const workMeta: Array<{
      charB: DecodedChar;
      fontA: string;
      fontB: string;
      pHashScore: number;
    }> = [];

    // Same-font comparisons
    for (const [fontName, dataA] of charA.fonts) {
      const bInFont = bByFont.get(fontName);
      if (!bInFont) continue;

      const [aHi, aLo] = pHashToInts(dataA.pHash);

      for (const [charBStr, charB] of bInFont) {
        const dataB = charB.fonts.get(fontName)!;
        const [bHi, bLo] = pHashToInts(dataB.pHash);
        const pHashScore = pHashSimFast(aHi, aLo, bHi, bLo);

        if (pHashScore < PHASH_THRESHOLD) {
          ssimSkipped++;
          continue;
        }

        // Width-ratio gate
        if (dataA.inkWidth && dataB.inkWidth) {
          const ratio = Math.max(dataA.inkWidth, dataB.inkWidth) / Math.min(dataA.inkWidth, dataB.inkWidth);
          if (ratio > WIDTH_RATIO_MAX) {
            widthRatioSkipped++;
            continue;
          }
        }

        normWork.push({
          idx: workMeta.length,
          pixelsA: dataA.decoded.pixels,
          widthA: dataA.decoded.width,
          heightA: dataA.decoded.height,
          boundsA: dataA.decoded.bounds,
          pixelsB: dataB.decoded.pixels,
          widthB: dataB.decoded.width,
          heightB: dataB.decoded.height,
          boundsB: dataB.decoded.bounds,
          inkCoverageMin: INK_COVERAGE_MIN,
        });
        workMeta.push({ charB, fontA: fontName, fontB: fontName, pHashScore });
      }
    }

    // Cross-font: for each font covering charA that does NOT cover some charB,
    // find the best charB render by pHash across all fonts
    for (const [fontA, dataA] of charA.fonts) {
      const [aHi, aLo] = pHashToInts(dataA.pHash);

      // Find best B match by pHash (any font)
      let bestPHash = -1;
      let bestB: { charB: DecodedChar; font: string } | null = null;

      for (const item of bPHashIndex) {
        // Skip same-font (already handled above)
        if (item.font === fontA) continue;

        const sim = pHashSimFast(aHi, aLo, item.pHi, item.pLo);
        if (sim > bestPHash) {
          bestPHash = sim;
          bestB = { charB: item.charB, font: item.font };
        }
      }

      if (!bestB || bestPHash < PHASH_THRESHOLD) continue;

      const dataB = bestB.charB.fonts.get(bestB.font)!;

      // Width-ratio gate
      if (dataA.inkWidth && dataB.inkWidth) {
        const ratio = Math.max(dataA.inkWidth, dataB.inkWidth) / Math.min(dataA.inkWidth, dataB.inkWidth);
        if (ratio > WIDTH_RATIO_MAX) {
          widthRatioSkipped++;
          continue;
        }
      }

      normWork.push({
        idx: workMeta.length,
        pixelsA: dataA.decoded.pixels,
        widthA: dataA.decoded.width,
        heightA: dataA.decoded.height,
        boundsA: dataA.decoded.bounds,
        pixelsB: dataB.decoded.pixels,
        widthB: dataB.decoded.width,
        heightB: dataB.decoded.height,
        boundsB: dataB.decoded.bounds,
        inkCoverageMin: INK_COVERAGE_MIN,
      });
      workMeta.push({ charB: bestB.charB, fontA, fontB: bestB.font, pHashScore: bestPHash });
    }

    // Dispatch to workers
    const workerResults = await runSsimBatch(pool, normWork);

    // Collect results by charB
    const fontResultsByCharB = new Map<string, PairFontResult[]>();

    for (const result of workerResults) {
      if (result.inkSkipped) {
        inkCoverageSkipped++;
        continue;
      }
      ssimComputed++;
      const meta = workMeta[result.idx]!;
      const key = meta.charB.char;
      if (!fontResultsByCharB.has(key)) fontResultsByCharB.set(key, []);
      fontResultsByCharB.get(key)!.push({
        sourceFont: meta.fontA,
        targetFont: meta.fontB,
        ssim: result.ssim,
        pHash: meta.pHashScore,
        sourceRenderStatus: 'native' as RenderStatus,
        sourceFallbackFont: null,
        ssimSkipped: false,
      });
    }

    // Build pair results
    const charPairs: CrossScriptPairResult[] = [];
    for (const [charBStr, fontResults] of fontResultsByCharB) {
      if (fontResults.length === 0) continue;
      const summary = computePairSummary(fontResults);
      charPairs.push({
        charA: charA.char,
        codepointA: charA.codepoint,
        scriptA,
        charB: charBStr,
        codepointB: formatCp(charBStr),
        scriptB,
        fonts: fontResults,
        summary,
      });
    }

    // Write progress
    const progressEntry: PairProgressEntry = {
      charA: charA.char,
      pairs: charPairs,
      ssimComputed: workerResults.filter(r => !r.inkSkipped).length,
      ssimSkipped: 0,
      widthRatioSkipped: 0,
      inkCoverageSkipped: workerResults.filter(r => r.inkSkipped).length,
    };
    fs.writeSync(progressFd, JSON.stringify(progressEntry) + '\n');

    allResults.push(...charPairs);
  }

  fs.closeSync(progressFd);

  const scoreElapsed = ((Date.now() - scoreStart) / 1000).toFixed(1);
  console.log(`  Scored in ${scoreElapsed}s`);
  console.log(`  SSIM computed: ${ssimComputed}, pHash-skip: ${ssimSkipped}, wRatio-skip: ${widthRatioSkipped}, ink-skip: ${inkCoverageSkipped}`);
  console.log(`  Pairs with data: ${allResults.length}`);

  // Compute distribution
  let high = 0, med = 0, low = 0, noData = 0;
  for (const r of allResults) {
    const s = r.summary.meanSsim;
    if (s === null) noData++;
    else if (s >= 0.7) high++;
    else if (s >= 0.3) med++;
    else low++;
  }

  // Sort by meanSsim desc
  allResults.sort((a, b) => (b.summary.meanSsim ?? -1) - (a.summary.meanSsim ?? -1));

  // Write output
  const meta = {
    generatedAt: new Date().toISOString(),
    scriptA,
    scriptB,
    charsA: charsA.length,
    charsB: charsB.length,
    totalPairs: allResults.length,
    ssimComputed,
    ssimSkipped,
    widthRatioSkipped,
    pHashThreshold: PHASH_THRESHOLD,
    widthRatioMax: WIDTH_RATIO_MAX,
    licence: 'CC-BY-4.0',
    attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
  };
  const distribution = { high, medium: med, low, noData, total: allResults.length };

  const gz = createGzWriter(outputPath);
  gz.write('{\n');
  gz.write(`"meta": ${JSON.stringify(meta, null, 2)},\n`);
  gz.write(`"distribution": ${JSON.stringify(distribution, null, 2)},\n`);
  gz.write('"pairs": [\n');

  const BATCH = 1000;
  for (let i = 0; i < allResults.length; i += BATCH) {
    const batch = allResults.slice(i, Math.min(i + BATCH, allResults.length));
    const lines = batch.map((r, j) => {
      const isLast = (i + j) === allResults.length - 1;
      return JSON.stringify(r) + (isLast ? '' : ',');
    });
    gz.write(lines.join('\n') + '\n');
  }

  gz.write(']\n}\n');
  await gz.close();

  // Clean up progress on success
  if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath);

  const fileSizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`  Output: ${outputPath} (${fileSizeMB} MB)`);
  console.log(`  Distribution: ${high} high (>=0.7), ${med} medium, ${low} low, ${noData} noData`);

  if (high > 0) {
    console.log(`  Top 5 discoveries:`);
    for (const r of allResults.slice(0, 5)) {
      console.log(`    ${r.charA} (${r.codepointA}) vs ${r.charB} (${r.codepointB}) -- mean SSIM ${r.summary.meanSsim?.toFixed(4)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== confusable-vision: score-cross-script (Milestone 5) ===\n');
  const t0 = Date.now();

  fs.mkdirSync(SCORES_DIR, { recursive: true });

  // Determine pairs to score
  let pairs: [string, string][];
  if (SINGLE_PAIR) {
    pairs = [SINGLE_PAIR];
    console.log(`Single pair mode: ${SINGLE_PAIR[0]} vs ${SINGLE_PAIR[1]}\n`);
  } else {
    pairs = enumeratePairs();
    console.log(`${pairs.length} cross-script pairs to score\n`);
  }

  // Create worker pool
  console.log(`Spawning ${WORKER_COUNT} SSIM worker threads...\n`);
  const pool = createWorkerPool();

  // Score each pair
  for (let p = 0; p < pairs.length; p++) {
    let [scriptA, scriptB] = pairs[p];

    // When one script is Han, always make it script B (the larger side)
    // so we can chunk its loading to control memory
    if (scriptA === 'Han' && scriptB !== 'Han') {
      [scriptA, scriptB] = [scriptB, scriptA];
    }

    const isHanPair = scriptA === 'Han' || scriptB === 'Han';

    if (isHanPair && scriptB === 'Han') {
      // Memory-efficient Han processing:
      // 1. Load A fully (small: <300 chars)
      // 2. Load B pHash index only (no pixels, ~20MB)
      // 3. pHash prefilter to find candidate B chars
      // 4. Load only candidate B chars' pixels
      console.log(`\n[${p + 1}/${pairs.length}] Loading ${scriptA} (full) and ${scriptB} (prefiltered)...`);

      const charsA = loadScriptIndex(scriptA);
      console.log(`  ${scriptA}: ${charsA.length} chars loaded`);

      // Step 2: lightweight pHash index for Han
      console.log(`  Loading ${scriptB} pHash index (no pixels)...`);
      const bLight = loadScriptIndexLight(scriptB);
      console.log(`  ${scriptB}: ${bLight.length} font-render entries`);

      // Step 3: prefilter -- find B chars that have pHash >= threshold with ANY A render
      // Uses fast 32-bit integer comparison (avoids BigInt overhead for billions of checks)
      console.log(`  Pre-filtering by pHash (fast int path)...`);
      const candidateBChars = new Set<string>();
      let prefilterChecks = 0;

      // Pre-convert A renders to int pairs for fast comparison
      const aRenders: { hi: number; lo: number; inkWidth: number | null }[] = [];
      for (const charA of charsA) {
        for (const [, dataA] of charA.fonts) {
          const [hi, lo] = pHashToInts(dataA.pHash);
          aRenders.push({ hi, lo, inkWidth: dataA.inkWidth });
        }
      }

      // hamming threshold: similarity >= 0.3 means distance <= 44
      const maxHammingDist = Math.floor((1 - PHASH_THRESHOLD) * 64);

      for (const bEntry of bLight) {
        for (const aR of aRenders) {
          prefilterChecks++;
          const dist = popcount32(aR.hi ^ bEntry.pHashHi) + popcount32(aR.lo ^ bEntry.pHashLo);
          if (dist <= maxHammingDist) {
            // Also check width ratio using index metadata
            if (aR.inkWidth && bEntry.inkWidth) {
              const ratio = Math.max(aR.inkWidth, bEntry.inkWidth) / Math.min(aR.inkWidth, bEntry.inkWidth);
              if (ratio > WIDTH_RATIO_MAX) continue;
            }
            candidateBChars.add(bEntry.char);
            break;  // this B char is a candidate, no need to check more A renders
          }
        }
      }

      console.log(`  ${prefilterChecks.toLocaleString()} pHash checks, ${candidateBChars.size} candidate ${scriptB} chars (of ${new Set(bLight.map(e => e.char)).size} total)`);

      if (candidateBChars.size === 0) {
        console.log(`  No candidates passed prefilter, skipping pair.`);

        // Write empty output
        const emptyOutputPath = path.join(SCORES_DIR, `${scriptA}-${scriptB}.json.gz`);
        const gz = createGzWriter(emptyOutputPath);
        gz.write(JSON.stringify({
          meta: {
            generatedAt: new Date().toISOString(),
            scriptA, scriptB,
            charsA: charsA.length,
            charsB: new Set(bLight.map(e => e.char)).size,
            totalPairs: 0, ssimComputed: 0, ssimSkipped: prefilterChecks,
            widthRatioSkipped: 0, pHashThreshold: PHASH_THRESHOLD,
            widthRatioMax: WIDTH_RATIO_MAX,
            licence: 'CC-BY-4.0',
            attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
          },
          distribution: { high: 0, medium: 0, low: 0, noData: 0, total: 0 },
          pairs: [],
        }, null, 2));
        await gz.close();
        continue;
      }

      // Step 4: load only candidate chars with full pixel decode
      console.log(`  Loading ${candidateBChars.size} candidate chars with pixels...`);
      const charsB = loadScriptIndex(scriptB, candidateBChars);
      console.log(`  ${scriptB}: ${charsB.length} chars loaded (${charsB.reduce((s, c) => s + c.fonts.size, 0)} renders)`);

      await scorePair(scriptA, scriptB, charsA, charsB, pool);

    } else {
      // Normal non-Han pair: load both fully
      console.log(`\n[${p + 1}/${pairs.length}] Loading ${scriptA} and ${scriptB}...`);

      const charsA = loadScriptIndex(scriptA);
      const charsB = loadScriptIndex(scriptB);

      console.log(`  ${scriptA}: ${charsA.length} chars, ${scriptB}: ${charsB.length} chars`);

      await scorePair(scriptA, scriptB, charsA, charsB, pool);
    }
  }

  terminatePool(pool);

  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== All ${pairs.length} pairs scored in ${totalElapsed}s ===`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
