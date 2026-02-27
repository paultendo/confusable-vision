/**
 * build-index-multichar.ts -- Milestone 4 render index
 *
 * Self-contained: renders both multi-character sources (via renderSequence)
 * and single-character targets (via renderCharacter) in all standard fonts.
 * No dependency on M1b render-index.
 *
 * Sources: 3,844 two-char sequences (a-z + A-Z + 0-9 pairs)
 * Targets: 62 single chars (a-z + A-Z + 0-9)
 *
 * Writes progress incrementally to progress.jsonl so the run can be
 * resumed after a crash without re-rendering completed sequences.
 *
 * Output:
 *   data/output/multichar-index/index.json
 *   data/output/multichar-index/renders/
 *
 * Usage:
 *   npx tsx scripts/build-index-multichar.ts            # fresh or auto-resume
 *   npx tsx scripts/build-index-multichar.ts --fresh     # force fresh start
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initFonts } from '../src/fonts.js';
import { renderSequence, renderCharacter } from '../src/renderer.js';
import { normaliseImage } from '../src/normalise-image.js';
import { computePHash } from '../src/compare.js';
import type {
  MulticharCandidate,
  RenderIndex,
  IndexRenderEntry,
} from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CANDIDATES_INPUT_PATH = path.join(ROOT, 'data/output/multichar-candidates.json');

const INDEX_DIR = path.join(ROOT, 'data/output/multichar-index');
const RENDERS_DIR = path.join(INDEX_DIR, 'renders');
const INDEX_JSON = path.join(INDEX_DIR, 'index.json');
const PROGRESS_JSONL = path.join(INDEX_DIR, 'progress.jsonl');

const FORCE_FRESH = process.argv.includes('--fresh');

/** Build the 62-char target alphabet: a-z, A-Z, 0-9 */
function buildTargetAlphabet(): string[] {
  const chars: string[] = [];
  for (let cp = 0x61; cp <= 0x7A; cp++) chars.push(String.fromCharCode(cp)); // a-z
  for (let cp = 0x41; cp <= 0x5A; cp++) chars.push(String.fromCharCode(cp)); // A-Z
  for (let cp = 0x30; cp <= 0x39; cp++) chars.push(String.fromCharCode(cp)); // 0-9
  return chars;
}

/** Load progress.jsonl, returning a map of key -> entries. Tolerates corrupt last line. */
function loadProgress(): Map<string, IndexRenderEntry[]> {
  const completed = new Map<string, IndexRenderEntry[]>();
  if (!fs.existsSync(PROGRESS_JSONL)) return completed;

  const lines = fs.readFileSync(PROGRESS_JSONL, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      completed.set(obj.seq, obj.entries);
    } catch {
      console.log('  Skipping corrupt progress line (likely crash mid-write)');
    }
  }
  return completed;
}

