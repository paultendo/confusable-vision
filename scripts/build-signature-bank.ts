/**
 * build-signature-bank.ts
 *
 * Precompute ray signatures for all IDNA2008 PVALID codepoints across
 * pre-bundled macOS system fonts. Output is gzipped JSONL for streaming reads.
 *
 * Features:
 * - Parallel: worker threads for signature computation (scales to available cores)
 * - Resumable: if interrupted, re-run skips already-computed codepoints
 * - Streaming writes: one JSONL line per codepoint (uncompressed during build)
 * - System fonts only (/System/Library/Fonts/) for reproducibility
 * - Font LRU cache: bounds memory by evicting least-recently-used font objects
 * - Gzips the completed JSONL at the end
 *
 * Output: data/output/signature-bank.jsonl.gz
 *
 * Usage: npx tsx scripts/build-signature-bank.ts
 *        npx tsx scripts/build-signature-bank.ts --include-mapped  # Include uppercase A-Z etc.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { registerFont } from 'canvas';
import { initFonts } from '../src/fonts.js';
import { loadFont, extractGlyphPath, getFontMetrics, normalizeToGrid } from '../src/glyph-path.js';
import { parseIdnCodepoints, collectExistingCodepoints } from '../src/signature-bank.js';
import type { FontEntry, BankEntry, BankMetaLine, BankEntryLine, PathSegment } from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const IDN_TABLE_PATH = path.join(ROOT, 'data/input/IdnaMappingTable.txt');
const OUTPUT_DIR = path.join(ROOT, 'data/output');
const JSONL_PATH = path.join(OUTPUT_DIR, 'signature-bank.jsonl');
const GZ_PATH = path.join(OUTPUT_DIR, 'signature-bank.jsonl.gz');
const WORKER_PATH = path.resolve(import.meta.dirname, 'compute-worker.mjs');

const GRID_SIZE = 128;
const NUM_ANGLES = 36;
const RAYS_PER_ANGLE = 50;
const PROGRESS_INTERVAL = 500;
const BATCH_SIZE = 200;
const INCLUDE_MAPPED = process.argv.includes('--include-mapped');

// ---- Worker pool ----

interface SignatureResult {
  counts: number[];
  positions: number[];
  angles: number[];
  pingDistances: number[];
  pingMax: number[];
}

class SignaturePool {
  private workers: Worker[];
  private pending = new Map<number, (result: SignatureResult) => void>();
  private nextId = 0;

  constructor(numWorkers: number) {
    this.workers = [];
    for (let i = 0; i < numWorkers; i++) {
      const w = new Worker(WORKER_PATH);
      w.on('message', (msg: { id: number; counts: number[]; positions: number[]; angles: number[]; pingDistances: number[]; pingMax: number[] }) => {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve({ counts: msg.counts, positions: msg.positions, angles: msg.angles, pingDistances: msg.pingDistances, pingMax: msg.pingMax });
        }
      });
      w.on('error', (err) => {
        console.error(`  [worker ${i}] error:`, err.message);
      });
      this.workers.push(w);
    }
  }

  compute(gridSegments: PathSegment[], numAngles: number, raysPerAngle: number, gridSize: number): Promise<SignatureResult> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      const workerIdx = id % this.workers.length;
      this.workers[workerIdx]!.postMessage({ id, gridSegments, numAngles, raysPerAngle, gridSize });
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
    }
    return font;
  }
}

// ---- Helpers ----

function filterSystemFonts(fonts: FontEntry[]): FontEntry[] {
  return fonts.filter(f =>
    f.available && f.path.startsWith('/System/Library/Fonts/'),
  );
}

async function main(): Promise<void> {
  console.log('=== Signature Bank Builder ===\n');
  const t0 = Date.now();

  const numCpus = os.cpus().length;
  const numWorkers = Math.max(1, numCpus - 1);
  console.log(`  ${numCpus} cores detected, using ${numWorkers} worker threads\n`);

  // 1. Parse IDN codepoints
  const statusLabel = INCLUDE_MAPPED ? 'PVALID + mapped' : 'PVALID';
  console.log(`[1/7] Parsing ${statusLabel} codepoints from IdnaMappingTable.txt...`);
  if (INCLUDE_MAPPED) console.log('  --include-mapped: including uppercase Latin and other mapped codepoints');
  if (!fs.existsSync(IDN_TABLE_PATH)) {
    console.error(`  IdnaMappingTable.txt not found at ${IDN_TABLE_PATH}`);
    console.error('  Download from: https://unicode.org/Public/idna/16.0.0/IdnaMappingTable.txt');
    process.exit(1);
  }
  const allCodepoints = parseIdnCodepoints(IDN_TABLE_PATH, { includeMapped: INCLUDE_MAPPED });
  console.log(`  ${allCodepoints.length} ${statusLabel} codepoints\n`);

  // 2. Init fonts (system only)
  console.log('[2/7] Initialising system fonts...');
  const allFonts = initFonts();
  const systemFonts = filterSystemFonts(allFonts);
  console.log(`  ${systemFonts.length} system fonts (filtered to /System/Library/Fonts/)\n`);

  if (systemFonts.length === 0) {
    console.error('  No system fonts found. Are you on macOS?');
    process.exit(1);
  }

  const fontNames = systemFonts.map(f => f.family).sort();

  // 3. Pre-build font coverage map using fontkit cmap
  console.log('[3/7] Building font coverage map via cmap...');
  const coverageMap = new Map<number, FontEntry[]>();
  const loadedFonts = new Map<string, ReturnType<typeof loadFont>>();

  for (const fe of systemFonts) {
    const font = loadFont(fe.path);
    if (font) loadedFonts.set(fe.path, font);
  }
  console.log(`  ${loadedFonts.size} fonts loaded`);

  let cmapChecks = 0;
  for (const cp of allCodepoints) {
    const covering: FontEntry[] = [];
    for (const fe of systemFonts) {
      const font = loadedFonts.get(fe.path);
      if (!font) continue;
      try {
        const glyph = font.glyphForCodePoint(cp);
        if (glyph.id !== 0) covering.push(fe);
      } catch { /* skip */ }
      cmapChecks++;
    }
    if (covering.length > 0) coverageMap.set(cp, covering);
  }

  console.log(`  ${cmapChecks.toLocaleString()} cmap lookups`);
  console.log(`  ${coverageMap.size} covered, ${allCodepoints.length - coverageMap.size} uncovered\n`);

  // 4. Bulk font discovery for uncovered codepoints (single fc-list call)
  console.log('[4/7] Bulk-discovering fonts for uncovered codepoints...');
  const uncoveredCps = new Set(allCodepoints.filter(cp => !coverageMap.has(cp)));

  if (uncoveredCps.size > 0) {
    let fcOutput = '';
    try {
      fcOutput = execFileSync('fc-list', [
        '--format=%{file}\t%{charset}\n',
      ], { encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024 });
    } catch {
      console.warn('  fc-list bulk query failed, skipping dynamic discovery');
    }

    if (fcOutput) {
      const fontCharsets = new Map<string, Set<number>>();
      for (const line of fcOutput.split('\n')) {
        if (!line.trim()) continue;
        const tabIdx = line.indexOf('\t');
        if (tabIdx < 0) continue;
        const filePath = line.slice(0, tabIdx);
        if (!filePath.startsWith('/System/Library/Fonts/')) continue;
        if (filePath.includes('LastResort')) continue;
        if (loadedFonts.has(filePath)) continue;

        const charsetStr = line.slice(tabIdx + 1).trim();
        if (!charsetStr) continue;

        let charset = fontCharsets.get(filePath);
        if (!charset) {
          charset = new Set<number>();
          fontCharsets.set(filePath, charset);
        }
        for (const token of charsetStr.split(/\s+/)) {
          if (token.includes('-')) {
            const [startHex, endHex] = token.split('-');
            const start = parseInt(startHex!, 16);
            const end = parseInt(endHex!, 16);
            if (!isNaN(start) && !isNaN(end)) {
              for (let cp = start; cp <= end; cp++) {
                if (uncoveredCps.has(cp)) charset.add(cp);
              }
            }
          } else {
            const cp = parseInt(token, 16);
            if (!isNaN(cp) && uncoveredCps.has(cp)) charset.add(cp);
          }
        }
      }

      let dynamicFonts = 0;
      let dynamicCps = 0;
      for (const [filePath, charset] of fontCharsets) {
        if (charset.size === 0) continue;
        const family = path.basename(filePath).replace(/\.(ttf|otf|ttc)$/i, '');
        try { registerFont(filePath, { family }); } catch { continue; }
        const font = loadFont(filePath);
        if (!font) continue;

        loadedFonts.set(filePath, font);
        const entry: FontEntry = { family, path: filePath, category: 'script', available: true };
        dynamicFonts++;

        for (const cp of charset) {
          try {
            const glyph = font.glyphForCodePoint(cp);
            if (glyph.id === 0) continue;
          } catch { continue; }
          const existing = coverageMap.get(cp);
          if (existing) { existing.push(entry); }
          else { coverageMap.set(cp, [entry]); dynamicCps++; }
        }
      }
      console.log(`  ${dynamicFonts} additional fonts, ${dynamicCps} newly covered codepoints`);
    }
  }
  console.log(`  Final: ${coverageMap.size} covered, ${allCodepoints.length - coverageMap.size} uncovered\n`);

  // Pre-cache font metrics before releasing font objects
  const metricsCache = new Map<string, ReturnType<typeof getFontMetrics>>();
  for (const [fontPath, font] of loadedFonts) {
    if (font) metricsCache.set(fontPath, getFontMetrics(font));
  }
  // Release fontkit objects to free memory (re-loaded on demand via LRU in step 6)
  loadedFonts.clear();

  // 5. Resume check
  console.log('[5/7] Checking for existing progress...');
  const existingCps = await collectExistingCodepoints(JSONL_PATH);
  const remaining = allCodepoints.filter(cp => {
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    return !existingCps.has(hex);
  });

  if (existingCps.size > 0) {
    console.log(`  Found ${existingCps.size} existing entries, ${remaining.length} remaining\n`);
  } else {
    console.log(`  Fresh build: ${allCodepoints.length} codepoints to process\n`);
  }

  // 6. Compute signatures with worker pool
  console.log('[6/7] Computing signatures...\n');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let fd: number;
  if (existingCps.size === 0) {
    const meta: BankMetaLine = {
      type: 'meta',
      generatedAt: new Date().toISOString(),
      platform: `${process.platform} ${os.arch()} ${os.release()}`,
      gridSize: GRID_SIZE,
      numAngles: NUM_ANGLES,
      raysPerAngle: RAYS_PER_ANGLE,
      fontsUsed: fontNames,
      hasPositions: true,
      hasAngles: true,
      hasPings: true,
    };
    fs.writeFileSync(JSONL_PATH, JSON.stringify(meta) + '\n');
    fd = fs.openSync(JSONL_PATH, 'a');
  } else {
    fd = fs.openSync(JSONL_PATH, 'a');
  }

  const fontLRU = new FontLRU(30);
  const pool = new SignaturePool(numWorkers);
  let processed = 0;
  let totalEntries = 0;
  let skippedNoGlyph = 0;

  // Process in batches: extract glyphs on main thread, compute signatures on workers
  for (let bStart = 0; bStart < remaining.length; bStart += BATCH_SIZE) {
    const batch = remaining.slice(bStart, bStart + BATCH_SIZE);

    interface PendingItem {
      fontFamily: string;
      glyphId: number;
      advanceWidth: number;
      segmentCount: number;
      promise: Promise<SignatureResult>;
    }

    const batchData: { cp: number; hex: string; items: PendingItem[] }[] = [];

    for (const cp of batch) {
      const hex = cp.toString(16).toUpperCase().padStart(4, '0');
      const coveringFonts = coverageMap.get(cp) ?? [];
      const items: PendingItem[] = [];

      for (const fontEntry of coveringFonts) {
        const font = fontLRU.get(fontEntry.path);
        if (!font) continue;

        let glyphId = 0;
        try {
          const glyph = font.glyphForCodePoint(cp);
          if (glyph.id === 0) continue;
          glyphId = glyph.id;
        } catch { continue; }

        const glyphPath = extractGlyphPath(font, cp);
        if (!glyphPath) continue;

        const metrics = metricsCache.get(fontEntry.path);
        if (!metrics) continue;

        const gridSegments = normalizeToGrid(glyphPath, metrics, GRID_SIZE);
        const promise = pool.compute(gridSegments, NUM_ANGLES, RAYS_PER_ANGLE, GRID_SIZE);

        items.push({
          fontFamily: fontEntry.family, glyphId,
          advanceWidth: glyphPath.advanceWidth,
          segmentCount: glyphPath.segments.length,
          promise,
        });
      }

      batchData.push({ cp, hex, items });
    }

    // Phase 2: collect results, write JSONL (in codepoint order)
    for (const { hex, items } of batchData) {
      const entries: BankEntry[] = [];

      for (const item of items) {
        const { counts, positions, angles, pingDistances, pingMax } = await item.promise;
        const entry: BankEntry = {
          font: item.fontFamily, glyphId: item.glyphId,
          advanceWidth: item.advanceWidth, segmentCount: item.segmentCount,
          counts,
        };
        // Only store positions/angles/pings if there are any (rays with count > 0)
        if (positions.length > 0) entry.positions = positions;
        if (angles.length > 0) entry.angles = angles;
        if (pingDistances.length > 0) entry.pingDistances = pingDistances;
        if (pingMax.length > 0) entry.pingMax = pingMax;
        entries.push(entry);
      }

      if (entries.length === 0) skippedNoGlyph++;

      const entryLine: BankEntryLine = { type: 'entry', cp: hex, entries };
      fs.writeSync(fd, JSON.stringify(entryLine) + '\n');
      totalEntries += entries.length;
      processed++;

      if (processed % PROGRESS_INTERVAL === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        const rate = (processed / (Date.now() - t0) * 1000).toFixed(1);
        console.log(
          `  [progress] ${processed}/${remaining.length} codepoints ` +
          `(${totalEntries} entries, ${elapsed}s, ${rate}/s)`,
        );
      }
    }
  }

  await pool.shutdown();
  fs.closeSync(fd);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  Processed ${processed} codepoints in ${elapsed}s`);
  console.log(`  ${totalEntries} signature entries, ${skippedNoGlyph} codepoints with no glyphs`);
  console.log(`  ${numWorkers} workers used`);

  // 7. Gzip the JSONL
  console.log('\n[7/7] Compressing to .jsonl.gz...');
  const rawSize = fs.statSync(JSONL_PATH).size;

  await pipeline(
    createReadStream(JSONL_PATH),
    createGzip({ level: 6 }),
    createWriteStream(GZ_PATH),
  );

  const gzSize = fs.statSync(GZ_PATH).size;
  const ratio = ((1 - gzSize / rawSize) * 100).toFixed(1);
  console.log(`  ${(rawSize / 1024 / 1024).toFixed(1)} MB -> ${(gzSize / 1024 / 1024).toFixed(1)} MB (${ratio}% reduction)`);

  fs.unlinkSync(JSONL_PATH);
  console.log(`  Removed uncompressed ${path.basename(JSONL_PATH)}`);

  console.log(`\n  Output: ${GZ_PATH}`);
  console.log(`\nDone in ${elapsed}s.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
