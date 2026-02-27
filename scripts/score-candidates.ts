/**
 * score-candidates.ts -- Milestone 2
 *
 * Scores candidate characters (not in confusables.txt) against all 36 Latin
 * targets (a-z, 0-9).
 *
 * Same-font comparisons use the same pHash prefilter as M1b (skip SSIM if
 * pHash similarity < 0.3). Cross-font comparisons use a top-1-by-pHash
 * optimisation: instead of comparing each non-standard source render against
 * all 74 standard font target renders (6.4M SSIM calls), we find the single
 * best target render by pHash and compute SSIM for just that one.
 *
 * Reuses Latin target renders from the Milestone 1b render index to avoid
 * re-rendering targets. Candidate source renders come from the candidate index.
 *
 * Prerequisite:
 *   npx tsx scripts/build-index.ts              # Milestone 1b targets
 *   npx tsx scripts/build-candidates.ts         # Candidate character set
 *   npx tsx scripts/build-index.ts --candidates # Candidate renders
 *
 * Usage:
 *   npx tsx scripts/score-candidates.ts
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

// Candidate index (Milestone 2 sources)
const CANDIDATE_INDEX_DIR = path.join(ROOT, 'data/output/candidate-index');
const CANDIDATE_INDEX_JSON = path.join(CANDIDATE_INDEX_DIR, 'index.json');
const CANDIDATE_RENDERS_DIR = path.join(CANDIDATE_INDEX_DIR, 'renders');

// Milestone 1b index (reuse target renders)
const M1B_INDEX_DIR = path.join(ROOT, 'data/output/render-index');
const M1B_INDEX_JSON = path.join(M1B_INDEX_DIR, 'index.json');
const M1B_RENDERS_DIR = path.join(M1B_INDEX_DIR, 'renders');

const OUTPUT_DIR = path.join(ROOT, 'data/output');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'candidate-scores.json.gz');

// Looser threshold than Milestone 1b (0.2) because we're scanning blind
const PHASH_PREFILTER_THRESHOLD = 0.3;

interface DecodedRender {
  entry: IndexRenderEntry;
  norm: NormalisedResult;
  pHash: bigint;
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
  console.log('=== confusable-vision: score-candidates (Milestone 2) ===\n');

  // 1. Load candidate index (sources)
  console.log('[1/4] Loading candidate render index...');
  if (!fs.existsSync(CANDIDATE_INDEX_JSON)) {
    console.error(`ERROR: ${CANDIDATE_INDEX_JSON} not found. Run build-index.ts --candidates first.`);
    process.exit(1);
  }
  const candidateIndex: RenderIndex = JSON.parse(fs.readFileSync(CANDIDATE_INDEX_JSON, 'utf-8'));
  const sourceChars = Object.keys(candidateIndex.sources);
  const sourcesWithRenders = sourceChars.filter(c => candidateIndex.sources[c]!.length > 0);
  console.log(`  ${candidateIndex.meta.sourceCharCount} candidate chars, ${sourcesWithRenders.length} with renders`);

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
  //
  // We decode everything upfront because the scoring loop needs random access
  // to source and target renders. This costs ~90s and ~200MB but avoids
  // repeated disk I/O during scoring.
  console.log('[3/4] Decoding all renders...');
  const decodeStart = Date.now();

  const sourceCache = new Map<string, DecodedRender[]>();
  let sourceDecoded = 0;
  let srcIdx = 0;
  for (const char of sourcesWithRenders) {
    const entries = candidateIndex.sources[char]!;
    const decoded: DecodedRender[] = [];
    for (const entry of entries) {
      const norm = await decodePng(path.join(CANDIDATE_RENDERS_DIR, entry.png));
      const pHash = BigInt('0x' + entry.pHash);
      decoded.push({ entry, norm, pHash });
      sourceDecoded++;
    }
    sourceCache.set(char, decoded);
    srcIdx++;

    if (srcIdx % 500 === 0) {
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

  // 4. Score all source-target pairs
  //
  // Strategy (same as M1b but with cross-font optimisation for scale):
  //
  //   Same-font: source and target both in the same standard font.
  //     One SSIM per shared font. Capped at 74 per source char.
  //
  //   Cross-font: source in non-standard font, target in a standard font.
  //     Instead of comparing against all 74 standard font renders (which
  //     would be ~6.4M SSIM calls), we find the single best target render
  //     by pHash and compute SSIM for just that one. This captures the
  //     highest-risk pairing without exhaustive search.
  //
  // pHash prefilter: for same-font comparisons, skip SSIM if pHash < 0.3.
  // Cross-font already uses top-1-by-pHash, so SSIM is always computed.
  console.log('[4/4] Scoring source-target pairs...');
  const scoreStart = Date.now();

  const results: ConfusablePairResult[] = [];
  let ssimComputed = 0;
  let ssimSkipped = 0;
  let sameFontTotal = 0;
  let crossFontTotal = 0;
  let pairsWithData = 0;

  for (let i = 0; i < sourcesWithRenders.length; i++) {
    const srcChar = sourcesWithRenders[i]!;
    const sources = sourceCache.get(srcChar)!;

    if (i > 0 && i % 200 === 0) {
      const elapsed = (Date.now() - scoreStart) / 1000;
      const rate = i / elapsed;
      const eta = Math.round((sourcesWithRenders.length - i) / rate);
      const cp = srcChar.codePointAt(0)!;
      const hex = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
      console.log(`  [${i}/${sourcesWithRenders.length}] ${hex} -- ${rate.toFixed(0)} chars/s, ETA ${eta}s  (SSIM: ${ssimComputed}, skipped: ${ssimSkipped}, pairs: ${pairsWithData})`);
    }

    for (const tgtChar of targetChars) {
      const targets = targetCache.get(tgtChar)!;
      if (targets.length === 0) continue;

      const fontResults: PairFontResult[] = [];

      for (const src of sources) {
        if (standardFontSet.has(src.entry.font)) {
          // Same-font: find matching target in same font
          if (src.entry.renderStatus === 'fallback') continue;
          const tgt = targets.find(t => t.entry.font === src.entry.font);
          if (!tgt) continue;

          // pHash prefilter for same-font
          const pHashScore = pHashSimilarity(src.pHash, tgt.pHash);
          if (pHashScore < PHASH_PREFILTER_THRESHOLD) {
            ssimSkipped++;
            sameFontTotal++;
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
          ssimComputed++;
          sameFontTotal++;
        } else {
          // Cross-font: find single best target by pHash, compute SSIM for that one only.
          // This avoids the O(74) explosion per source render that made the naive approach
          // infeasible at scale (86K * 74 = 6.4M SSIM calls).
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
            ssimSkipped++;
            crossFontTotal++;
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
          ssimComputed++;
          crossFontTotal++;
        }
      }

      // Only store pairs that had at least one SSIM computed
      if (fontResults.length === 0) continue;

      const cp = srcChar.codePointAt(0)!;
      const summary = computePairSummary(fontResults);
      results.push({
        source: srcChar,
        sourceCodepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
        target: tgtChar,
        fonts: fontResults,
        summary,
      });
      pairsWithData++;
    }
  }

  const scoreElapsed = ((Date.now() - scoreStart) / 1000).toFixed(1);
  console.log(`\n  Done: ${sourcesWithRenders.length} candidates scored against ${targetChars.length} targets in ${scoreElapsed}s`);
  console.log(`  Total comparisons: ${sameFontTotal} same-font, ${crossFontTotal} cross-font`);
  console.log(`  SSIM computed: ${ssimComputed}, skipped by pHash: ${ssimSkipped}`);
  console.log(`  Pairs with SSIM data: ${pairsWithData}\n`);

  // 5. Output
  //
  // 426K+ pairs with full font arrays exceeds JSON.stringify's string limit.
  // Stream the JSON to disk in batches to avoid building one giant string.
  const distribution = computeDistribution(results);

  // Sort by mean SSIM descending for ranking
  results.sort((a, b) => (b.summary.meanSsim ?? -1) - (a.summary.meanSsim ?? -1));

  const meta = {
    generatedAt: new Date().toISOString(),
    fontsAvailable: candidateIndex.meta.fontsAvailable,
    fontsTotal: candidateIndex.meta.fontsTotal,
    pairCount: results.length,
    platform: candidateIndex.meta.platform,
    licence: 'CC-BY-4.0',
    attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
    pHashPrefilterThreshold: PHASH_PREFILTER_THRESHOLD,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Stream pairs to disk through gzip
  console.log('Writing candidate-scores.json.gz (streaming)...');
  const gz = createGzWriter(OUTPUT_JSON);
  gz.write('{\n');
  gz.write(`"meta": ${JSON.stringify(meta, null, 2)},\n`);
  gz.write(`"distribution": ${JSON.stringify(distribution, null, 2)},\n`);
  gz.write('"pairs": [\n');

  const BATCH_SIZE = 1000;
  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const batch = results.slice(i, Math.min(i + BATCH_SIZE, results.length));
    const lines = batch.map((r, j) => {
      const isLast = (i + j) === results.length - 1;
      return JSON.stringify(r) + (isLast ? '' : ',');
    });
    gz.write(lines.join('\n') + '\n');
  }

  gz.write(']\n}\n');
  await gz.close();

  const fileSizeMB = (fs.statSync(OUTPUT_JSON).size / 1024 / 1024).toFixed(1);
  console.log(`Output written to: ${OUTPUT_JSON} (${fileSizeMB} MB)\n`);

  printSummary(results, distribution);
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
  console.log(`Novel pairs with SSIM data: ${results.length}`);
  console.log('');
  console.log('SSIM distribution (novel pairs only):');
  console.log(`  High (>= 0.7):  ${d.high} (${d.total > 0 ? (100 * d.high / d.total).toFixed(1) : 0}%)`);
  console.log(`  Medium (0.3-0.7): ${d.medium} (${d.total > 0 ? (100 * d.medium / d.total).toFixed(1) : 0}%)`);
  console.log(`  Low (< 0.3):    ${d.low} (${d.total > 0 ? (100 * d.low / d.total).toFixed(1) : 0}%)`);
  console.log(`  No data:        ${d.noData} (${d.total > 0 ? (100 * d.noData / d.total).toFixed(1) : 0}%)`);
  console.log('');

  // Results are already sorted by mean SSIM descending
  const withSsim = results.filter(p => p.summary.meanSsim !== null);

  console.log('Top 50 highest-scoring novel pairs (NOT in confusables.txt):');
  for (const p of withSsim.slice(0, 50)) {
    printPairDetail(p);
  }

  // Script breakdown of high-scoring discoveries
  console.log('\nScript breakdown of high-scoring pairs (>= 0.7):');
  const scriptCounts = new Map<string, number>();
  for (const p of withSsim.filter(p => p.summary.meanSsim! >= 0.7)) {
    const cp = parseInt(p.sourceCodepoint.replace('U+', ''), 16);
    const script = deriveScriptFromCp(cp);
    scriptCounts.set(script, (scriptCounts.get(script) || 0) + 1);
  }
  for (const [script, count] of [...scriptCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${script.padEnd(40)} ${count}`);
  }
}

function printPairDetail(p: ConfusablePairResult) {
  const s = p.summary;
  const scored = p.fonts.filter(f => f.ssim !== null);
  const sameFont = scored.filter(f => f.sourceFont === f.targetFont);
  const crossFont = scored.filter(f => f.sourceFont !== f.targetFont);
  const tag = crossFont.length > 0
    ? `${sameFont.length}same/${crossFont.length}cross`
    : `${sameFont.length}same`;
  console.log(
    `  ${p.sourceCodepoint.padEnd(10)} ${JSON.stringify(p.source).padEnd(6)} -> "${p.target}"  SSIM=${s.meanSsim!.toFixed(4)}  pHash=${s.meanPHash?.toFixed(4) ?? 'N/A'}  (${s.validFontCount} fonts) [${tag}]`,
  );

  if (sameFont.length > 0) {
    const sorted = [...sameFont].sort((a, b) => (b.ssim ?? 0) - (a.ssim ?? 0));
    const details = sorted.slice(0, 8).map(f => `${f.sourceFont}=${f.ssim!.toFixed(3)}`);
    const suffix = sorted.length > 8 ? ` +${sorted.length - 8} more` : '';
    console.log(`    same-font:  ${details.join('  ')}${suffix}`);
  }
  if (crossFont.length > 0) {
    const sorted = [...crossFont].sort((a, b) => (b.ssim ?? 0) - (a.ssim ?? 0));
    const details = sorted.slice(0, 6).map(f => `${f.sourceFont}/${f.targetFont}=${f.ssim!.toFixed(3)}`);
    const suffix = sorted.length > 6 ? ` +${sorted.length - 6} more` : '';
    console.log(`    cross-font: ${details.join('  ')}${suffix}`);
  }
}

/** Simple script derivation from codepoint (for summary display) */
function deriveScriptFromCp(cp: number): string {
  if (cp >= 0x0370 && cp <= 0x03FF) return 'Greek';
  if (cp >= 0x0400 && cp <= 0x052F) return 'Cyrillic';
  if (cp >= 0x0530 && cp <= 0x058F) return 'Armenian';
  if (cp >= 0x0590 && cp <= 0x05FF) return 'Hebrew';
  if (cp >= 0x0600 && cp <= 0x06FF) return 'Arabic';
  if (cp >= 0x0900 && cp <= 0x0DFF) return 'Indic';
  if (cp >= 0x0E00 && cp <= 0x0EFF) return 'Thai/Lao';
  if (cp >= 0x10A0 && cp <= 0x10FF) return 'Georgian';
  if (cp >= 0x13A0 && cp <= 0x13FF) return 'Cherokee';
  if (cp >= 0xAB70 && cp <= 0xABBF) return 'Cherokee Supplement';
  if (cp >= 0x0100 && cp <= 0x024F) return 'Latin Extended';
  if (cp >= 0x1D00 && cp <= 0x1DBF) return 'Phonetic Extensions';
  if (cp >= 0x1E00 && cp <= 0x1EFF) return 'Latin Extended Additional';
  if (cp >= 0xA720 && cp <= 0xA7FF) return 'Latin Extended-D';
  if (cp >= 0xAB30 && cp <= 0xAB6F) return 'Latin Extended-E';
  if (cp >= 0x2C00 && cp <= 0x2C5F) return 'Glagolitic';
  if (cp >= 0x2C80 && cp <= 0x2CFF) return 'Coptic';
  if (cp >= 0x2D30 && cp <= 0x2D7F) return 'Tifinagh';
  if (cp >= 0x1D400 && cp <= 0x1D7FF) return 'Math Alphanumeric';
  if (cp >= 0xFF00 && cp <= 0xFFEF) return 'Fullwidth Forms';
  if (cp >= 0x10400 && cp <= 0x1044F) return 'Deseret';
  if (cp >= 0x10300 && cp <= 0x1034F) return 'Old Italic';
  if (cp >= 0x10330 && cp <= 0x1034F) return 'Gothic';
  return 'Other';
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
