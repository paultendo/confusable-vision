/**
 * build-index-m2b.ts -- Milestone 2b render index
 *
 * Renders M2b candidates (CJK/Hangul/logographic characters) in native
 * fonts, computes pHash. Reuses M1b target renders from render-index/.
 *
 * Writes progress incrementally to progress.jsonl so the run can be
 * resumed after a crash without re-rendering completed characters.
 *
 * Output:
 *   data/output/m2b-index/index.json
 *   data/output/m2b-index/renders/
 *
 * Usage:
 *   npx tsx scripts/build-index-m2b.ts            # fresh or auto-resume
 *   npx tsx scripts/build-index-m2b.ts --fresh     # force fresh start
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initFonts, queryFontCoverage, discoverFontForCodepoint } from '../src/fonts.js';
import { renderCharacter } from '../src/renderer.js';
import { normaliseImage, decodeAndFindBounds, getInkWidth } from '../src/normalise-image.js';
import { computePHash } from '../src/compare.js';
import type {
  RenderIndex,
  IndexRenderEntry,
} from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CANDIDATES_INPUT_PATH = path.join(ROOT, 'data/output/m2b-candidates.json');

const INDEX_DIR = path.join(ROOT, 'data/output/m2b-index');
const RENDERS_DIR = path.join(INDEX_DIR, 'renders');
const INDEX_JSON = path.join(INDEX_DIR, 'index.json');
const PROGRESS_JSONL = path.join(INDEX_DIR, 'progress.jsonl');

const FORCE_FRESH = process.argv.includes('--fresh');

interface CandidateEntry {
  codepoint: string;
  char: string;
  name: string;
  generalCategory: string;
  script: string;
  fontCoverage: number;
}

/** Load progress.jsonl, returning a map of char -> entries. Tolerates corrupt last line. */
function loadProgress(): Map<string, IndexRenderEntry[]> {
  const completed = new Map<string, IndexRenderEntry[]>();
  if (!fs.existsSync(PROGRESS_JSONL)) return completed;

  const lines = fs.readFileSync(PROGRESS_JSONL, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      completed.set(obj.char, obj.entries);
    } catch {
      console.log('  Skipping corrupt progress line (likely crash mid-write)');
    }
  }
  return completed;
}

