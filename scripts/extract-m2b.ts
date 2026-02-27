/**
 * extract-m2b.ts -- Milestone 2b verification report
 *
 * Produces a verification report documenting the CJK/Hangul/logographic
 * exclusion assumption. Primary output is the report, not a discovery list.
 *
 * If any pairs score >= 0.7, also outputs m2b-discoveries.json.
 *
 * Output:
 *   data/output/m2b-verification-report.json  -- always
 *   data/output/m2b-discoveries.json          -- only if high-scoring pairs exist
 *
 * Usage:
 *   npx tsx scripts/extract-m2b.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { createGzLineReader } from '../src/gz-json.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data/output');

const M2B_SCORES = path.join(OUTPUT_DIR, 'm2b-scores.json.gz');
const M2B_CANDIDATES = path.join(OUTPUT_DIR, 'm2b-candidates.json');
const REPORT_OUTPUT = path.join(OUTPUT_DIR, 'm2b-verification-report.json');
const DISCOVERIES_OUTPUT = path.join(OUTPUT_DIR, 'm2b-discoveries.json');

const SSIM_THRESHOLD = 0.7;

interface RangeBreakdown {
  range: string;
  candidateCount: number;
  scoredPairCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

async function main() {
  console.log('=== confusable-vision: extract-m2b (Milestone 2b verification) ===\n');

  // 1. Load candidates for range info
  let candidatesByRange = new Map<string, number>();
  let totalCandidates = 0;
  if (fs.existsSync(M2B_CANDIDATES)) {
    const candidates = JSON.parse(fs.readFileSync(M2B_CANDIDATES, 'utf-8'));
    totalCandidates = candidates.length;
    for (const c of candidates) {
      candidatesByRange.set(c.script, (candidatesByRange.get(c.script) || 0) + 1);
    }
    console.log(`  Loaded ${totalCandidates} M2b candidates across ${candidatesByRange.size} ranges`);
  }

  // 2. Stream-parse m2b-scores.json
  if (!fs.existsSync(M2B_SCORES)) {
    console.error(`ERROR: ${M2B_SCORES} not found. Run score-candidates-m2b.ts first.`);
    process.exit(1);
  }

  console.log('[1/2] Parsing M2b scores...');
  const rl = createGzLineReader(M2B_SCORES);

  const allPairs: any[] = [];
  let totalParsed = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"source"')) {
      const json = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
      try {
        const pair = JSON.parse(json);
        totalParsed++;
        allPairs.push(pair);
      } catch {
        // Skip unparseable lines
      }
    }
  }

  console.log(`  Parsed ${totalParsed} pairs\n`);

  // 3. Classify pairs
  let high = 0, medium = 0, low = 0, noData = 0;
  const highPairs: any[] = [];
  const topPairs: any[] = []; // Top N by SSIM regardless of threshold

  // Sort all by mean SSIM descending
  allPairs.sort((a, b) => (b.summary?.meanSsim ?? -1) - (a.summary?.meanSsim ?? -1));

  for (const pair of allPairs) {
    const s = pair.summary?.meanSsim;
    if (s === null || s === undefined) {
      noData++;
    } else if (s >= SSIM_THRESHOLD) {
      high++;
      highPairs.push(pair);
    } else if (s >= 0.3) {
      medium++;
    } else {
      low++;
    }
  }

  // Top 50 pairs by SSIM (even if below threshold, for documentation)
  const withSsim = allPairs.filter(p => p.summary?.meanSsim !== null && p.summary?.meanSsim !== undefined);
  for (const p of withSsim.slice(0, 50)) {
    topPairs.push({
      source: p.source,
      sourceCodepoint: p.sourceCodepoint,
      target: p.target,
      meanSsim: p.summary.meanSsim,
      meanPHash: p.summary.meanPHash,
      validFontCount: p.summary.validFontCount,
    });
  }

  // 4. Per-range breakdown
  console.log('[2/2] Building per-range breakdown...');
  const rangeScores = new Map<string, { scored: number; high: number; medium: number; low: number }>();

  // Derive range from codepoint
  for (const pair of allPairs) {
    const cp = parseInt(pair.sourceCodepoint.replace('U+', ''), 16);
    const range = deriveRange(cp);
    const entry = rangeScores.get(range) || { scored: 0, high: 0, medium: 0, low: 0 };
    entry.scored++;
    const s = pair.summary?.meanSsim;
    if (s !== null && s !== undefined) {
      if (s >= 0.7) entry.high++;
      else if (s >= 0.3) entry.medium++;
      else entry.low++;
    }
    rangeScores.set(range, entry);
  }

  const rangeBreakdown: RangeBreakdown[] = [];
  for (const [range, scores] of rangeScores) {
    rangeBreakdown.push({
      range,
      candidateCount: candidatesByRange.get(range) || 0,
      scoredPairCount: scores.scored,
      highCount: scores.high,
      mediumCount: scores.medium,
      lowCount: scores.low,
    });
  }
  rangeBreakdown.sort((a, b) => b.candidateCount - a.candidateCount);

  // 5. Write verification report
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      milestone: '2b',
      purpose: 'Verify that CJK/Hangul/logographic characters excluded from M2 do not produce high visual similarity to Latin a-z/0-9',
      licence: 'CC-BY-4.0',
      attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
    },
    summary: {
      totalCandidates,
      totalScoredPairs: totalParsed,
      distribution: {
        high,
        medium,
        low,
        noData,
        total: totalParsed,
      },
      verificationPassed: high === 0,
      note: high === 0
        ? 'No CJK/Hangul/logographic characters scored >= 0.7 SSIM against Latin targets. The exclusion assumption holds.'
        : `${high} pairs scored >= 0.7 SSIM. The exclusion assumption may need revision. See m2b-discoveries.json.`,
    },
    rangeBreakdown,
    topPairsBySsim: topPairs,
  };

  fs.writeFileSync(REPORT_OUTPUT, JSON.stringify(report, null, 2));
  const reportSize = (fs.statSync(REPORT_OUTPUT).size / 1024).toFixed(1);
  console.log(`\n  Verification report written to: ${REPORT_OUTPUT} (${reportSize} KB)`);

  // 6. Optionally write discoveries
  if (highPairs.length > 0) {
    highPairs.sort((a: any, b: any) => (b.summary.meanSsim ?? -1) - (a.summary.meanSsim ?? -1));

    const output = {
      meta: {
        generatedAt: new Date().toISOString(),
        pairCount: highPairs.length,
        totalCandidatesScored: totalParsed,
        ssimThreshold: SSIM_THRESHOLD,
        note: 'CJK/Hangul/logographic confusable pairs scoring >= 0.7 mean SSIM against Latin a-z/0-9. These were excluded from M2 but may warrant inclusion.',
        licence: 'CC-BY-4.0',
        attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
      },
      pairs: highPairs,
    };

    fs.writeFileSync(DISCOVERIES_OUTPUT, JSON.stringify(output, null, 2));
    const sizeMB = (fs.statSync(DISCOVERIES_OUTPUT).size / 1024 / 1024).toFixed(1);
    console.log(`  Discoveries written to: ${DISCOVERIES_OUTPUT} (${sizeMB} MB)`);
  } else {
    console.log('  No high-scoring pairs found -- no discoveries file written.');
  }

  // Print summary
  console.log('\n=== VERIFICATION SUMMARY ===');
  console.log(`  Total candidates:    ${totalCandidates}`);
  console.log(`  Total scored pairs:  ${totalParsed}`);
  console.log(`  High (>= 0.7):      ${high}`);
  console.log(`  Medium (0.3-0.7):   ${medium}`);
  console.log(`  Low (< 0.3):        ${low}`);
  console.log(`  No data:            ${noData}`);
  console.log(`  Verification:        ${high === 0 ? 'PASSED -- exclusion assumption holds' : 'ATTENTION -- high-scoring pairs found'}`);

  if (topPairs.length > 0) {
    console.log('\n  Top 20 pairs by SSIM (even if below threshold):');
    for (const p of topPairs.slice(0, 20)) {
      console.log(`    ${p.sourceCodepoint.padEnd(10)} -> "${p.target}"  SSIM=${p.meanSsim.toFixed(4)}  (${p.validFontCount} fonts)`);
    }
  }
}

/** Map codepoint to excluded range label for breakdown */
function deriveRange(cp: number): string {
  const RANGES: [number, number, string][] = [
    [0x3400, 0x4DBF, 'CJK Extension A'],
    [0x4E00, 0x9FFF, 'CJK Unified Ideographs'],
    [0xF900, 0xFAFF, 'CJK Compatibility Ideographs'],
    [0x20000, 0x2A6DF, 'CJK Extension B'],
    [0x2A700, 0x2B73F, 'CJK Extension C'],
    [0x2B740, 0x2B81F, 'CJK Extension D'],
    [0x2B820, 0x2CEA1, 'CJK Extension E'],
    [0x2CEB0, 0x2EBE0, 'CJK Extension F'],
    [0x30000, 0x3134A, 'CJK Extension G'],
    [0x31350, 0x323AF, 'CJK Extension H'],
    [0x2F800, 0x2FA1F, 'CJK Compat Ideographs Supplement'],
    [0x2EBF0, 0x2F7FF, 'CJK Extension I'],
    [0xAC00, 0xD7AF, 'Hangul Syllables'],
    [0x1100, 0x11FF, 'Hangul Jamo'],
    [0x3130, 0x318F, 'Hangul Compatibility Jamo'],
    [0xA960, 0xA97F, 'Hangul Jamo Extended-A'],
    [0xD7B0, 0xD7FF, 'Hangul Jamo Extended-B'],
    [0xA000, 0xA4CF, 'Yi Syllables + Radicals'],
    [0x17000, 0x187FF, 'Tangut + Components'],
    [0x18800, 0x18AFF, 'Tangut Components/Supplement'],
    [0x18D00, 0x18D7F, 'Tangut Supplement'],
    [0x13000, 0x1345F, 'Egyptian Hieroglyphs + Format Controls'],
    [0x12000, 0x1254F, 'Cuneiform + Numbers and Punctuation'],
    [0x14400, 0x1467F, 'Anatolian Hieroglyphs'],
    [0x1B170, 0x1B2FF, 'Nushu'],
    [0x18B00, 0x18CFF, 'Khitan Small Script'],
    [0x1AFF0, 0x1B16F, 'Katakana Extended + Kana Supplement/Extended-A/B'],
    [0x31C0, 0x31EF, 'CJK Strokes'],
    [0x2E80, 0x2FDF, 'CJK Radicals'],
    [0x3000, 0x312F, 'CJK Symbols, Hiragana, Katakana (base)'],
    [0x31F0, 0x31FF, 'Katakana Phonetic Extensions'],
    [0xFF65, 0xFFDC, 'Halfwidth Katakana/Hangul'],
  ];

  for (const [lo, hi, label] of RANGES) {
    if (cp >= lo && cp <= hi) return label;
  }
  return 'Unknown';
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
