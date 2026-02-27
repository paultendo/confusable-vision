/**
 * score-multichar.ts -- Milestone 4
 *
 * Scores multi-character sequences against single-char targets.
 * Self-contained: loads both sources and targets from the multichar index.
 * Same-font only (both sources and targets in standard fonts).
 * pHash prefilter at 0.5 (tighter than M2's 0.3 -- single-char pHash is too
 * similar across Latin glyphs at 0.3, letting 95%+ through).
 *
 * 3,844 sequences x 62 targets x ~74 fonts = ~17.6M pHash checks.
 *
 * Writes progress incrementally to progress.jsonl so the run can be
 * resumed after a crash without re-scoring completed sequences.
 *
 * Prerequisite:
 *   npx tsx scripts/build-multichar-candidates.ts
 *   npx tsx scripts/build-index-multichar.ts
 *
 * Usage:
 *   npx tsx scripts/score-multichar.ts            # fresh or auto-resume
 *   npx tsx scripts/score-multichar.ts --fresh     # force fresh start
 */

// Must be set before any imports that use libuv (sharp uses the thread pool)
process.env.UV_THREADPOOL_SIZE = '16';

import fs from 'node:fs';
import path from 'node:path';
import { computeSsim, pHashSimilarity } from '../src/compare.js';
import { normalisePairCached, decodeAndFindBounds, inkCoverage, getInkWidth } from '../src/normalise-image.js';
import type { DecodedGreyWithBounds } from '../src/normalise-image.js';
import type {
  RenderIndex,
  IndexRenderEntry,
  PairFontResult,
  PairSummary,
  MulticharPairResult,
  RenderStatus,
} from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// Multichar index (sources + targets)
const MULTICHAR_INDEX_DIR = path.join(ROOT, 'data/output/multichar-index');
const MULTICHAR_INDEX_JSON = path.join(MULTICHAR_INDEX_DIR, 'index.json');
const MULTICHAR_RENDERS_DIR = path.join(MULTICHAR_INDEX_DIR, 'renders');

const OUTPUT_DIR = path.join(ROOT, 'data/output');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'multichar-scores.json');
const PROGRESS_JSONL = path.join(OUTPUT_DIR, 'multichar-scores-progress.jsonl');

const PHASH_PREFILTER_THRESHOLD = 0.5;
const WIDTH_RATIO_MAX = 2.0;
const INK_COVERAGE_MIN = 0.03;
const CONCURRENCY = 12;
const FORCE_FRESH = process.argv.includes('--fresh');

interface DecodedRender {
  entry: IndexRenderEntry;
  rawPng: Buffer;
  pHash: bigint;
}

/** Progress line: all pair results for one source sequence. */
interface ProgressEntry {
  seq: string;
  pairs: MulticharPairResult[];
  ssimComputed: number;
  ssimSkipped: number;
  widthRatioSkipped?: number;
  inkCoverageSkipped?: number;
}

function readPng(pngPath: string): Buffer {
  return fs.readFileSync(pngPath);
}

