/**
 * score-candidates-m2b.ts -- Milestone 2b
 *
 * Scores M2b candidates (CJK/Hangul/logographic characters) against all 36
 * Latin targets (a-z, 0-9). Same scoring strategy as score-candidates.ts:
 * same-font + cross-font with pHash prefilter at 0.3.
 *
 * Reuses M1b target renders from render-index/. M2b source renders come
 * from m2b-index/.
 *
 * Writes progress incrementally to progress.jsonl so the run can be
 * resumed after a crash without re-scoring completed characters.
 *
 * Prerequisite:
 *   npx tsx scripts/build-candidates-m2b.ts
 *   npx tsx scripts/build-index-m2b.ts
 *
 * Usage:
 *   npx tsx scripts/score-candidates-m2b.ts            # fresh or auto-resume
 *   npx tsx scripts/score-candidates-m2b.ts --fresh     # force fresh start
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { computeSsim, pHashSimilarity } from '../src/compare.js';
import { createGzWriter } from '../src/gz-json.js';
import type {
  RenderIndex,
  IndexRenderEntry,
  NormalisedResult,
  PairFontResult,
  PairSummary,
  ConfusablePairResult,
  RenderStatus,
} from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// M2b index (sources)
const M2B_INDEX_DIR = path.join(ROOT, 'data/output/m2b-index');
const M2B_INDEX_JSON = path.join(M2B_INDEX_DIR, 'index.json');
const M2B_RENDERS_DIR = path.join(M2B_INDEX_DIR, 'renders');

// Milestone 1b index (reuse target renders)
const M1B_INDEX_DIR = path.join(ROOT, 'data/output/render-index');
const M1B_INDEX_JSON = path.join(M1B_INDEX_DIR, 'index.json');
const M1B_RENDERS_DIR = path.join(M1B_INDEX_DIR, 'renders');

const OUTPUT_DIR = path.join(ROOT, 'data/output');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'm2b-scores.json.gz');
const PROGRESS_JSONL = path.join(OUTPUT_DIR, 'm2b-scores-progress.jsonl');

const PHASH_PREFILTER_THRESHOLD = 0.3;
const FORCE_FRESH = process.argv.includes('--fresh');

interface DecodedRender {
  entry: IndexRenderEntry;
  norm: NormalisedResult;
  pHash: bigint;
}

/** Progress line: all pair results for one source character. */
interface ProgressEntry {
  srcChar: string;
  pairs: ConfusablePairResult[];
  ssimComputed: number;
  ssimSkipped: number;
  sameFontTotal: number;
  crossFontTotal: number;
}

