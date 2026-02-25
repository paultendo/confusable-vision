/**
 * score-all-pairs.ts -- Milestone 1b
 *
 * Score all ~1,400 confusable pairs from TR39 confusables.txt across every
 * available font. Uses pHash as a cheap prefilter to skip expensive SSIM
 * computation for pairs that are obviously dissimilar.
 *
 * Input:  data/input/confusable-pairs.json (from fetch-confusables.ts)
 * Output: data/output/confusable-scores.json
 *
 * Usage:
 *   npx tsx scripts/fetch-confusables.ts          # First: generate input
 *   npx tsx scripts/score-all-pairs.ts            # Then: score all pairs
 *   npx tsx scripts/score-all-pairs.ts --save-renders  # Also save PNGs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { initFonts } from '../src/fonts.js';
import { renderCharacter, detectFallback } from '../src/renderer.js';
import { normaliseImage } from '../src/normalise-image.js';
import { computeSsim, computePHash, pHashSimilarity } from '../src/compare.js';
import type {
  ConfusablePair,
  FontEntry,
  PairFontResult,
  PairSummary,
  ConfusablePairResult,
  ScoreAllPairsOutput,
  NormalisedResult,
  RenderResult,
  RenderStatus,
} from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const INPUT_PATH = path.join(ROOT, 'data/input/confusable-pairs.json');
const OUTPUT_DIR = path.join(ROOT, 'data/output');
const RENDERS_DIR = path.join(OUTPUT_DIR, 'renders-1b');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'confusable-scores.json');

// pHash prefilter: skip SSIM if pHash similarity is below this threshold.
// 0.2 is very permissive -- only skips pairs that share fewer than 13/64 hash bits.
const PHASH_PREFILTER_THRESHOLD = 0.2;

const saveRenders = process.argv.includes('--save-renders');

async function main() {
  console.log('=== confusable-vision: score-all-pairs (milestone 1b) ===\n');

  // 1. Init fonts
  console.log('[1/4] Initialising fonts...');
  const fonts = initFonts();
  const availableFonts = fonts.filter(f => f.available);
  const fallbackFonts = availableFonts.filter(f => f.category === 'math' || f.category === 'symbol');
  const standardFonts = availableFonts.filter(f => f.category === 'standard');

  console.log(`  Fallback fonts: ${fallbackFonts.map(f => f.family).join(', ')}`);
  console.log(`  Standard fonts: ${standardFonts.length}\n`);

  if (availableFonts.length < 2) {
    console.error(`ERROR: Need at least 2 fonts, found ${availableFonts.length}`);
    process.exit(1);
  }

  // 2. Load pairs
  console.log('[2/4] Loading confusable pairs...');
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`ERROR: ${INPUT_PATH} not found. Run fetch-confusables.ts first.`);
    process.exit(1);
  }
  const pairs: ConfusablePair[] = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  console.log(`  Loaded ${pairs.length} pairs\n`);

  // 3. Ensure output dirs
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (saveRenders) {
    fs.mkdirSync(RENDERS_DIR, { recursive: true });
    console.log('  --save-renders enabled\n');
  }

  // 4. Process pairs
  console.log('[3/4] Scoring pairs...\n');
  const results: ConfusablePairResult[] = [];
  const startTime = Date.now();
  let ssimSkippedTotal = 0;
  let ssimComputedTotal = 0;

  // Pre-render target characters (a-z, 0-9) in all fonts once.
  // These are reused across many pairs since most targets are common Latin chars.
  console.log('  Pre-rendering target characters...');
  const targetCache = new Map<string, Map<string, NormalisedResult | null>>();
  const targetChars = [...new Set(pairs.map(p => p.target))];
  for (const target of targetChars) {
    const fontMap = new Map<string, NormalisedResult | null>();
    for (const font of availableFonts) {
      const result = renderCharacter(target, font.family);
      if (result) {
        fontMap.set(font.family, await normaliseImage(result.pngBuffer));
      } else {
        fontMap.set(font.family, null);
      }
    }
    targetCache.set(target, fontMap);
  }
  console.log(`  Cached ${targetChars.length} target characters across ${availableFonts.length} fonts\n`);

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;

    // Progress logging every 100 pairs
    if (i > 0 && i % 100 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = i / elapsed;
      const eta = Math.round((pairs.length - i) / rate);
      console.log(`  [${i}/${pairs.length}] ${pair.sourceCodepoint} -- ${rate.toFixed(1)} pairs/s, ETA ${eta}s (${ssimSkippedTotal} SSIM skipped)`);
    }

    // Build fallback reference renders for this source character
    const fallbackRenders = new Map<string, Buffer>();
    for (const fb of fallbackFonts) {
      const result = renderCharacter(pair.source, fb.family);
      if (result) {
        fallbackRenders.set(fb.family, result.rawPixels);
      }
    }

    const fontResults: PairFontResult[] = [];

    for (const font of availableFonts) {
      // Render source
      const sourceResult = renderCharacter(pair.source, font.family);
      if (!sourceResult) {
        fontResults.push({
          font: font.family,
          ssim: null,
          pHash: null,
          sourceRenderStatus: 'notdef',
          sourceFallbackFont: null,
          ssimSkipped: false,
        });
        continue;
      }

      // Detect fallback
      let renderStatus: RenderStatus = 'native';
      let fallbackFont: string | null = null;
      if (font.category === 'standard') {
        const match = detectFallback(sourceResult.rawPixels, fallbackRenders);
        if (match) {
          renderStatus = 'fallback';
          fallbackFont = match;
        }
      }

      // Get cached target render for this font
      const targetNorm = targetCache.get(pair.target)?.get(font.family) ?? null;
      if (!targetNorm) {
        fontResults.push({
          font: font.family,
          ssim: null,
          pHash: null,
          sourceRenderStatus: renderStatus,
          sourceFallbackFont: fallbackFont,
          ssimSkipped: false,
        });
        continue;
      }

      // Normalise source
      const sourceNorm = await normaliseImage(sourceResult.pngBuffer);

      // pHash prefilter: compute pHash first (cheap), skip SSIM if too dissimilar
      const sourceHash = await computePHash(sourceNorm.rawPixels, sourceNorm.width, sourceNorm.height);
      const targetHash = await computePHash(targetNorm.rawPixels, targetNorm.width, targetNorm.height);
      const pHashScore = pHashSimilarity(sourceHash, targetHash);

      let ssimScore: number | null = null;
      let ssimSkipped = false;

      if (pHashScore >= PHASH_PREFILTER_THRESHOLD) {
        ssimScore = computeSsim(sourceNorm, targetNorm);
        ssimComputedTotal++;
      } else {
        ssimSkipped = true;
        ssimSkippedTotal++;
      }

      fontResults.push({
        font: font.family,
        ssim: ssimScore,
        pHash: pHashScore,
        sourceRenderStatus: renderStatus,
        sourceFallbackFont: fallbackFont,
        ssimSkipped,
      });

      // Save diptych if requested (source | target)
      if (saveRenders && !ssimSkipped) {
        await saveDiptych(pair, font, sourceNorm, targetNorm);
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

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Done: ${pairs.length} pairs in ${elapsed}s`);
  console.log(`  SSIM computed: ${ssimComputedTotal}, skipped by pHash prefilter: ${ssimSkippedTotal}\n`);

  // 5. Compute distribution
  console.log('[4/4] Computing summary...\n');
  const distribution = computeDistribution(results);

  const output: ScoreAllPairsOutput = {
    meta: {
      generatedAt: new Date().toISOString(),
      fontsAvailable: availableFonts.length,
      fontsTotal: fonts.length,
      pairCount: pairs.length,
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      licence: 'CC-BY-4.0',
      attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
      pHashPrefilterThreshold: PHASH_PREFILTER_THRESHOLD,
    },
    pairs: results,
    distribution,
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2));
  console.log(`Output written to: ${OUTPUT_JSON}\n`);

  printSummary(output);
}

function computePairSummary(fontResults: PairFontResult[]): PairSummary {
  const nativeCount = fontResults.filter(r => r.sourceRenderStatus === 'native').length;
  const fallbackCount = fontResults.filter(r => r.sourceRenderStatus === 'fallback').length;
  const notdefCount = fontResults.filter(r => r.sourceRenderStatus === 'notdef').length;

  const ssimValues = fontResults
    .map(r => r.ssim)
    .filter((v): v is number => v !== null);
  const pHashValues = fontResults
    .map(r => r.pHash)
    .filter((v): v is number => v !== null);

  return {
    meanSsim: ssimValues.length > 0 ? mean(ssimValues) : null,
    meanPHash: pHashValues.length > 0 ? mean(pHashValues) : null,
    nativeFontCount: nativeCount,
    fallbackFontCount: fallbackCount,
    notdefFontCount: notdefCount,
    validFontCount: ssimValues.length + fontResults.filter(r => r.ssimSkipped).length,
  };
}

function computeDistribution(results: ConfusablePairResult[]) {
  let high = 0;
  let medium = 0;
  let low = 0;
  let noData = 0;

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

  // Top 20 highest-scoring pairs
  const sorted = [...output.pairs]
    .filter(p => p.summary.meanSsim !== null)
    .sort((a, b) => b.summary.meanSsim! - a.summary.meanSsim!);

  console.log('Top 20 most visually confusable pairs:');
  for (const p of sorted.slice(0, 20)) {
    const s = p.summary;
    console.log(
      `  ${p.sourceCodepoint.padEnd(10)} ${JSON.stringify(p.source).padEnd(6)} -> "${p.target}"  SSIM=${s.meanSsim!.toFixed(4)}  pHash=${s.meanPHash?.toFixed(4) ?? 'N/A'}  (${s.nativeFontCount}n/${s.fallbackFontCount}fb)`,
    );
  }

  console.log('');

  // Bottom 20 lowest-scoring pairs (potential false positives in TR39)
  console.log('Bottom 20 least visually confusable pairs (potential false positives):');
  const sortedAsc = sorted.reverse();
  for (const p of sortedAsc.slice(0, 20)) {
    const s = p.summary;
    console.log(
      `  ${p.sourceCodepoint.padEnd(10)} ${JSON.stringify(p.source).padEnd(6)} -> "${p.target}"  SSIM=${s.meanSsim!.toFixed(4)}  pHash=${s.meanPHash?.toFixed(4) ?? 'N/A'}  (${s.nativeFontCount}n/${s.fallbackFontCount}fb)`,
    );
  }
}

/** Save a diptych PNG: source | target */
async function saveDiptych(
  pair: ConfusablePair,
  font: FontEntry,
  source: NormalisedResult,
  target: NormalisedResult,
) {
  const cellSize = 48;
  const totalWidth = cellSize * 2;
  const totalHeight = cellSize;

  const diptych = await sharp({
    create: {
      width: totalWidth,
      height: totalHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: source.pngBuffer, left: 0, top: 0 },
      { input: target.pngBuffer, left: cellSize, top: 0 },
    ])
    .png()
    .toBuffer();

  const safeFontName = font.family.replace(/\s+/g, '-');
  const safeCodepoint = pair.sourceCodepoint.replace('+', '');
  const filename = `${safeCodepoint}_{${safeFontName}}.png`;
  fs.writeFileSync(path.join(RENDERS_DIR, filename), diptych);
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