async function main() {
  console.log('=== confusable-vision: build-index-multichar (Milestone 4) ===\n');
  const t0 = Date.now();

  // 1. Init fonts
  console.log('[1/5] Initialising fonts...');
  const fonts = initFonts();
  const availableFonts = fonts.filter(f => f.available);
  const standardFonts = availableFonts.filter(f => f.category === 'standard');
  console.log(`  Standard: ${standardFonts.length}\n`);

  // 2. Load multichar candidates
  console.log('[2/5] Loading multichar candidates...');
  if (!fs.existsSync(CANDIDATES_INPUT_PATH)) {
    console.error(`ERROR: ${CANDIDATES_INPUT_PATH} not found. Run build-multichar-candidates.ts first.`);
    process.exit(1);
  }
  const candidates: MulticharCandidate[] = JSON.parse(fs.readFileSync(CANDIDATES_INPUT_PATH, 'utf-8'));
  console.log(`  ${candidates.length} sequences\n`);

  const uniqueTargets = buildTargetAlphabet();

  // 3. Check for resume or fresh start
  let completedProgress: Map<string, IndexRenderEntry[]>;

  if (FORCE_FRESH || !fs.existsSync(PROGRESS_JSONL)) {
    if (fs.existsSync(RENDERS_DIR)) {
      fs.rmSync(RENDERS_DIR, { recursive: true });
    }
    if (fs.existsSync(PROGRESS_JSONL)) {
      fs.unlinkSync(PROGRESS_JSONL);
    }
    completedProgress = new Map();
    console.log('[3/5] Rendering single-char targets (fresh start)...');
  } else {
    completedProgress = loadProgress();
    console.log(`[3/5] Rendering single-char targets (resuming: checking progress)...`);
  }
  fs.mkdirSync(RENDERS_DIR, { recursive: true });

  // Open progress file for append
  const progressFd = fs.openSync(PROGRESS_JSONL, 'a');

  // 3. Render single-char targets using renderCharacter() (same scale as sources)
  const targets: Record<string, IndexRenderEntry[]> = {};
  let targetRenders = 0;
  let totalRenders = 0;

  for (const char of uniqueTargets) {
    const tgtKey = `tgt:${char}`;

    if (completedProgress.has(tgtKey)) {
      targets[char] = completedProgress.get(tgtKey)!;
      totalRenders += targets[char].length;
      continue;
    }

    const entries: IndexRenderEntry[] = [];

    for (const font of standardFonts) {
      const result = renderCharacter(char, font.family);
      if (!result) continue;

      // Normalise in memory for pHash prefilter; store RAW PNG on disk
      // (score-multichar uses normalisePair at scoring time)
      const norm = await normaliseImage(result.pngBuffer);
      const hash = await computePHash(norm.rawPixels, norm.width, norm.height);
      const safeName = font.family.replace(/\s+/g, '-');
      const hex = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      const filename = `tgt_${hex}_${safeName}.png`;
      fs.writeFileSync(path.join(RENDERS_DIR, filename), result.pngBuffer);

      entries.push({
        font: font.family,
        category: font.category,
        pHash: hash.toString(16).padStart(16, '0'),
        renderStatus: 'native',
        fallbackFont: null,
        png: filename,
      });
      targetRenders++;
    }

    targets[char] = entries;
    totalRenders += entries.length;
    fs.writeSync(progressFd, JSON.stringify({ seq: tgtKey, entries }) + '\n');
  }

  console.log(`  ${uniqueTargets.length} target chars, ${targetRenders} renders\n`);

  // 4. Render multichar sources
  const sources: Record<string, IndexRenderEntry[]> = {};
  const sourceStart = Date.now();
  let sourceRenders = 0;
  let skippedResume = 0;

  console.log('[4/5] Rendering multichar sequences...');

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const seq = candidate.sequence;

    // Resume: skip already-completed sequences
    if (completedProgress.has(seq)) {
      sources[seq] = completedProgress.get(seq)!;
      totalRenders += sources[seq].length;
      skippedResume++;
      continue;
    }

    if ((i - skippedResume) > 0 && (i - skippedResume) % 100 === 0) {
      const elapsed = (Date.now() - sourceStart) / 1000;
      const rendered = i - skippedResume;
      const rate = rendered / elapsed;
      const remaining = candidates.length - i;
      const eta = Math.round(remaining / rate);
      console.log(`  [${i}/${candidates.length}] "${seq}" -- ${sourceRenders} renders, ${rate.toFixed(0)} seqs/s, ETA ${eta}s`);
    }

    const entries: IndexRenderEntry[] = [];

    for (const font of standardFonts) {
      const result = renderSequence(seq, font.family);
      if (!result) continue;

      // Normalise in memory for pHash prefilter; store RAW PNG on disk
      const norm = await normaliseImage(result.pngBuffer);
      const hash = await computePHash(norm.rawPixels, norm.width, norm.height);
      const safeName = font.family.replace(/\s+/g, '-');
      const hexSeq = [...seq].map(c => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join('_');
      const filename = `src_${hexSeq}_${safeName}.png`;
      fs.writeFileSync(path.join(RENDERS_DIR, filename), result.pngBuffer);

      entries.push({
        font: font.family,
        category: font.category,
        pHash: hash.toString(16).padStart(16, '0'),
        renderStatus: 'native',
        fallbackFont: null,
        png: filename,
      });
      sourceRenders++;
    }

    sources[seq] = entries;
    totalRenders += entries.length;

    // Write progress to disk immediately
    fs.writeSync(progressFd, JSON.stringify({ seq, entries }) + '\n');
  }

  fs.closeSync(progressFd);

  const sourceElapsed = ((Date.now() - sourceStart) / 1000).toFixed(1);
  console.log(`\n  ${candidates.length} sequences processed in ${sourceElapsed}s`);
  if (skippedResume > 0) {
    console.log(`  ${skippedResume} skipped (resumed), ${candidates.length - skippedResume} rendered`);
  }
  console.log(`  ${sourceRenders} new source renders\n`);

  // 5. Write final index
  console.log('[5/5] Writing index...');
  const index: RenderIndex = {
    meta: {
      generatedAt: new Date().toISOString(),
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      renderSize: 48,
      fontsAvailable: availableFonts.length,
      fontsTotal: fonts.length,
      standardFonts: standardFonts.map(f => f.family),
      sourceCharCount: candidates.length,
      targetCharCount: uniqueTargets.length,
      totalRenders,
    },
    sources,
    targets,
  };

  fs.writeFileSync(INDEX_JSON, JSON.stringify(index, null, 2));

  // Clean up progress on successful completion
  if (fs.existsSync(PROGRESS_JSONL)) {
    fs.unlinkSync(PROGRESS_JSONL);
  }

  const renderFiles = fs.readdirSync(RENDERS_DIR).length;
  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Index written to: ${INDEX_JSON}`);
  console.log(`PNG renders: ${renderFiles} files in ${RENDERS_DIR}`);
  console.log(`Targets: ${Object.keys(targets).length} chars, Sources: ${Object.keys(sources).length} sequences`);
  console.log(`Total time: ${totalElapsed}s`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
