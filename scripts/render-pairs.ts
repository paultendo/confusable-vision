/**
 * render-pairs.ts -- Milestone 1
 *
 * For each of the 31 NFKC/TR39 divergence vectors, render the source character
 * alongside its TR39 and NFKC targets in every available font. Measure visual
 * similarity (SSIM + pHash) and output a scored JSON artifact.
 *
 * Detects silent OS font fallback: when a standard font doesn't contain a glyph,
 * macOS substitutes a math/symbol font. The output tags each render as native,
 * fallback, or notdef so you know which font actually produced the pixels.
 *
 * Usage:
 *   npx tsx scripts/render-pairs.ts               # JSON output only
 *   npx tsx scripts/render-pairs.ts --save-renders # Also save triptych PNGs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { initFonts } from '../src/fonts.js';
import { renderCharacter, detectFallback } from '../src/renderer.js';
import { normaliseImage } from '../src/normalise-image.js';
import { compareImages } from '../src/compare.js';
import type {
  ComposabilityVector,
  FontEntry,
  FontResult,
  RenderResult,
  RenderStatus,
  VectorResult,
  VectorSummary,
  GlobalSummary,
  OutputData,
  NormalisedResult,
} from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const INPUT_PATH = path.join(ROOT, 'data/input/composability-vectors.json');
const OUTPUT_DIR = path.join(ROOT, 'data/output');
const RENDERS_DIR = path.join(OUTPUT_DIR, 'renders');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'divergence-vectors-similarity.json');

const saveRenders = process.argv.includes('--save-renders');

async function main() {
  console.log('=== confusable-vision: render-pairs (milestone 1) ===\n');

  // 1. Init fonts
  console.log('[1/4] Initialising fonts...');
  const fonts = initFonts();
  const availableFonts = fonts.filter(f => f.available);
  const fallbackFonts = availableFonts.filter(f => f.category === 'math' || f.category === 'symbol');
  const standardFonts = availableFonts.filter(f => f.category === 'standard');

  console.log(`  Fallback fonts (math/symbol): ${fallbackFonts.map(f => f.family).join(', ')}`);
  console.log(`  Standard fonts: ${standardFonts.length}\n`);

  if (availableFonts.length < 2) {
    console.error(`ERROR: Need at least 2 fonts, found ${availableFonts.length}`);
    process.exit(1);
  }

  // 2. Load vectors
  console.log('[2/4] Loading composability vectors...');
  const vectors: ComposabilityVector[] = JSON.parse(
    fs.readFileSync(INPUT_PATH, 'utf-8'),
  );
  console.log(`  Loaded ${vectors.length} vectors\n`);

  // 3. Ensure output directories exist
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (saveRenders) {
    fs.mkdirSync(RENDERS_DIR, { recursive: true });
    console.log('  --save-renders enabled: triptychs will be saved\n');
  }

  // 4. Process each vector
  console.log('[3/4] Processing vectors...\n');
  const vectorResults: VectorResult[] = [];

  for (const vec of vectors) {
    console.log(`  --- ${vec.codePoint} (${vec.char}) ---`);
    console.log(`    TR39 target: "${vec.tr39}" | NFKC target: "${vec.nfkc}"`);

    // Build fallback reference renders for this character.
    // If a standard font produces pixels identical to one of these,
    // macOS substituted the fallback font silently.
    const fallbackRenders = new Map<string, Buffer>();
    for (const fb of fallbackFonts) {
      const result = renderCharacter(vec.char, fb.family);
      if (result) {
        fallbackRenders.set(fb.family, result.rawPixels);
      }
    }

    const fontResults: FontResult[] = [];

    for (const font of availableFonts) {
      // Render source character
      const sourceResult = renderCharacter(vec.char, font.family);
      if (!sourceResult) {
        console.log(`    [${font.family}] source is .notdef, skipping`);
        fontResults.push({
          font: font.family,
          tr39: null,
          nfkc: null,
          sourceRenderStatus: 'notdef',
          sourceFallbackFont: null,
        });
        continue;
      }

      // Detect fallback: only check standard fonts against fallback references
      let renderStatus: RenderStatus = 'native';
      let fallbackFont: string | null = null;

      if (font.category === 'standard') {
        const match = detectFallback(sourceResult.rawPixels, fallbackRenders);
        if (match) {
          renderStatus = 'fallback';
          fallbackFont = match;
        }
      }

      const statusTag = renderStatus === 'fallback'
        ? `fallback via ${fallbackFont}`
        : renderStatus;

      // Render TR39 and NFKC targets
      const tr39Result = renderCharacter(vec.tr39, font.family);
      const nfkcResult = renderCharacter(vec.nfkc, font.family);

      // Normalise all three
      const sourceNorm = await normaliseImage(sourceResult.pngBuffer);
      const tr39Norm = tr39Result ? await normaliseImage(tr39Result.pngBuffer) : null;
      const nfkcNorm = nfkcResult ? await normaliseImage(nfkcResult.pngBuffer) : null;

      // Compare
      const tr39Score = await compareImages(sourceNorm, tr39Norm);
      const nfkcScore = await compareImages(sourceNorm, nfkcNorm);

      console.log(
        `    [${font.family}] (${statusTag}) TR39: ssim=${tr39Score?.ssim.toFixed(4) ?? 'N/A'} pHash=${tr39Score?.pHash.toFixed(4) ?? 'N/A'} | NFKC: ssim=${nfkcScore?.ssim.toFixed(4) ?? 'N/A'} pHash=${nfkcScore?.pHash.toFixed(4) ?? 'N/A'}`,
      );

      fontResults.push({
        font: font.family,
        tr39: tr39Score,
        nfkc: nfkcScore,
        sourceRenderStatus: renderStatus,
        sourceFallbackFont: fallbackFont,
      });

      // Save triptych if requested
      if (saveRenders) {
        await saveTriptych(
          vec,
          font,
          sourceNorm,
          tr39Norm,
          nfkcNorm,
        );
      }
    }

    const summary = computeVectorSummary(fontResults);
    console.log(
      `    verdict: ${summary.verdict} (${summary.nativeFontCount} native, ${summary.fallbackFontCount} fallback, ${summary.validFontCount - summary.nativeFontCount - summary.fallbackFontCount} notdef)\n`,
    );

    vectorResults.push({
      codePoint: vec.codePoint,
      char: vec.char,
      tr39Target: vec.tr39,
      nfkcTarget: vec.nfkc,
      fonts: fontResults,
      summary,
    });
  }

  // 5. Global summary
  console.log('[4/4] Computing global summary...\n');
  const globalSummary = computeGlobalSummary(vectorResults);

  const output: OutputData = {
    meta: {
      generatedAt: new Date().toISOString(),
      fontsAvailable: availableFonts.length,
      fontsTotal: fonts.length,
      vectorCount: vectors.length,
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
    },
    vectors: vectorResults,
    globalSummary,
  };

  // 6. Write JSON
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, replacer, 2));
  console.log(`Output written to: ${OUTPUT_JSON}\n`);

  // 7. Print summary
  printSummary(output);
}

function computeVectorSummary(fontResults: FontResult[]): VectorSummary {
  const validResults = fontResults.filter(
    r => r.sourceRenderStatus !== 'notdef' && (r.tr39 !== null || r.nfkc !== null),
  );
  const nativeCount = fontResults.filter(r => r.sourceRenderStatus === 'native').length;
  const fallbackCount = fontResults.filter(r => r.sourceRenderStatus === 'fallback').length;

  if (validResults.length === 0) {
    return {
      tr39MeanSsim: null,
      nfkcMeanSsim: null,
      tr39MeanPHash: null,
      nfkcMeanPHash: null,
      validFontCount: 0,
      nativeFontCount: 0,
      fallbackFontCount: 0,
      verdict: 'insufficient_data',
    };
  }

  const tr39Ssims = validResults.map(r => r.tr39?.ssim).filter((v): v is number => v !== undefined && v !== null);
  const nfkcSsims = validResults.map(r => r.nfkc?.ssim).filter((v): v is number => v !== undefined && v !== null);
  const tr39PHashs = validResults.map(r => r.tr39?.pHash).filter((v): v is number => v !== undefined && v !== null);
  const nfkcPHashs = validResults.map(r => r.nfkc?.pHash).filter((v): v is number => v !== undefined && v !== null);

  const tr39MeanSsim = tr39Ssims.length > 0 ? mean(tr39Ssims) : null;
  const nfkcMeanSsim = nfkcSsims.length > 0 ? mean(nfkcSsims) : null;
  const tr39MeanPHash = tr39PHashs.length > 0 ? mean(tr39PHashs) : null;
  const nfkcMeanPHash = nfkcPHashs.length > 0 ? mean(nfkcPHashs) : null;

  let verdict: VectorSummary['verdict'];
  if (tr39MeanSsim === null || nfkcMeanSsim === null) {
    verdict = 'insufficient_data';
  } else if (Math.abs(tr39MeanSsim - nfkcMeanSsim) < 0.05) {
    verdict = 'equal';
  } else if (tr39MeanSsim > nfkcMeanSsim) {
    verdict = 'tr39';
  } else {
    verdict = 'nfkc';
  }

  return {
    tr39MeanSsim,
    nfkcMeanSsim,
    tr39MeanPHash,
    nfkcMeanPHash,
    validFontCount: validResults.length,
    nativeFontCount: nativeCount,
    fallbackFontCount: fallbackCount,
    verdict,
  };
}

function computeGlobalSummary(vectors: VectorResult[]): GlobalSummary {
  let tr39Wins = 0;
  let nfkcWins = 0;
  let ties = 0;
  let insufficientData = 0;

  for (const v of vectors) {
    switch (v.summary.verdict) {
      case 'tr39': tr39Wins++; break;
      case 'nfkc': nfkcWins++; break;
      case 'equal': ties++; break;
      case 'insufficient_data': insufficientData++; break;
    }
  }

  return { tr39Wins, nfkcWins, ties, insufficientData, totalVectors: vectors.length };
}

function printSummary(output: OutputData) {
  const { globalSummary: gs, meta } = output;
  console.log('=== SUMMARY ===');
  console.log(`Platform: ${meta.platform}`);
  console.log(`Vectors: ${meta.vectorCount}`);
  console.log(`Fonts available: ${meta.fontsAvailable}/${meta.fontsTotal}`);
  console.log('');
  console.log(`TR39 wins:          ${gs.tr39Wins}`);
  console.log(`NFKC wins:          ${gs.nfkcWins}`);
  console.log(`Ties (delta < 0.05): ${gs.ties}`);
  console.log(`Insufficient data:  ${gs.insufficientData}`);
  console.log('');

  // Per-vector breakdown
  console.log('Per-vector verdicts:');
  for (const v of output.vectors) {
    const s = v.summary;
    const ssimStr = s.tr39MeanSsim !== null && s.nfkcMeanSsim !== null
      ? `TR39=${s.tr39MeanSsim.toFixed(4)} NFKC=${s.nfkcMeanSsim.toFixed(4)}`
      : 'N/A';
    const fontBreakdown = `${s.nativeFontCount}n/${s.fallbackFontCount}fb`;
    console.log(`  ${v.codePoint} (${v.char}): ${s.verdict.padEnd(18)} [${ssimStr}] (${fontBreakdown})`);
  }
}

/** Save a triptych PNG strip: source | TR39 target | NFKC target */
async function saveTriptych(
  vec: ComposabilityVector,
  font: FontEntry,
  source: NormalisedResult,
  tr39: NormalisedResult | null,
  nfkc: NormalisedResult | null,
) {
  const cellSize = 48;
  const labelHeight = 16;
  const totalWidth = cellSize * 3;
  const totalHeight = cellSize + labelHeight;

  // Create composite from the three cells
  const composites: sharp.OverlayOptions[] = [];

  // Source cell
  composites.push({
    input: source.pngBuffer,
    left: 0,
    top: labelHeight,
  });

  // TR39 cell
  if (tr39) {
    composites.push({
      input: tr39.pngBuffer,
      left: cellSize,
      top: labelHeight,
    });
  }

  // NFKC cell
  if (nfkc) {
    composites.push({
      input: nfkc.pngBuffer,
      left: cellSize * 2,
      top: labelHeight,
    });
  }

  // Create the triptych with white background
  const triptych = await sharp({
    create: {
      width: totalWidth,
      height: totalHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  const safeFontName = font.family.replace(/\s+/g, '-');
  const filename = `${vec.codePoint.replace('+', '')}_{${safeFontName}}.png`;
  const outputPath = path.join(RENDERS_DIR, filename);
  fs.writeFileSync(outputPath, triptych);
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** JSON replacer to serialise BigInt values as strings */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