async function main() {
  console.log('=== confusable-vision: build-index-m2b (Milestone 2b) ===\n');
  const t0 = Date.now();

  // 1. Init fonts
  console.log('[1/4] Initialising fonts...');
  const fonts = initFonts();
  const availableFonts = fonts.filter(f => f.available);
  const standardFonts = availableFonts.filter(f => f.category === 'standard');

  console.log(`  Standard: ${standardFonts.length}, Non-standard: ${availableFonts.length - standardFonts.length}\n`);

  // 2. Load M2b candidates
  console.log('[2/4] Loading M2b candidate set...');
  if (!fs.existsSync(CANDIDATES_INPUT_PATH)) {
    console.error(`ERROR: ${CANDIDATES_INPUT_PATH} not found. Run build-candidates-m2b.ts first.`);
    process.exit(1);
  }
  const candidates: CandidateEntry[] = JSON.parse(fs.readFileSync(CANDIDATES_INPUT_PATH, 'utf-8'));
  const uniqueSources = candidates.map(c => c.char);
  const codepointMap = new Map<string, string>();
  for (const c of candidates) {
    codepointMap.set(c.char, c.codepoint.replace('U+', ''));
  }

  console.log(`  ${uniqueSources.length} source characters, 36 target characters (from M1b)\n`);

  // 3. Query fontconfig for coverage of all source characters
  console.log('[3/4] Querying fontconfig for font coverage...');
  const coverageStart = Date.now();
  const coverageMap = new Map<string, typeof availableFonts>();
  let totalCoverageEntries = 0;

  for (let i = 0; i < uniqueSources.length; i++) {
    const char = uniqueSources[i]!;
    const codepoint = char.codePointAt(0)!;

    let covered = queryFontCoverage(codepoint, availableFonts);

    if (covered.length === 0) {
      const discovered = discoverFontForCodepoint(codepoint);
      if (discovered) {
        covered = [discovered];
      }
    }

    coverageMap.set(char, covered);
    totalCoverageEntries += covered.length;

    if (i > 0 && i % 5000 === 0) {
      console.log(`  [${i}/${uniqueSources.length}] queried`);
    }
  }

  const coverageElapsed = ((Date.now() - coverageStart) / 1000).toFixed(1);
  const avgFonts = uniqueSources.length > 0
    ? (totalCoverageEntries / uniqueSources.length).toFixed(1)
    : '0';
  const zeroCoverage = [...coverageMap.values()].filter(v => v.length === 0).length;
  console.log(`  ${uniqueSources.length} characters queried in ${coverageElapsed}s`);
  console.log(`  Average ${avgFonts} fonts per character, ${zeroCoverage} with no coverage`);
  console.log(`  ${totalCoverageEntries} total render jobs\n`);

  // 4. Check for resume or fresh start
  let completedSources: Map<string, IndexRenderEntry[]>;

  if (FORCE_FRESH || !fs.existsSync(PROGRESS_JSONL)) {
    // Fresh start: clear renders directory
    if (fs.existsSync(RENDERS_DIR)) {
      fs.rmSync(RENDERS_DIR, { recursive: true });
    }
    if (fs.existsSync(PROGRESS_JSONL)) {
      fs.unlinkSync(PROGRESS_JSONL);
    }
    completedSources = new Map();
    console.log('[4/4] Rendering source characters (fresh start)...');
  } else {
    completedSources = loadProgress();
    console.log(`[4/4] Rendering source characters (resuming: ${completedSources.size}/${uniqueSources.length} done)...`);
  }
  fs.mkdirSync(RENDERS_DIR, { recursive: true });

  // Targets are not rendered here -- score-candidates-m2b.ts loads them from M1b
  // render-index directly to avoid duplicating ~2,600 renders (36 chars x ~74 fonts).
  const targets: Record<string, IndexRenderEntry[]> = {};

  // Open progress file for append
  const progressFd = fs.openSync(PROGRESS_JSONL, 'a');

  const sources: Record<string, IndexRenderEntry[]> = {};
  const sourceStart = Date.now();
  let notdefCount = 0;
  let sourceRenders = 0;
  let totalRenders = 0;
  let skippedResume = 0;

  for (let i = 0; i < uniqueSources.length; i++) {
    const char = uniqueSources[i]!;
    const hex = codepointMap.get(char)!;

    // Resume: skip already-completed characters
    if (completedSources.has(char)) {
      sources[char] = completedSources.get(char)!;
      totalRenders += sources[char].length;
      skippedResume++;
      continue;
    }

    if ((i - skippedResume) > 0 && (i - skippedResume) % 500 === 0) {
      const elapsed = (Date.now() - sourceStart) / 1000;
      const rendered = i - skippedResume;
      const rate = rendered / elapsed;
      const remaining = uniqueSources.length - i;
      const eta = Math.round(remaining / rate);
      console.log(`  [${i}/${uniqueSources.length}] ${sourceRenders} renders -- ${rate.toFixed(0)} chars/s, ETA ${eta}s`);
    }

    const coverageFonts = coverageMap.get(char) ?? [];

    if (coverageFonts.length === 0) {
      sources[char] = [];
      fs.writeSync(progressFd, JSON.stringify({ char, entries: [] }) + '\n');
      continue;
    }

    const entries: IndexRenderEntry[] = [];

    for (const font of coverageFonts) {
      const result = renderCharacter(char, font.family);
      if (!result) {
        notdefCount++;
        continue;
      }

      // Get raw ink bounds before normalisation (for size-ratio analysis)
      const rawDecoded = await decodeAndFindBounds(result.pngBuffer);
      const inkWidth = getInkWidth(rawDecoded);
      const inkHeight = rawDecoded.bounds
        ? rawDecoded.bounds.bottom - rawDecoded.bounds.top + 1
        : null;

      const norm = await normaliseImage(result.pngBuffer);
      const hash = await computePHash(norm.rawPixels, norm.width, norm.height);
      const safeName = font.family.replace(/\s+/g, '-');
      const filename = `src_${hex}_${safeName}.png`;
      fs.writeFileSync(path.join(RENDERS_DIR, filename), norm.pngBuffer);

      entries.push({
        font: font.family,
        category: font.category,
        pHash: hash.toString(16).padStart(16, '0'),
        renderStatus: 'native',
        fallbackFont: null,
        png: filename,
        inkWidth,
        inkHeight,
      });
      sourceRenders++;
    }

    sources[char] = entries;
    totalRenders += entries.length;

    // Write progress to disk immediately
    fs.writeSync(progressFd, JSON.stringify({ char, entries }) + '\n');
  }

  fs.closeSync(progressFd);

  const sourceElapsed = ((Date.now() - sourceStart) / 1000).toFixed(1);
  console.log(`\n  ${uniqueSources.length} sources processed in ${sourceElapsed}s`);
  if (skippedResume > 0) {
    console.log(`  ${skippedResume} skipped (resumed), ${uniqueSources.length - skippedResume} rendered`);
  }
  console.log(`  ${sourceRenders} new source renders, ${notdefCount} notdef\n`);

  // 5. Write final index
  const index: RenderIndex = {
    meta: {
      generatedAt: new Date().toISOString(),
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      renderSize: 48,
      fontsAvailable: availableFonts.length,
      fontsTotal: fonts.length,
      standardFonts: standardFonts.map(f => f.family),
      sourceCharCount: uniqueSources.length,
      targetCharCount: 36, // a-z + 0-9 (rendered by M1b, not here)
      totalRenders,
    },
    sources,
    targets,
  };

  fs.writeFileSync(INDEX_JSON, JSON.stringify(index, null, 2));

  // Clean up progress file on successful completion
  if (fs.existsSync(PROGRESS_JSONL)) {
    fs.unlinkSync(PROGRESS_JSONL);
  }

  const renderFiles = fs.readdirSync(RENDERS_DIR).length;
  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Index written to: ${INDEX_JSON}`);
  console.log(`PNG renders: ${renderFiles} files in ${RENDERS_DIR}`);
  console.log(`Total time: ${totalElapsed}s`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
