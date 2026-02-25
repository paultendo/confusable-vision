/**
 * score-all-pairs.ts -- Milestone 1b
 *
 * Scores all confusable pairs using the pre-built render index. No rendering
 * happens here -- this script loads normalised PNGs and pHash values from the
 * index and computes SSIM scores.
 *
 * Comparison strategy:
 * - Standard fonts (Arial, Verdana...): same-font comparison (source and target
 *   both rendered in the same font). Only for native renders, not fallbacks.
 * - Non-standard fonts (Noto, STIX, Apple Symbols): cross-font comparison.
 *   Source in the supplemental font, target in each standard font. This captures
 *   the realistic browser scenario where the OS renders exotic characters in a
 *   supplemental font alongside Latin text in the page's standard font.
 *
 * Prerequisite: run build-index.ts first.
 *
 * Usage:
 *   npx tsx scripts/build-index.ts        # Build render index (slow, once)
 *   npx tsx scripts/score-all-pairs.ts    # Score from index (fast, re-runnable)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { computeSsim, pHashSimilarity } from '../src/compare.js';
import type {
  ConfusablePair,
  RenderIndex,
  IndexRenderEntry,
  NormalisedResult,
  PairFontResult,
  PairSummary,
  ConfusablePairResult,
  ScoreAllPairsOutput,
  RenderStatus,
} from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PAIRS_PATH = path.join(ROOT, 'data/input/confusable-pairs.json');
const INDEX_DIR = path.join(ROOT, 'data/output/render-index');
const INDEX_JSON = path.join(INDEX_DIR, 'index.json');
const RENDERS_DIR = path.join(INDEX_DIR, 'renders');
const OUTPUT_DIR = path.join(ROOT, 'data/output');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'confusable-scores.json');

const PHASH_PREFILTER_THRESHOLD = 0.2;

/** Cached decoded render (loaded from PNG on first access) */
interface DecodedRender {
  entry: IndexRenderEntry;
  norm: NormalisedResult;
  pHash: bigint;
}