/** Load progress.jsonl, returning a map of seq -> ProgressEntry. Tolerates corrupt last line. */
function loadProgress(): Map<string, ProgressEntry> {
  const completed = new Map<string, ProgressEntry>();
  if (!fs.existsSync(PROGRESS_JSONL)) return completed;

  const lines = fs.readFileSync(PROGRESS_JSONL, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj: ProgressEntry = JSON.parse(line);
      completed.set(obj.seq, obj);
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
  console.log('=== confusable-vision: score-multichar (Milestone 4) ===\n');

  // 1. Load multichar index (sources + targets, self-contained)
  console.log('[1/3] Loading render index...');
  if (!fs.existsSync(MULTICHAR_INDEX_JSON)) {
    console.error(`ERROR: ${MULTICHAR_INDEX_JSON} not found. Run build-index-multichar.ts first.`);
    process.exit(1);
  }
  const mcIndex: RenderIndex = JSON.parse(fs.readFileSync(MULTICHAR_INDEX_JSON, 'utf-8'));
  const sourceKeys = Object.keys(mcIndex.sources);
  const sourcesWithRenders = sourceKeys.filter(k => mcIndex.sources[k]!.length > 0);
  // All 62 targets (a-z + A-Z + 0-9) from the self-contained index
  const targetKeys = Object.keys(mcIndex.targets).filter(c => mcIndex.targets[c]!.length > 0);
  console.log(`  ${sourcesWithRenders.length} sequences with renders, ${targetKeys.length} targets\n`);

  // 2. Decode all renders into memory
  console.log('[2/3] Decoding all renders...');
  const decodeStart = Date.now();

  const sourceCache = new Map<string, DecodedRender[]>();
  let sourceDecoded = 0;
  for (const seq of sourcesWithRenders) {
    const entries = mcIndex.sources[seq]!;
    const decoded: DecodedRender[] = [];
    for (const entry of entries) {
      const rawPng = readPng(path.join(MULTICHAR_RENDERS_DIR, entry.png));
      const pHash = BigInt('0x' + entry.pHash);
      decoded.push({ entry, rawPng, pHash });
      sourceDecoded++;
    }
    sourceCache.set(seq, decoded);
  }

  const targetCache = new Map<string, DecodedRender[]>();
  let targetDecoded = 0;
  for (const char of targetKeys) {
    const entries = mcIndex.targets[char]!;
    const decoded: DecodedRender[] = [];
    for (const entry of entries) {
      const rawPng = readPng(path.join(MULTICHAR_RENDERS_DIR, entry.png));
      const pHash = BigInt('0x' + entry.pHash);
      decoded.push({ entry, rawPng, pHash });
      targetDecoded++;
    }
    targetCache.set(char, decoded);
  }

  const decodeElapsed = ((Date.now() - decodeStart) / 1000).toFixed(1);
  console.log(`  Decoded ${sourceDecoded} source + ${targetDecoded} target renders in ${decodeElapsed}s`);

  // Pre-build target font lookup maps: Map<tgtChar, Map<fontName, DecodedRender>>
  const targetFontMaps = new Map<string, Map<string, DecodedRender>>();
  for (const tgtChar of targetKeys) {
    const fontMap = new Map<string, DecodedRender>();
    for (const t of targetCache.get(tgtChar)!) {
      fontMap.set(t.entry.font, t);
    }
    targetFontMaps.set(tgtChar, fontMap);
  }

  // Pre-cache target decode + ink bounds (avoids redundant sharp decodes in hot loop)
  console.log('  Pre-caching target decode + ink bounds...');
  const targetDecodeCache = new Map<string, DecodedGreyWithBounds>();
  const targetInkWidths = new Map<string, number | null>();
  for (const [tgtChar, renders] of targetCache) {
    for (const d of renders) {
      const cacheKey = `${tgtChar}:${d.entry.font}`;
      const decoded = await decodeAndFindBounds(d.rawPng);
      targetDecodeCache.set(cacheKey, decoded);
      targetInkWidths.set(cacheKey, getInkWidth(decoded));
    }
  }
  const cacheElapsed = ((Date.now() - decodeStart) / 1000).toFixed(1);
  console.log(`  Target decode cache built (${targetDecodeCache.size} entries) in ${cacheElapsed}s\n`);

  // 3. Score: same-font only (with resume)
  let completedProgress: Map<string, ProgressEntry>;

  if (FORCE_FRESH || !fs.existsSync(PROGRESS_JSONL)) {
    if (fs.existsSync(PROGRESS_JSONL)) {
      fs.unlinkSync(PROGRESS_JSONL);
    }
    completedProgress = new Map();
    console.log('[3/3] Scoring multichar pairs (fresh start, same-font only)...');
  } else {
    completedProgress = loadProgress();
    console.log(`[3/3] Scoring multichar pairs (resuming: ${completedProgress.size}/${sourcesWithRenders.length} done, same-font only)...`);
  }

  const progressFd = fs.openSync(PROGRESS_JSONL, 'a');
  const scoreStart = Date.now();

  const allResults: MulticharPairResult[] = [];
  let ssimComputed = 0;
  let ssimSkipped = 0;
  let widthRatioSkipped = 0;
  let inkCoverageSkipped = 0;
  let pairsWithData = 0;
  let skippedResume = 0;

  for (let i = 0; i < sourcesWithRenders.length; i++) {
    const seq = sourcesWithRenders[i]!;

    // Resume: skip already-completed sequences
    if (completedProgress.has(seq)) {
      const prev = completedProgress.get(seq)!;
      allResults.push(...prev.pairs);
      ssimComputed += prev.ssimComputed;
      ssimSkipped += prev.ssimSkipped;
      widthRatioSkipped += prev.widthRatioSkipped ?? 0;
      inkCoverageSkipped += prev.inkCoverageSkipped ?? 0;
      pairsWithData += prev.pairs.length;
      skippedResume++;
      continue;
    }

    if ((i - skippedResume) > 0 && (i - skippedResume) % 100 === 0) {
      const elapsed = (Date.now() - scoreStart) / 1000;
      const rendered = i - skippedResume;
      const rate = rendered / elapsed;
      const eta = Math.round((sourcesWithRenders.length - i) / rate);
      console.log(`  [${i}/${sourcesWithRenders.length}] "${seq}" -- ${rate.toFixed(0)} seqs/s, ETA ${eta}s  (SSIM: ${ssimComputed}, pHash-skip: ${ssimSkipped}, wRatio-skip: ${widthRatioSkipped}, ink-skip: ${inkCoverageSkipped})`);
    }

    const sources = sourceCache.get(seq)!;
    const seqPairs: MulticharPairResult[] = [];
    let seqSsimComputed = 0;
    let seqSsimSkipped = 0;
    let seqWidthRatioSkipped = 0;
    let seqInkCoverageSkipped = 0;

    // Pre-cache source decodes + ink widths for this sequence
    const sourceDecodes = new Map<string, DecodedGreyWithBounds>();
    const sourceInkWidths = new Map<string, number | null>();
    for (const src of sources) {
      const decoded = await decodeAndFindBounds(src.rawPng);
      sourceDecodes.set(src.entry.font, decoded);
      sourceInkWidths.set(src.entry.font, getInkWidth(decoded));
    }

    // Collect all pHash-passing pairs for this sequence across all targets
    const work: Array<{
      src: DecodedRender;
      tgt: DecodedRender;
      tgtChar: string;
      pHashScore: number;
      cachedA: DecodedGreyWithBounds;
      cachedB: DecodedGreyWithBounds;
    }> = [];

    for (const tgtChar of targetKeys) {
      const tgtFontMap = targetFontMaps.get(tgtChar)!;

      for (const src of sources) {
        const tgt = tgtFontMap.get(src.entry.font);
        if (!tgt) continue;

        const pHashScore = pHashSimilarity(src.pHash, tgt.pHash);
        if (pHashScore < PHASH_PREFILTER_THRESHOLD) {
          seqSsimSkipped++;
          continue;
        }

        // Width-ratio gate: skip pairs where ink widths differ by > 2x
        // Uses pre-computed widths (no per-pair getInkWidth calls)
        const srcInkW = sourceInkWidths.get(src.entry.font)!;
        const tgtInkW = targetInkWidths.get(`${tgtChar}:${src.entry.font}`)!;
        if (srcInkW && tgtInkW) {
          const ratio = Math.max(srcInkW, tgtInkW) / Math.min(srcInkW, tgtInkW);
          if (ratio > WIDTH_RATIO_MAX) {
            seqWidthRatioSkipped++;
            continue;
          }
        }

        const cachedA = sourceDecodes.get(src.entry.font)!;
        const cachedB = targetDecodeCache.get(`${tgtChar}:${src.entry.font}`)!;
        work.push({ src, tgt, tgtChar, pHashScore, cachedA, cachedB });
      }
    }

    // Process in concurrent batches
    const fontResultsByTarget = new Map<string, PairFontResult[]>();

    for (let b = 0; b < work.length; b += CONCURRENCY) {
      const batch = work.slice(b, b + CONCURRENCY);
      const results = await Promise.all(batch.map(async (item) => {
        const [srcNorm, tgtNorm] = await normalisePairCached(
          item.cachedA,
          item.cachedB,
        );

        // Ink-coverage floor: skip if either normalized image has < 3% ink
        const srcInk = inkCoverage(srcNorm.rawPixels);
        const tgtInk = inkCoverage(tgtNorm.rawPixels);
        if (srcInk < INK_COVERAGE_MIN || tgtInk < INK_COVERAGE_MIN) {
          return { ...item, ssimScore: null as number | null, inkFiltered: true };
        }

        const ssimScore: number | null = computeSsim(srcNorm, tgtNorm);
        return { ...item, ssimScore, inkFiltered: false };
      }));

      for (const r of results) {
        if (r.inkFiltered) {
          seqInkCoverageSkipped++;
          continue;
        }
        if (!fontResultsByTarget.has(r.tgtChar)) {
          fontResultsByTarget.set(r.tgtChar, []);
        }
        fontResultsByTarget.get(r.tgtChar)!.push({
          sourceFont: r.src.entry.font,
          targetFont: r.tgt.entry.font,
          ssim: r.ssimScore,
          pHash: r.pHashScore,
          sourceRenderStatus: 'native' as RenderStatus,
          sourceFallbackFont: null,
          ssimSkipped: false,
        });
        seqSsimComputed++;
      }
    }

    // Build pair results per target
    for (const tgtChar of targetKeys) {
      const fontResults = fontResultsByTarget.get(tgtChar);
      if (!fontResults || fontResults.length === 0) continue;

      const summary = computePairSummary(fontResults);
      seqPairs.push({
        source: seq,
        sourceChars: [...seq],
        target: tgtChar,
        fonts: fontResults,
        summary,
      });
    }

    // Write progress to disk immediately
    const progressEntry: ProgressEntry = {
      seq,
      pairs: seqPairs,
      ssimComputed: seqSsimComputed,
      ssimSkipped: seqSsimSkipped,
      widthRatioSkipped: seqWidthRatioSkipped,
      inkCoverageSkipped: seqInkCoverageSkipped,
    };
    fs.writeSync(progressFd, JSON.stringify(progressEntry) + '\n');

    allResults.push(...seqPairs);
    ssimComputed += seqSsimComputed;
    ssimSkipped += seqSsimSkipped;
    widthRatioSkipped += seqWidthRatioSkipped;
    inkCoverageSkipped += seqInkCoverageSkipped;
    pairsWithData += seqPairs.length;
  }

  fs.closeSync(progressFd);

  const scoreElapsed = ((Date.now() - scoreStart) / 1000).toFixed(1);
  console.log(`\n  ${sourcesWithRenders.length} sequences scored in ${scoreElapsed}s`);
  if (skippedResume > 0) {
    console.log(`  ${skippedResume} skipped (resumed), ${sourcesWithRenders.length - skippedResume} scored`);
  }
  console.log(`  SSIM computed: ${ssimComputed}`);
  console.log(`  Skipped by pHash: ${ssimSkipped}`);
  console.log(`  Skipped by width ratio (>${WIDTH_RATIO_MAX}x): ${widthRatioSkipped}`);
  console.log(`  Skipped by ink coverage (<${(INK_COVERAGE_MIN * 100).toFixed(0)}%): ${inkCoverageSkipped}`);
  console.log(`  Pairs with SSIM data: ${pairsWithData}\n`);

  // 4. Output
  const distribution = computeDistribution(allResults);

  allResults.sort((a, b) => (b.summary.meanSsim ?? -1) - (a.summary.meanSsim ?? -1));

  const meta = {
    generatedAt: new Date().toISOString(),
    fontsAvailable: mcIndex.meta.fontsAvailable,
    fontsTotal: mcIndex.meta.fontsTotal,
    pairCount: allResults.length,
    platform: mcIndex.meta.platform,
    licence: 'CC-BY-4.0',
    attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
    pHashPrefilterThreshold: PHASH_PREFILTER_THRESHOLD,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Writing multichar-scores.json (streaming)...');
  const fd = fs.openSync(OUTPUT_JSON, 'w');
  fs.writeSync(fd, '{\n');
  fs.writeSync(fd, `"meta": ${JSON.stringify(meta, null, 2)},\n`);
  fs.writeSync(fd, `"distribution": ${JSON.stringify(distribution, null, 2)},\n`);
  fs.writeSync(fd, '"pairs": [\n');

  const BATCH_SIZE = 1000;
  for (let i = 0; i < allResults.length; i += BATCH_SIZE) {
    const batch = allResults.slice(i, Math.min(i + BATCH_SIZE, allResults.length));
    const lines = batch.map((r, j) => {
      const isLast = (i + j) === allResults.length - 1;
      return JSON.stringify(r) + (isLast ? '' : ',');
    });
    fs.writeSync(fd, lines.join('\n') + '\n');
  }

  fs.writeSync(fd, ']\n}\n');
  fs.closeSync(fd);

  // Clean up progress on successful completion
  if (fs.existsSync(PROGRESS_JSONL)) {
    fs.unlinkSync(PROGRESS_JSONL);
  }

  const fileSizeMB = (fs.statSync(OUTPUT_JSON).size / 1024 / 1024).toFixed(1);
  console.log(`Output written to: ${OUTPUT_JSON} (${fileSizeMB} MB)\n`);

  const passed = printSummaryAndValidate(allResults, distribution);
  if (!passed) {
    console.log('\nValidation gate FAILED. Rendering fix did not work.');
    process.exit(1);
  }
}

function computeDistribution(results: MulticharPairResult[]) {
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

/** Print summary and run validation gate. Returns true if all checks pass. */
function printSummaryAndValidate(results: MulticharPairResult[], d: ReturnType<typeof computeDistribution>): boolean {
  console.log('=== SUMMARY ===');
  console.log(`Multichar pairs with SSIM data: ${results.length}`);
  console.log('');
  console.log('SSIM distribution:');
  console.log(`  High (>= 0.7):  ${d.high} (${d.total > 0 ? (100 * d.high / d.total).toFixed(1) : 0}%)`);
  console.log(`  Medium (0.3-0.7): ${d.medium} (${d.total > 0 ? (100 * d.medium / d.total).toFixed(1) : 0}%)`);
  console.log(`  Low (< 0.3):    ${d.low} (${d.total > 0 ? (100 * d.low / d.total).toFixed(1) : 0}%)`);
  console.log(`  No data:        ${d.noData} (${d.total > 0 ? (100 * d.noData / d.total).toFixed(1) : 0}%)`);
  console.log('');

  const withSsim = results.filter(p => p.summary.meanSsim !== null);

  console.log('Top 30 highest-scoring multichar pairs:');
  for (const p of withSsim.slice(0, 30)) {
    const s = p.summary;
    const scored = p.fonts.filter(f => f.ssim !== null);
    console.log(
      `  "${p.source}" -> "${p.target}"  SSIM=${s.meanSsim!.toFixed(4)}  pHash=${s.meanPHash?.toFixed(4) ?? 'N/A'}  (${scored.length} fonts)`,
    );
  }

  // Known sanity checks
  console.log('\nSanity checks:');
  const rnM = withSsim.find(p => p.source === 'rn' && p.target === 'm');
  const clD = withSsim.find(p => p.source === 'cl' && p.target === 'd');
  const vvW = withSsim.find(p => p.source === 'vv' && p.target === 'w');
  const aaM = withSsim.find(p => p.source === 'aa' && p.target === 'm');

  if (rnM) console.log(`  "rn" vs "m": SSIM=${rnM.summary.meanSsim!.toFixed(4)} (should be high)`);
  else console.log('  "rn" vs "m": NOT FOUND');

  if (clD) console.log(`  "cl" vs "d": SSIM=${clD.summary.meanSsim!.toFixed(4)} (should be high)`);
  else console.log('  "cl" vs "d": NOT FOUND');

  if (vvW) console.log(`  "vv" vs "w": SSIM=${vvW.summary.meanSsim!.toFixed(4)} (should be high)`);
  else console.log('  "vv" vs "w": NOT FOUND');

  if (aaM) console.log(`  "aa" vs "m": SSIM=${aaM.summary.meanSsim!.toFixed(4)} (should be low -- negative control)`);
  else console.log('  "aa" vs "m": NOT FOUND (negative control)');

  // Validation gate
  console.log('\n=== VALIDATION GATE ===');
  let passed = true;

  // Check 1: "rn"/"m" mean SSIM > 0.5 (monospace fonts drag mean down)
  if (rnM && rnM.summary.meanSsim !== null && rnM.summary.meanSsim > 0.5) {
    console.log(`  PASS: "rn"/"m" mean SSIM = ${rnM.summary.meanSsim.toFixed(4)} (> 0.5)`);
  } else {
    const score = rnM?.summary.meanSsim?.toFixed(4) ?? 'N/A';
    console.log(`  FAIL: "rn"/"m" mean SSIM = ${score} (need > 0.5)`);
    passed = false;
  }

  // Check 2: "rn"/"m" max SSIM > 0.75 in at least one font
  if (rnM) {
    const ssimValues = rnM.fonts.map(f => f.ssim).filter((v): v is number => v !== null);
    const maxSsim = ssimValues.length > 0 ? Math.max(...ssimValues) : 0;
    if (maxSsim > 0.75) {
      console.log(`  PASS: "rn"/"m" max SSIM = ${maxSsim.toFixed(4)} (> 0.75)`);
    } else {
      console.log(`  FAIL: "rn"/"m" max SSIM = ${maxSsim.toFixed(4)} (need > 0.75)`);
      passed = false;
    }
  } else {
    console.log('  FAIL: "rn"/"m" pair not found in results');
    passed = false;
  }

  // Check 3: "ww"/"n" should score LOW (width-ratio artifact in old pipeline)
  const wwN = withSsim.find(p => p.source === 'ww' && p.target === 'n');
  if (!wwN || wwN.summary.meanSsim === null || wwN.summary.meanSsim < 0.5) {
    console.log(`  PASS: "ww"/"n" mean SSIM = ${wwN?.summary.meanSsim?.toFixed(4) ?? 'N/A (filtered)'} (< 0.5 or filtered)`);
  } else {
    console.log(`  FAIL: "ww"/"n" mean SSIM = ${wwN.summary.meanSsim.toFixed(4)} (need < 0.5 or filtered)`);
    passed = false;
  }

  // Check 4: "mm"/"n" should score LOW
  const mmN = withSsim.find(p => p.source === 'mm' && p.target === 'n');
  if (!mmN || mmN.summary.meanSsim === null || mmN.summary.meanSsim < 0.5) {
    console.log(`  PASS: "mm"/"n" mean SSIM = ${mmN?.summary.meanSsim?.toFixed(4) ?? 'N/A (filtered)'} (< 0.5 or filtered)`);
  } else {
    console.log(`  FAIL: "mm"/"n" mean SSIM = ${mmN.summary.meanSsim.toFixed(4)} (need < 0.5 or filtered)`);
    passed = false;
  }

  // Check 5: "aa"/"m" should score LOW
  if (aaM && aaM.summary.meanSsim !== null && aaM.summary.meanSsim >= 0.5) {
    console.log(`  FAIL: "aa"/"m" mean SSIM = ${aaM.summary.meanSsim.toFixed(4)} (need < 0.5 or filtered)`);
    passed = false;
  } else {
    console.log(`  PASS: "aa"/"m" mean SSIM = ${aaM?.summary.meanSsim?.toFixed(4) ?? 'N/A (filtered)'} (< 0.5 or filtered)`);
  }

  return passed;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