async function decodePng(pngPath: string): Promise<NormalisedResult> {
  const pngBuffer = fs.readFileSync(pngPath);
  const { data, info } = await sharp(pngBuffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  return {
    pngBuffer,
    rawPixels: Buffer.from(data),
    width: info.width,
    height: info.height,
  };
}

/** Load progress.jsonl, returning a map of srcChar -> ProgressEntry. Tolerates corrupt last line. */
function loadProgress(): Map<string, ProgressEntry> {
  const completed = new Map<string, ProgressEntry>();
  if (!fs.existsSync(PROGRESS_JSONL)) return completed;

  const lines = fs.readFileSync(PROGRESS_JSONL, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj: ProgressEntry = JSON.parse(line);
      completed.set(obj.srcChar, obj);
    } catch {
      console.log('  Skipping corrupt progress line (likely crash mid-write)');
    }
  }
  return completed;
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

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function main() {
  console.log('=== confusable-vision: score-candidates-m2b (Milestone 2b) ===\n');

  // 1. Load M2b index (sources)
  console.log('[1/4] Loading M2b render index...');
  if (!fs.existsSync(M2B_INDEX_JSON)) {
    console.error(`ERROR: ${M2B_INDEX_JSON} not found. Run build-index-m2b.ts first.`);
    process.exit(1);
  }
  const m2bIndex: RenderIndex = JSON.parse(fs.readFileSync(M2B_INDEX_JSON, 'utf-8'));
  const sourceChars = Object.keys(m2bIndex.sources);
  const sourcesWithRenders = sourceChars.filter(c => m2bIndex.sources[c]!.length > 0);
  console.log(`  ${m2bIndex.meta.sourceCharCount} M2b chars, ${sourcesWithRenders.length} with renders`);

  // 2. Load Milestone 1b index (targets only)
  console.log('[2/4] Loading Milestone 1b target renders...');
  if (!fs.existsSync(M1B_INDEX_JSON)) {
    console.error(`ERROR: ${M1B_INDEX_JSON} not found. Run build-index.ts first.`);
    process.exit(1);
  }
  const m1bIndex: RenderIndex = JSON.parse(fs.readFileSync(M1B_INDEX_JSON, 'utf-8'));
  const standardFontSet = new Set(m1bIndex.meta.standardFonts);
  const targetChars = Object.keys(m1bIndex.targets);
  console.log(`  ${targetChars.length} target chars from ${m1bIndex.meta.standardFonts.length} standard fonts\n`);

  // 3. Decode all renders into memory
  console.log('[3/4] Decoding all renders...');
  const decodeStart = Date.now();

  const sourceCache = new Map<string, DecodedRender[]>();
  let sourceDecoded = 0;
  let srcIdx = 0;
  for (const char of sourcesWithRenders) {
    const entries = m2bIndex.sources[char]!;
    const decoded: DecodedRender[] = [];
    for (const entry of entries) {
      const norm = await decodePng(path.join(M2B_RENDERS_DIR, entry.png));
      const pHash = BigInt('0x' + entry.pHash);
      decoded.push({ entry, norm, pHash });
      sourceDecoded++;
    }
    sourceCache.set(char, decoded);
    srcIdx++;

    if (srcIdx % 2000 === 0) {
      console.log(`  Sources: ${srcIdx}/${sourcesWithRenders.length} chars decoded (${sourceDecoded} renders)`);
    }
  }

  const targetCache = new Map<string, DecodedRender[]>();
  let targetDecoded = 0;
  for (const char of targetChars) {
    const entries = m1bIndex.targets[char]!;
    const decoded: DecodedRender[] = [];
    for (const entry of entries) {
      const norm = await decodePng(path.join(M1B_RENDERS_DIR, entry.png));
      const pHash = BigInt('0x' + entry.pHash);
      decoded.push({ entry, norm, pHash });
      targetDecoded++;
    }
    targetCache.set(char, decoded);
  }

  const decodeElapsed = ((Date.now() - decodeStart) / 1000).toFixed(1);
  console.log(`  Decoded ${sourceDecoded} source + ${targetDecoded} target renders in ${decodeElapsed}s\n`);

  // 4. Score all source-target pairs (with resume)
  let completedProgress: Map<string, ProgressEntry>;

  if (FORCE_FRESH || !fs.existsSync(PROGRESS_JSONL)) {
    if (fs.existsSync(PROGRESS_JSONL)) {
      fs.unlinkSync(PROGRESS_JSONL);
    }
    completedProgress = new Map();
    console.log('[4/4] Scoring source-target pairs (fresh start)...');
  } else {
    completedProgress = loadProgress();
    console.log(`[4/4] Scoring source-target pairs (resuming: ${completedProgress.size}/${sourcesWithRenders.length} done)...`);
  }

  const progressFd = fs.openSync(PROGRESS_JSONL, 'a');
  const scoreStart = Date.now();

  const allResults: ConfusablePairResult[] = [];
  let ssimComputed = 0;
  let ssimSkipped = 0;
  let sameFontTotal = 0;
  let crossFontTotal = 0;
  let pairsWithData = 0;
  let skippedResume = 0;

  for (let i = 0; i < sourcesWithRenders.length; i++) {
    const srcChar = sourcesWithRenders[i]!;

    // Resume: skip already-completed characters
    if (completedProgress.has(srcChar)) {
      const prev = completedProgress.get(srcChar)!;
      allResults.push(...prev.pairs);
      ssimComputed += prev.ssimComputed;
      ssimSkipped += prev.ssimSkipped;
      sameFontTotal += prev.sameFontTotal;
      crossFontTotal += prev.crossFontTotal;
      pairsWithData += prev.pairs.length;
      skippedResume++;
      continue;
    }

    if ((i - skippedResume) > 0 && (i - skippedResume) % 500 === 0) {
      const elapsed = (Date.now() - scoreStart) / 1000;
      const rendered = i - skippedResume;
      const rate = rendered / elapsed;
      const eta = Math.round((sourcesWithRenders.length - i) / rate);
      const cp = srcChar.codePointAt(0)!;
      const hex = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
      console.log(`  [${i}/${sourcesWithRenders.length}] ${hex} -- ${rate.toFixed(0)} chars/s, ETA ${eta}s  (SSIM: ${ssimComputed}, skipped: ${ssimSkipped}, pairs: ${pairsWithData})`);
    }

    const sources = sourceCache.get(srcChar)!;
    const charPairs: ConfusablePairResult[] = [];
    let charSsimComputed = 0;
    let charSsimSkipped = 0;
    let charSameFont = 0;
    let charCrossFont = 0;

    for (const tgtChar of targetChars) {
      const targets = targetCache.get(tgtChar)!;
      if (targets.length === 0) continue;

      const fontResults: PairFontResult[] = [];

      for (const src of sources) {
        if (standardFontSet.has(src.entry.font)) {
          // Same-font
          if (src.entry.renderStatus === 'fallback') continue;
          const tgt = targets.find(t => t.entry.font === src.entry.font);
          if (!tgt) continue;

          const pHashScore = pHashSimilarity(src.pHash, tgt.pHash);
          if (pHashScore < PHASH_PREFILTER_THRESHOLD) {
            charSsimSkipped++;
            charSameFont++;
            continue;
          }

          const ssimScore = computeSsim(src.norm, tgt.norm);
          fontResults.push({
            sourceFont: src.entry.font,
            targetFont: tgt.entry.font,
            ssim: ssimScore,
            pHash: pHashScore,
            sourceRenderStatus: src.entry.renderStatus as RenderStatus,
            sourceFallbackFont: src.entry.fallbackFont,
            ssimSkipped: false,
          });
          charSsimComputed++;
          charSameFont++;
        } else {
          // Cross-font: top-1-by-pHash
          let bestTgt: DecodedRender | null = null;
          let bestPHash = 0;
          for (const tgt of targets) {
            const sim = pHashSimilarity(src.pHash, tgt.pHash);
            if (sim > bestPHash) {
              bestPHash = sim;
              bestTgt = tgt;
            }
          }

          if (!bestTgt || bestPHash < PHASH_PREFILTER_THRESHOLD) {
            charSsimSkipped++;
            charCrossFont++;
            continue;
          }

          const ssimScore = computeSsim(src.norm, bestTgt.norm);
          fontResults.push({
            sourceFont: src.entry.font,
            targetFont: bestTgt.entry.font,
            ssim: ssimScore,
            pHash: bestPHash,
            sourceRenderStatus: src.entry.renderStatus as RenderStatus,
            sourceFallbackFont: src.entry.fallbackFont,
            ssimSkipped: false,
          });
          charSsimComputed++;
          charCrossFont++;
        }
      }

      if (fontResults.length === 0) continue;

      const cp = srcChar.codePointAt(0)!;
      const summary = computePairSummary(fontResults);
      charPairs.push({
        source: srcChar,
        sourceCodepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
        target: tgtChar,
        fonts: fontResults,
        summary,
      });
    }

    // Write progress to disk immediately
    const progressEntry: ProgressEntry = {
      srcChar,
      pairs: charPairs,
      ssimComputed: charSsimComputed,
      ssimSkipped: charSsimSkipped,
      sameFontTotal: charSameFont,
      crossFontTotal: charCrossFont,
    };
    fs.writeSync(progressFd, JSON.stringify(progressEntry) + '\n');

    allResults.push(...charPairs);
    ssimComputed += charSsimComputed;
    ssimSkipped += charSsimSkipped;
    sameFontTotal += charSameFont;
    crossFontTotal += charCrossFont;
    pairsWithData += charPairs.length;
  }

  fs.closeSync(progressFd);

  const scoreElapsed = ((Date.now() - scoreStart) / 1000).toFixed(1);
  console.log(`\n  ${sourcesWithRenders.length} candidates scored in ${scoreElapsed}s`);
  if (skippedResume > 0) {
    console.log(`  ${skippedResume} skipped (resumed), ${sourcesWithRenders.length - skippedResume} scored`);
  }
  console.log(`  Total comparisons: ${sameFontTotal} same-font, ${crossFontTotal} cross-font`);
  console.log(`  SSIM computed: ${ssimComputed}, skipped by pHash: ${ssimSkipped}`);
  console.log(`  Pairs with SSIM data: ${pairsWithData}\n`);

  // 5. Output (streamed)
  const distribution = computeDistribution(allResults);

  allResults.sort((a, b) => (b.summary.meanSsim ?? -1) - (a.summary.meanSsim ?? -1));

  const meta = {
    generatedAt: new Date().toISOString(),
    fontsAvailable: m2bIndex.meta.fontsAvailable,
    fontsTotal: m2bIndex.meta.fontsTotal,
    pairCount: allResults.length,
    platform: m2bIndex.meta.platform,
    licence: 'CC-BY-4.0',
    attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
    pHashPrefilterThreshold: PHASH_PREFILTER_THRESHOLD,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Writing m2b-scores.json.gz (streaming)...');
  const gz = createGzWriter(OUTPUT_JSON);
  gz.write('{\n');
  gz.write(`"meta": ${JSON.stringify(meta, null, 2)},\n`);
  gz.write(`"distribution": ${JSON.stringify(distribution, null, 2)},\n`);
  gz.write('"pairs": [\n');

  const BATCH_SIZE = 1000;
  for (let i = 0; i < allResults.length; i += BATCH_SIZE) {
    const batch = allResults.slice(i, Math.min(i + BATCH_SIZE, allResults.length));
    const lines = batch.map((r, j) => {
      const isLast = (i + j) === allResults.length - 1;
      return JSON.stringify(r) + (isLast ? '' : ',');
    });
    gz.write(lines.join('\n') + '\n');
  }

  gz.write(']\n}\n');
  await gz.close();

  // Clean up progress on successful completion
  if (fs.existsSync(PROGRESS_JSONL)) {
    fs.unlinkSync(PROGRESS_JSONL);
  }

  const fileSizeMB = (fs.statSync(OUTPUT_JSON).size / 1024 / 1024).toFixed(1);
  console.log(`Output written to: ${OUTPUT_JSON} (${fileSizeMB} MB)\n`);

  printSummary(allResults, distribution);
}

function computeDistribution(results: ConfusablePairResult[]) {
  let high = 0, medium = 0, low = 0, noData = 0;
  for (const r of results) {
    const s = r.summary.meanSsim;
    if (s === null) noData++;
    else if (s >= 0.7) high++;
    else if (s >= 0.3) medium++;
    else low++;
  }
  return { high, medium, low, noData, total: results.length };
}

function printSummary(results: ConfusablePairResult[], d: ReturnType<typeof computeDistribution>) {
  console.log('=== SUMMARY ===');
  console.log(`M2b pairs with SSIM data: ${results.length}`);
  console.log('');
  console.log('SSIM distribution:');
  console.log(`  High (>= 0.7):  ${d.high} (${d.total > 0 ? (100 * d.high / d.total).toFixed(1) : 0}%)`);
  console.log(`  Medium (0.3-0.7): ${d.medium} (${d.total > 0 ? (100 * d.medium / d.total).toFixed(1) : 0}%)`);
  console.log(`  Low (< 0.3):    ${d.low} (${d.total > 0 ? (100 * d.low / d.total).toFixed(1) : 0}%)`);
  console.log(`  No data:        ${d.noData} (${d.total > 0 ? (100 * d.noData / d.total).toFixed(1) : 0}%)`);
  console.log('');

  const withSsim = results.filter(p => p.summary.meanSsim !== null);

  if (withSsim.length > 0) {
    console.log('Top 30 highest-scoring M2b pairs:');
    for (const p of withSsim.slice(0, 30)) {
      const s = p.summary;
      console.log(
        `  ${p.sourceCodepoint.padEnd(10)} -> "${p.target}"  SSIM=${s.meanSsim!.toFixed(4)}  pHash=${s.meanPHash?.toFixed(4) ?? 'N/A'}  (${s.validFontCount} fonts)`,
      );
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
