/**
 * report-stats.ts
 *
 * Loads confusable-scores.json and prints a detailed statistical report
 * for use in technical writing. Outputs clean text sections.
 *
 * Usage:
 *   npx tsx scripts/report-stats.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonGz } from '../src/gz-json.js';
import type {
  ScoreAllPairsOutput,
  ConfusablePairResult,
  PairFontResult,
} from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.resolve(__dirname, '../data/output/confusable-scores.json.gz');

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
const data: ScoreAllPairsOutput = readJsonGz<ScoreAllPairsOutput>(INPUT);
const { meta, pairs, distribution } = data;

const lines: string[] = [];
function emit(s = '') { lines.push(s); }
function emitSep() { emit('='.repeat(78)); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pct(n: number, total: number): string {
  return total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`;
}

function fmt(n: number | null, digits = 4): string {
  return n === null ? 'N/A' : n.toFixed(digits);
}

/** Escape a character for display: show the char and its codepoint */
function esc(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x20 && cp <= 0x7e) return ch;
  return `\\u{${cp.toString(16).toUpperCase()}}`;
}

function sameFontResults(pair: ConfusablePairResult): PairFontResult[] {
  return pair.fonts.filter(f => f.sourceFont === f.targetFont);
}

function crossFontResults(pair: ConfusablePairResult): PairFontResult[] {
  return pair.fonts.filter(f => f.sourceFont !== f.targetFont);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ---------------------------------------------------------------------------
// 1. Meta
// ---------------------------------------------------------------------------
emitSep();
emit('1. META');
emitSep();
emit(`Platform:            ${meta.platform}`);
emit(`Fonts available:     ${meta.fontsAvailable} / ${meta.fontsTotal}`);
emit(`Pairs scored:        ${meta.pairCount}`);
emit(`pHash threshold:     ${meta.pHashPrefilterThreshold}`);
emit(`Generated at:        ${meta.generatedAt}`);
emit();

// ---------------------------------------------------------------------------
// 2. Distribution
// ---------------------------------------------------------------------------
emitSep();
emit('2. DISTRIBUTION');
emitSep();
const total = distribution.total;
emit(`High (SSIM >= 0.7):  ${distribution.high}  (${pct(distribution.high, total)})`);
emit(`Medium (0.3-0.7):    ${distribution.medium}  (${pct(distribution.medium, total)})`);
emit(`Low (< 0.3):         ${distribution.low}  (${pct(distribution.low, total)})`);
emit(`No data:             ${distribution.noData}  (${pct(distribution.noData, total)})`);
emit(`Total:               ${total}`);
emit();

// ---------------------------------------------------------------------------
// 3. Median SSIM
// ---------------------------------------------------------------------------
emitSep();
emit('3. MEDIAN SSIM (pairs with data)');
emitSep();
const ssimValues = pairs
  .map(p => p.summary.meanSsim)
  .filter((v): v is number => v !== null);
emit(`Median mean SSIM:    ${fmt(median(ssimValues))}`);
emit(`Mean of mean SSIMs:  ${fmt(ssimValues.reduce((a, b) => a + b, 0) / ssimValues.length)}`);
emit(`Pairs with data:     ${ssimValues.length}`);
emit();

// ---------------------------------------------------------------------------
// Pair detail printer (used by sections 4, 5)
// ---------------------------------------------------------------------------
function printPairDetail(pair: ConfusablePairResult, rank: number) {
  const sf = sameFontResults(pair);
  const cf = crossFontResults(pair);
  emit(
    `  #${rank}  ${pair.sourceCodepoint}  source=${esc(pair.source)}  ` +
    `target=${esc(pair.target)}  meanSsim=${fmt(pair.summary.meanSsim)}  ` +
    `meanPHash=${fmt(pair.summary.meanPHash)}  ` +
    `same-font=${sf.length}  cross-font=${cf.length}`
  );

  // Same-font results sorted by ssim desc
  if (sf.length > 0) {
    const sorted = [...sf]
      .filter(f => f.ssim !== null)
      .sort((a, b) => (b.ssim ?? -Infinity) - (a.ssim ?? -Infinity));
    emit(`    Same-font results (${sorted.length}):`);
    for (const f of sorted) {
      emit(`      ${f.sourceFont.padEnd(35)} ssim=${fmt(f.ssim)}`);
    }
  } else {
    emit('    Same-font results: none');
  }

  // Top 10 cross-font results sorted by ssim desc
  if (cf.length > 0) {
    const sorted = [...cf]
      .filter(f => f.ssim !== null)
      .sort((a, b) => (b.ssim ?? -Infinity) - (a.ssim ?? -Infinity));
    const top10 = sorted.slice(0, 10);
    emit(`    Top 10 cross-font results (of ${sorted.length}):`);
    for (const f of top10) {
      emit(
        `      ${f.sourceFont.padEnd(30)} / ${f.targetFont.padEnd(25)} ssim=${fmt(f.ssim)}`
      );
    }
  } else {
    emit('    Cross-font results: none');
  }
  emit();
}

// ---------------------------------------------------------------------------
// 4. Top 30 pairs (highest meanSsim)
// ---------------------------------------------------------------------------
emitSep();
emit('4. TOP 30 PAIRS (highest meanSsim)');
emitSep();
const withData = pairs.filter(p => p.summary.meanSsim !== null);
const sortedDesc = [...withData].sort(
  (a, b) => (b.summary.meanSsim ?? -Infinity) - (a.summary.meanSsim ?? -Infinity)
);
for (let i = 0; i < Math.min(30, sortedDesc.length); i++) {
  printPairDetail(sortedDesc[i], i + 1);
}
emit();

// ---------------------------------------------------------------------------
// 5. Bottom 30 pairs (lowest meanSsim)
// ---------------------------------------------------------------------------
emitSep();
emit('5. BOTTOM 30 PAIRS (lowest meanSsim)');
emitSep();
const sortedAsc = [...withData].sort(
  (a, b) => (a.summary.meanSsim ?? Infinity) - (b.summary.meanSsim ?? Infinity)
);
for (let i = 0; i < Math.min(30, sortedAsc.length); i++) {
  printPairDetail(sortedAsc[i], i + 1);
}
emit();

// ---------------------------------------------------------------------------
// 6. Pixel-identical pairs (any font comparison with ssim >= 0.999)
// ---------------------------------------------------------------------------
emitSep();
emit('6. PIXEL-IDENTICAL PAIRS (any comparison with SSIM >= 0.999)');
emitSep();
let pixelIdenticalCount = 0;
for (const pair of pairs) {
  const matches = pair.fonts.filter(f => f.ssim !== null && f.ssim >= 0.999);
  if (matches.length > 0) {
    pixelIdenticalCount++;
    emit(
      `  ${pair.sourceCodepoint}  source=${esc(pair.source)}  target=${esc(pair.target)}  ` +
      `(${matches.length} comparison${matches.length > 1 ? 's' : ''})`
    );
    for (const m of matches) {
      const label =
        m.sourceFont === m.targetFont
          ? `same-font: ${m.sourceFont}`
          : `cross-font: ${m.sourceFont} / ${m.targetFont}`;
      emit(`    ${label}  ssim=${fmt(m.ssim, 6)}`);
    }
  }
}
emit();
emit(`Total pixel-identical pairs: ${pixelIdenticalCount}`);
emit();

// ---------------------------------------------------------------------------
// 7. Font coverage summary
// ---------------------------------------------------------------------------
emitSep();
emit('7. FONT COVERAGE SUMMARY (same-font data by standard font)');
emitSep();

// Collect all font names that appear in same-font comparisons
const fontStats = new Map<string, { total: number; highSsim: number }>();
for (const pair of pairs) {
  for (const f of pair.fonts) {
    if (f.sourceFont === f.targetFont && f.ssim !== null) {
      const stat = fontStats.get(f.sourceFont) ?? { total: 0, highSsim: 0 };
      stat.total++;
      if (f.ssim >= 0.7) stat.highSsim++;
      fontStats.set(f.sourceFont, stat);
    }
  }
}

const sortedFonts = [...fontStats.entries()].sort((a, b) =>
  a[0].localeCompare(b[0])
);

emit(
  `  ${'Font'.padEnd(40)} ${'Pairs w/ data'.padStart(14)} ${'SSIM >= 0.7'.padStart(12)} ${'% high'.padStart(8)}`
);
emit(`  ${'-'.repeat(40)} ${'-'.repeat(14)} ${'-'.repeat(12)} ${'-'.repeat(8)}`);
for (const [font, stat] of sortedFonts) {
  emit(
    `  ${font.padEnd(40)} ${String(stat.total).padStart(14)} ${String(stat.highSsim).padStart(12)} ${pct(stat.highSsim, stat.total).padStart(8)}`
  );
}
emit();

// ---------------------------------------------------------------------------
// 8. Same-font vs cross-font breakdown
// ---------------------------------------------------------------------------
emitSep();
emit('8. SAME-FONT vs CROSS-FONT BREAKDOWN');
emitSep();

let sameFontTotal = 0;
let sameFontSsimSum = 0;
let sameFontSsimCount = 0;
let crossFontTotal = 0;
let crossFontSsimSum = 0;
let crossFontSsimCount = 0;

for (const pair of pairs) {
  for (const f of pair.fonts) {
    if (f.sourceFont === f.targetFont) {
      sameFontTotal++;
      if (f.ssim !== null) {
        sameFontSsimSum += f.ssim;
        sameFontSsimCount++;
      }
    } else {
      crossFontTotal++;
      if (f.ssim !== null) {
        crossFontSsimSum += f.ssim;
        crossFontSsimCount++;
      }
    }
  }
}

emit(`Same-font comparisons:     ${sameFontTotal}`);
emit(`  With SSIM data:          ${sameFontSsimCount}`);
emit(`  Mean SSIM:               ${fmt(sameFontSsimCount > 0 ? sameFontSsimSum / sameFontSsimCount : null)}`);
emit();
emit(`Cross-font comparisons:    ${crossFontTotal}`);
emit(`  With SSIM data:          ${crossFontSsimCount}`);
emit(`  Mean SSIM:               ${fmt(crossFontSsimCount > 0 ? crossFontSsimSum / crossFontSsimCount : null)}`);
emit();
emit(`Total comparisons:         ${sameFontTotal + crossFontTotal}`);
emit();

// ---------------------------------------------------------------------------
// 9. Per-script breakdown
// ---------------------------------------------------------------------------
emitSep();
emit('9. PER-SCRIPT BREAKDOWN');
emitSep();

type ScriptGroup = {
  name: string;
  ranges: [number, number][];
};

const scriptGroups: ScriptGroup[] = [
  {
    name: 'Latin Extended',
    ranges: [[0x0100, 0x024F], [0x1D00, 0x1DBF], [0xA720, 0xA7FF], [0xAB30, 0xAB6F]],
  },
  {
    name: 'Cyrillic',
    ranges: [[0x0400, 0x052F]],
  },
  {
    name: 'Greek',
    ranges: [[0x0370, 0x03FF], [0x1F00, 0x1FFF]],
  },
  {
    name: 'Cherokee',
    ranges: [[0x13A0, 0x13FF], [0xAB70, 0xABBF]],
  },
  {
    name: 'Arabic',
    ranges: [[0x0600, 0x06FF], [0xFB50, 0xFDFF], [0xFE70, 0xFEFF]],
  },
  {
    name: 'Hebrew',
    ranges: [[0x0590, 0x05FF]],
  },
  {
    name: 'Mathematical Alphanumeric Symbols',
    ranges: [[0x1D400, 0x1D7FF]],
  },
  {
    name: 'Indic',
    ranges: [[0x0900, 0x0D7F]],
  },
];

function classifyCodepoint(cp: number): string {
  for (const group of scriptGroups) {
    for (const [lo, hi] of group.ranges) {
      if (cp >= lo && cp <= hi) return group.name;
    }
  }
  if (cp > 0xFFFF) return 'Other SMP';
  return 'Other BMP';
}

const scriptStats = new Map<string, { count: number; ssimSum: number; ssimCount: number }>();

for (const pair of pairs) {
  // Parse codepoint from sourceCodepoint like "U+007C"
  const cpStr = pair.sourceCodepoint.replace(/^U\+/, '');
  const cp = parseInt(cpStr, 16);
  const group = classifyCodepoint(cp);

  const stat = scriptStats.get(group) ?? { count: 0, ssimSum: 0, ssimCount: 0 };
  stat.count++;
  if (pair.summary.meanSsim !== null) {
    stat.ssimSum += pair.summary.meanSsim;
    stat.ssimCount++;
  }
  scriptStats.set(group, stat);
}

// Sort by group name
const sortedGroups = [...scriptStats.entries()].sort((a, b) =>
  a[0].localeCompare(b[0])
);

emit(
  `  ${'Script/Block'.padEnd(45)} ${'Count'.padStart(6)} ${'w/ data'.padStart(8)} ${'Mean SSIM'.padStart(10)}`
);
emit(`  ${'-'.repeat(45)} ${'-'.repeat(6)} ${'-'.repeat(8)} ${'-'.repeat(10)}`);
for (const [group, stat] of sortedGroups) {
  const meanSsim = stat.ssimCount > 0 ? stat.ssimSum / stat.ssimCount : null;
  emit(
    `  ${group.padEnd(45)} ${String(stat.count).padStart(6)} ${String(stat.ssimCount).padStart(8)} ${fmt(meanSsim).padStart(10)}`
  );
}
emit();

// ---------------------------------------------------------------------------
// 10. Negative SSIM
// ---------------------------------------------------------------------------
emitSep();
emit('10. NEGATIVE SSIM');
emitSep();

const negativePairs = withData
  .filter(p => p.summary.meanSsim! < 0)
  .sort((a, b) => a.summary.meanSsim! - b.summary.meanSsim!);

emit(`Pairs with negative mean SSIM: ${negativePairs.length}`);
emit();

if (negativePairs.length > 0) {
  emit('10 most negative:');
  for (let i = 0; i < Math.min(10, negativePairs.length); i++) {
    const p = negativePairs[i];
    emit(
      `  ${p.sourceCodepoint}  source=${esc(p.source)}  target=${esc(p.target)}  ` +
      `meanSsim=${fmt(p.summary.meanSsim, 6)}  validFonts=${p.summary.validFontCount}`
    );
  }
}
emit();

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const output = lines.join('\n');
process.stdout.write(output + '\n');
