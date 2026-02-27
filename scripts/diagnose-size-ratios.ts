/**
 * diagnose-size-ratios.ts -- Check natural ink size ratios for discoveries
 *
 * Re-renders high-scoring TR39 (1,341 pairs), M2 (793 pairs), and M2b (69
 * pairs) discoveries to measure raw ink width/height from the original 64x64
 * renders (before normaliseImage). Reports pairs where the source and target
 * have extreme size differences, which would make the confusable visually
 * obvious in running text even if the normalised shapes match.
 *
 * Usage:
 *   npx tsx scripts/diagnose-size-ratios.ts
 *   npx tsx scripts/diagnose-size-ratios.ts --threshold 1.5   # custom ratio threshold
 *   npx tsx scripts/diagnose-size-ratios.ts --json             # JSON output
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { initFonts, discoverFontForCodepoint } from '../src/fonts.js';
import { renderCharacter } from '../src/renderer.js';
import { readJsonGz } from '../src/gz-json.js';
import type { ConfusablePairResult, PairFontResult } from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');

const TR39_SCORES = path.join(ROOT, 'data/output/confusable-scores.json.gz');
const M2_DISCOVERIES = path.join(ROOT, 'data/output/candidate-discoveries.json');
const M2B_DISCOVERIES = path.join(ROOT, 'data/output/m2b-discoveries.json');

const RATIO_THRESHOLD = parseFloat(
  process.argv.find((a, i) => process.argv[i - 1] === '--threshold') ?? '2.0'
);
const JSON_OUTPUT = process.argv.includes('--json');

/** Ink bounding box from greyscale pixels */
interface InkBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/** Find ink bounds in a greyscale buffer */
function findInkBounds(
  pixels: Buffer,
  width: number,
  height: number,
  threshold = 10,
): InkBounds | null {
  const cutoff = 255 - threshold;
  let top = height, bottom = 0, left = width, right = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x]! < cutoff) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (top > bottom) return null;
  return {
    top, bottom, left, right,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

/** Render a character and return its raw ink bounds from the 64x64 canvas */
async function getRawInkBounds(
  char: string,
  font: string,
): Promise<InkBounds | null> {
  let result = renderCharacter(char, font);
  // If the font wasn't found (e.g. NotoSerif* not in initFonts' NotoSans scan),
  // try dynamic discovery which registers any system font covering this codepoint.
  if (!result) {
    const cp = char.codePointAt(0);
    if (cp !== undefined) {
      discoverFontForCodepoint(cp);
      result = renderCharacter(char, font);
    }
  }
  if (!result) return null;

  // Convert to greyscale and get raw pixels
  const { data, info } = await sharp(result.pngBuffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return findInkBounds(Buffer.from(data), info.width, info.height);
}

interface PairDiagnostic {
  milestone: 'TR39' | 'M2' | 'M2b';
  source: string;
  sourceCodepoint: string;
  target: string;
  font: string;
  srcInkW: number;
  srcInkH: number;
  tgtInkW: number;
  tgtInkH: number;
  widthRatio: number;
  heightRatio: number;
  ssim: number;
  flagged: boolean;
}

async function main() {
  console.log('=== confusable-vision: diagnose-size-ratios ===\n');
  console.log(`Width ratio threshold: ${RATIO_THRESHOLD}x\n`);

  // Register all system fonts with node-canvas (required for renderCharacter)
  console.log('[0] Initialising fonts...');
  initFonts();

  // Load TR39 scores (all pairs, filter to those with valid SSIM)
  interface ScoresFile { pairs: ConfusablePairResult[] }
  const tr39All: ScoresFile = readJsonGz<ScoresFile>(TR39_SCORES);
  const tr39Data = {
    pairs: tr39All.pairs.filter(p => p.summary.meanSsim !== null),
  };

  // Load discoveries
  const m2Data: { pairs: ConfusablePairResult[] } = JSON.parse(
    fs.readFileSync(M2_DISCOVERIES, 'utf-8')
  );
  const m2bData: { pairs: ConfusablePairResult[] } = JSON.parse(
    fs.readFileSync(M2B_DISCOVERIES, 'utf-8')
  );

  console.log(`TR39 pairs: ${tr39Data.pairs.length} (with valid SSIM)`);
  console.log(`M2 discoveries: ${m2Data.pairs.length} pairs`);
  console.log(`M2b discoveries: ${m2bData.pairs.length} pairs`);

  // Collect unique (char, font) pairs to render
  const renderJobs = new Map<string, { char: string; font: string }>();

  function addJob(char: string, font: string) {
    const key = `${char}:${font}`;
    if (!renderJobs.has(key)) {
      renderJobs.set(key, { char, font });
    }
  }

  // For each discovery pair, we need to render source and target in each font
  // that had a valid SSIM score. Use the best-scoring font per pair.
  function collectJobs(
    pairs: ConfusablePairResult[],
  ): { pair: ConfusablePairResult; bestFont: PairFontResult }[] {
    const result: { pair: ConfusablePairResult; bestFont: PairFontResult }[] = [];
    for (const pair of pairs) {
      // Find the best-scoring font (highest SSIM, not skipped)
      let bestFont: PairFontResult | null = null;
      for (const f of pair.fonts) {
        if (f.ssim === null || f.ssimSkipped) continue;
        if (!bestFont || f.ssim > bestFont.ssim!) {
          bestFont = f;
        }
      }
      if (!bestFont) continue;

      addJob(pair.source, bestFont.sourceFont);
      addJob(pair.target, bestFont.targetFont);
      result.push({ pair, bestFont });
    }
    return result;
  }

  const tr39Jobs = collectJobs(tr39Data.pairs);
  const m2Jobs = collectJobs(m2Data.pairs);
  const m2bJobs = collectJobs(m2bData.pairs);

  console.log(`\nUnique render jobs: ${renderJobs.size}`);
  console.log('Rendering...\n');

  // Render all unique (char, font) pairs and cache ink bounds
  const boundsCache = new Map<string, InkBounds | null>();
  let rendered = 0;
  let failed = 0;

  for (const [key, { char, font }] of renderJobs) {
    const bounds = await getRawInkBounds(char, font);
    boundsCache.set(key, bounds);
    rendered++;
    if (!bounds) failed++;

    if (rendered % 100 === 0) {
      process.stdout.write(`  ${rendered}/${renderJobs.size} rendered\r`);
    }
  }
  console.log(`  ${rendered} rendered, ${failed} failed (no glyph)\n`);

  // Diagnose each pair
  const diagnostics: PairDiagnostic[] = [];

  function diagnose(
    milestone: 'TR39' | 'M2' | 'M2b',
    jobs: { pair: ConfusablePairResult; bestFont: PairFontResult }[],
  ) {
    for (const { pair, bestFont } of jobs) {
      const srcKey = `${pair.source}:${bestFont.sourceFont}`;
      const tgtKey = `${pair.target}:${bestFont.targetFont}`;
      const srcBounds = boundsCache.get(srcKey);
      const tgtBounds = boundsCache.get(tgtKey);

      if (!srcBounds || !tgtBounds) continue;

      const widthRatio = Math.max(srcBounds.width, tgtBounds.width) /
        Math.min(srcBounds.width, tgtBounds.width);
      const heightRatio = Math.max(srcBounds.height, tgtBounds.height) /
        Math.min(srcBounds.height, tgtBounds.height);

      diagnostics.push({
        milestone,
        source: pair.source,
        sourceCodepoint: pair.sourceCodepoint,
        target: pair.target,
        font: bestFont.sourceFont,
        srcInkW: srcBounds.width,
        srcInkH: srcBounds.height,
        tgtInkW: tgtBounds.width,
        tgtInkH: tgtBounds.height,
        widthRatio: Math.round(widthRatio * 100) / 100,
        heightRatio: Math.round(heightRatio * 100) / 100,
        ssim: bestFont.ssim!,
        flagged: widthRatio > RATIO_THRESHOLD || heightRatio > RATIO_THRESHOLD,
      });
    }
  }

  diagnose('TR39', tr39Jobs);
  diagnose('M2', m2Jobs);
  diagnose('M2b', m2bJobs);

  // Sort by width ratio descending to surface worst offenders first
  diagnostics.sort((a, b) => b.widthRatio - a.widthRatio);

  const flagged = diagnostics.filter(d => d.flagged);
  const clean = diagnostics.filter(d => !d.flagged);

  if (JSON_OUTPUT) {
    const output = {
      meta: {
        generatedAt: new Date().toISOString(),
        ratioThreshold: RATIO_THRESHOLD,
        totalPairs: diagnostics.length,
        flaggedPairs: flagged.length,
        cleanPairs: clean.length,
      },
      flagged,
      clean,
    };
    const outPath = path.join(ROOT, 'data/output/size-ratio-diagnostics.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`Written to: ${outPath}`);
    return;
  }

  // Console output
  console.log('=== RESULTS ===\n');
  console.log(`Total pairs diagnosed: ${diagnostics.length}`);
  console.log(`Flagged (ratio > ${RATIO_THRESHOLD}x): ${flagged.length}`);
  console.log(`Clean: ${clean.length}\n`);

  // Breakdown by milestone
  const tr39Flagged = flagged.filter(d => d.milestone === 'TR39');
  const m2Flagged = flagged.filter(d => d.milestone === 'M2');
  const m2bFlagged = flagged.filter(d => d.milestone === 'M2b');
  console.log(`TR39: ${tr39Jobs.length} pairs, ${tr39Flagged.length} flagged`);
  console.log(`M2: ${m2Jobs.length} pairs, ${m2Flagged.length} flagged`);
  console.log(`M2b: ${m2bJobs.length} pairs, ${m2bFlagged.length} flagged\n`);

  if (flagged.length > 0) {
    console.log(`=== FLAGGED PAIRS (ratio > ${RATIO_THRESHOLD}x) ===\n`);
    console.log(
      'Source'.padEnd(6) + ' ' +
      'Target'.padEnd(6) + ' ' +
      'CP'.padEnd(8) + ' ' +
      'Ms'.padEnd(4) + ' ' +
      'SrcW'.padEnd(5) + ' ' +
      'SrcH'.padEnd(5) + ' ' +
      'TgtW'.padEnd(5) + ' ' +
      'TgtH'.padEnd(5) + ' ' +
      'WRatio'.padEnd(7) + ' ' +
      'HRatio'.padEnd(7) + ' ' +
      'SSIM'.padEnd(7) + ' ' +
      'Font'
    );
    console.log('-'.repeat(90));

    for (const d of flagged) {
      const srcLabel = d.source.length === 1
        ? `"${d.source}"`.padEnd(6)
        : `U+${d.sourceCodepoint.replace('U+', '')}`.padEnd(6);
      console.log(
        srcLabel + ' ' +
        `"${d.target}"`.padEnd(6) + ' ' +
        d.sourceCodepoint.padEnd(8) + ' ' +
        d.milestone.padEnd(4) + ' ' +
        String(d.srcInkW).padEnd(5) + ' ' +
        String(d.srcInkH).padEnd(5) + ' ' +
        String(d.tgtInkW).padEnd(5) + ' ' +
        String(d.tgtInkH).padEnd(5) + ' ' +
        d.widthRatio.toFixed(2).padEnd(7) + ' ' +
        d.heightRatio.toFixed(2).padEnd(7) + ' ' +
        d.ssim.toFixed(4).padEnd(7) + ' ' +
        d.font
      );
    }
  }

  // Distribution summary
  console.log('\n=== WIDTH RATIO DISTRIBUTION ===\n');
  const buckets = [
    { label: '1.0 - 1.25x', min: 1.0, max: 1.25 },
    { label: '1.25 - 1.5x', min: 1.25, max: 1.5 },
    { label: '1.5 - 2.0x', min: 1.5, max: 2.0 },
    { label: '2.0 - 3.0x', min: 2.0, max: 3.0 },
    { label: '3.0x+', min: 3.0, max: Infinity },
  ];

  for (const bucket of buckets) {
    const count = diagnostics.filter(
      d => d.widthRatio >= bucket.min && d.widthRatio < bucket.max
    ).length;
    const bar = '#'.repeat(Math.ceil(count / 5));
    console.log(`  ${bucket.label.padEnd(14)} ${String(count).padEnd(5)} ${bar}`);
  }

  console.log('\n=== HEIGHT RATIO DISTRIBUTION ===\n');
  for (const bucket of buckets) {
    const count = diagnostics.filter(
      d => d.heightRatio >= bucket.min && d.heightRatio < bucket.max
    ).length;
    const bar = '#'.repeat(Math.ceil(count / 5));
    console.log(`  ${bucket.label.padEnd(14)} ${String(count).padEnd(5)} ${bar}`);
  }

  // High-SSIM flagged pairs (most dangerous false positives)
  const highSsimFlagged = flagged.filter(d => d.ssim >= 0.9);
  if (highSsimFlagged.length > 0) {
    console.log(`\n=== HIGH-SSIM FLAGGED (SSIM >= 0.9, ratio > ${RATIO_THRESHOLD}x) ===\n`);
    console.log(`These ${highSsimFlagged.length} pairs score high on shape similarity but`);
    console.log('would stick out due to size difference in running text.\n');
    for (const d of highSsimFlagged) {
      console.log(
        `  ${d.source} -> ${d.target} (${d.sourceCodepoint})  ` +
        `SSIM ${d.ssim.toFixed(4)}  ` +
        `W ${d.srcInkW}/${d.tgtInkW} (${d.widthRatio.toFixed(2)}x)  ` +
        `H ${d.srcInkH}/${d.tgtInkH} (${d.heightRatio.toFixed(2)}x)  ` +
        `[${d.milestone}]`
      );
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