async function main() {
  console.log('=== confusable-vision: score-all-pairs (milestone 1b) ===\n');

  // 1. Load render index
  console.log('[1/3] Loading render index...');
  if (!fs.existsSync(INDEX_JSON)) {
    console.error(`ERROR: ${INDEX_JSON} not found. Run build-index.ts first.`);
    process.exit(1);
  }
  const index: RenderIndex = JSON.parse(fs.readFileSync(INDEX_JSON, 'utf-8'));
  console.log(`  ${index.meta.sourceCharCount} source chars, ${index.meta.targetCharCount} target chars`);
  console.log(`  ${index.meta.totalRenders} total renders across ${index.meta.fontsAvailable} fonts`);
  console.log(`  Standard fonts: ${index.meta.standardFonts.join(', ')}\n`);

  const standardFontSet = new Set(index.meta.standardFonts);

  // 2. Load and decode all renders into memory
  console.log('[2/3] Decoding renders...');
  const t0 = Date.now();

  // Decode source renders
  const sourceCache = new Map<string, DecodedRender[]>();
  let sourceDecoded = 0;
  for (const [char, entries] of Object.entries(index.sources)) {
    const decoded: DecodedRender[] = [];
    for (const entry of entries) {
      const norm = await decodePng(path.join(RENDERS_DIR, entry.png));
      const pHash = BigInt('0x' + entry.pHash);
      decoded.push({ entry, norm, pHash });
      sourceDecoded++;
    }
    sourceCache.set(char, decoded);
  }

  // Decode target renders
  const targetCache = new Map<string, DecodedRender[]>();
  let targetDecoded = 0;
  for (const [char, entries] of Object.entries(index.targets)) {
    const decoded: DecodedRender[] = [];
    for (const entry of entries) {
      const norm = await decodePng(path.join(RENDERS_DIR, entry.png));
      const pHash = BigInt('0x' + entry.pHash);
      decoded.push({ entry, norm, pHash });
      targetDecoded++;
    }
    targetCache.set(char, decoded);
  }

  const decodeElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Decoded ${sourceDecoded} source + ${targetDecoded} target renders in ${decodeElapsed}s\n`);

  // 3. Load pairs and score
  console.log('[3/3] Scoring pairs...\n');
  if (!fs.existsSync(PAIRS_PATH)) {
    console.error(`ERROR: ${PAIRS_PATH} not found.`);
    process.exit(1);
  }
  const pairs: ConfusablePair[] = JSON.parse(fs.readFileSync(PAIRS_PATH, 'utf-8'));

  const results: ConfusablePairResult[] = [];
  const scoreStart = Date.now();
  let ssimComputed = 0;
  let ssimSkipped = 0;
  let sameFontTotal = 0;
  let crossFontTotal = 0;

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;

    if (i > 0 && i % 200 === 0) {
      const elapsed = (Date.now() - scoreStart) / 1000;
      const rate = i / elapsed;
      const eta = Math.round((pairs.length - i) / rate);
      console.log(`  [${i}/${pairs.length}] ${pair.sourceCodepoint} -- ${rate.toFixed(0)} pairs/s, ETA ${eta}s`);
    }

    const sources = sourceCache.get(pair.source) ?? [];
    const targets = targetCache.get(pair.target) ?? [];

    if (targets.length === 0 || sources.length === 0) {
      results.push({
        source: pair.source,
        sourceCodepoint: pair.sourceCodepoint,
        target: pair.target,
        fonts: [],
        summary: emptySummary(),
      });
      continue;
    }

    const fontResults: PairFontResult[] = [];

    for (const src of sources) {
      if (standardFontSet.has(src.entry.font)) {
        // Same-font: source and target both in this standard font.
        // Skip if source was a silent OS fallback -- the real supplemental font
        // handles the cross-font comparison.
        if (src.entry.renderStatus === 'fallback') continue;

        const tgt = targets.find(t => t.entry.font === src.entry.font);
        if (!tgt) continue;

        const result = scoreComparison(src, tgt);
        fontResults.push(result);
        if (result.ssimSkipped) ssimSkipped++;
        else if (result.ssim !== null) ssimComputed++;
        sameFontTotal++;
      } else {
        // Cross-font: source in supplemental font, target in each standard font.
        for (const tgt of targets) {
          const result = scoreComparison(src, tgt);
          fontResults.push(result);
          if (result.ssimSkipped) ssimSkipped++;
          else if (result.ssim !== null) ssimComputed++;
          crossFontTotal++;
        }
      }
    }

    const summary = computePairSummary(fontResults);
    results.push({
      source: pair.source,
      sourceCodepoint: pair.sourceCodepoint,
      target: pair.target,
      fonts: fontResults,
      summary,
    });
  }

  const scoreElapsed = ((Date.now() - scoreStart) / 1000).toFixed(1);
  console.log(`\n  Done: ${pairs.length} pairs scored in ${scoreElapsed}s`);
  console.log(`  Comparisons: ${sameFontTotal} same-font, ${crossFontTotal} cross-font`);
  console.log(`  SSIM computed: ${ssimComputed}, skipped by pHash prefilter: ${ssimSkipped}\n`);

  // 4. Output
  const distribution = computeDistribution(results);

  const output: ScoreAllPairsOutput = {
    meta: {
      generatedAt: new Date().toISOString(),
      fontsAvailable: index.meta.fontsAvailable,
      fontsTotal: index.meta.fontsTotal,
      pairCount: pairs.length,
      platform: index.meta.platform,
      licence: 'CC-BY-4.0',
      attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
      pHashPrefilterThreshold: PHASH_PREFILTER_THRESHOLD,
    },
    pairs: results,
    distribution,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
  console.log(`Output written to: ${OUTPUT_JSON}\n`);

  printSummary(output);
}

/** Decode a normalised PNG back into a NormalisedResult */
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

function scoreComparison(src: DecodedRender, tgt: DecodedRender): PairFontResult {
  const pHashScore = pHashSimilarity(src.pHash, tgt.pHash);

  let ssimScore: number | null = null;
  let ssimSkipped = false;

  if (pHashScore >= PHASH_PREFILTER_THRESHOLD) {
    ssimScore = computeSsim(src.norm, tgt.norm);
  } else {
    ssimSkipped = true;
  }

  return {
    sourceFont: src.entry.font,
    targetFont: tgt.entry.font,
    ssim: ssimScore,
    pHash: pHashScore,
    sourceRenderStatus: src.entry.renderStatus as RenderStatus,
    sourceFallbackFont: src.entry.fallbackFont,
    ssimSkipped,
  };
}

function emptySummary(): PairSummary {
  return { meanSsim: null, meanPHash: null, nativeFontCount: 0, fallbackFontCount: 0, notdefFontCount: 0, validFontCount: 0 };
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

function printSummary(output: ScoreAllPairsOutput) {
  const { distribution: d, meta } = output;
  console.log('=== SUMMARY ===');
  console.log(`Platform: ${meta.platform}`);
  console.log(`Pairs scored: ${meta.pairCount}`);
  console.log(`Fonts: ${meta.fontsAvailable}/${meta.fontsTotal}`);
  console.log(`pHash prefilter threshold: ${meta.pHashPrefilterThreshold}`);
  console.log('');
  console.log('SSIM distribution:');
  console.log(`  High (>= 0.7):  ${d.high} (${(100 * d.high / d.total).toFixed(1)}%)`);
  console.log(`  Medium (0.3-0.7): ${d.medium} (${(100 * d.medium / d.total).toFixed(1)}%)`);
  console.log(`  Low (< 0.3):    ${d.low} (${(100 * d.low / d.total).toFixed(1)}%)`);
  console.log(`  No data:        ${d.noData} (${(100 * d.noData / d.total).toFixed(1)}%)`);
  console.log('');

  const sorted = [...output.pairs]
    .filter(p => p.summary.meanSsim !== null)
    .sort((a, b) => b.summary.meanSsim! - a.summary.meanSsim!);

  console.log('Top 20 most visually confusable pairs:');
  for (const p of sorted.slice(0, 20)) {
    const s = p.summary;
    const scored = p.fonts.filter(f => f.ssim !== null);
    const cross = scored.filter(f => f.sourceFont !== f.targetFont).length;
    const same = scored.filter(f => f.sourceFont === f.targetFont).length;
    const tag = cross > 0 ? `${same}same/${cross}cross` : `${same}same`;
    console.log(
      `  ${p.sourceCodepoint.padEnd(10)} ${JSON.stringify(p.source).padEnd(6)} -> "${p.target}"  SSIM=${s.meanSsim!.toFixed(4)}  pHash=${s.meanPHash?.toFixed(4) ?? 'N/A'}  (${s.nativeFontCount}n/${s.fallbackFontCount}fb) [${tag}]`,
    );
  }

  console.log('');
  console.log('Bottom 20 least visually confusable pairs (potential false positives):');
  const bottom = sorted.reverse();
  for (const p of bottom.slice(0, 20)) {
    const s = p.summary;
    const scored = p.fonts.filter(f => f.ssim !== null);
    const cross = scored.filter(f => f.sourceFont !== f.targetFont).length;
    const same = scored.filter(f => f.sourceFont === f.targetFont).length;
    const tag = cross > 0 ? `${same}same/${cross}cross` : `${same}same`;
    console.log(
      `  ${p.sourceCodepoint.padEnd(10)} ${JSON.stringify(p.source).padEnd(6)} -> "${p.target}"  SSIM=${s.meanSsim!.toFixed(4)}  pHash=${s.meanPHash?.toFixed(4) ?? 'N/A'}  (${s.nativeFontCount}n/${s.fallbackFontCount}fb) [${tag}]`,
    );
  }
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
