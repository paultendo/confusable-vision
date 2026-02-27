/**
 * extract-cross-script.ts -- Milestone 5, Step 4
 *
 * Extracts high-scoring pairs (mean SSIM >= 0.7 or any font SSIM = 1.0)
 * from all 66 cross-script score files.
 *
 * Output:
 *   data/output/cross-script-discoveries.json  -- high-scoring pairs (committed, CC-BY-4.0)
 *   data/output/cross-script-summary.json      -- counts + distributions per pair
 *
 * Prerequisite:
 *   npx tsx scripts/score-cross-script.ts
 *
 * Usage:
 *   npx tsx scripts/extract-cross-script.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { createGzLineReader } from '../src/gz-json.js';
import type { CrossScriptPairResult } from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCORES_DIR = path.join(ROOT, 'data/output/cross-script-scores');
const OUTPUT_DIR = path.join(ROOT, 'data/output');
const DISCOVERIES_OUTPUT = path.join(OUTPUT_DIR, 'cross-script-discoveries.json');
const SUMMARY_OUTPUT = path.join(OUTPUT_DIR, 'cross-script-summary.json');

const SSIM_THRESHOLD = 0.7;

interface PairSummaryEntry {
  scriptA: string;
  scriptB: string;
  totalPairsScored: number;
  high: number;
  medium: number;
  low: number;
  noData: number;
  discoveryCount: number;
  topPairs: Array<{
    charA: string;
    codepointA: string;
    charB: string;
    codepointB: string;
    meanSsim: number;
  }>;
}

async function extractFromFile(
  filePath: string,
): Promise<{
  discoveries: CrossScriptPairResult[];
  totalParsed: number;
  high: number;
  medium: number;
  low: number;
  noData: number;
}> {
  const rl = createGzLineReader(filePath);
  const discoveries: CrossScriptPairResult[] = [];
  let totalParsed = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  let noData = 0;

  for await (const line of rl) {
    const trimmed = line.trim();

    // Pair lines start with { and contain "charA"
    if (trimmed.startsWith('{') && trimmed.includes('"charA"')) {
      const json = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
      try {
        const pair: CrossScriptPairResult = JSON.parse(json);
        totalParsed++;

        const meanSsim = pair.summary?.meanSsim;
        if (meanSsim === null || meanSsim === undefined) {
          noData++;
        } else if (meanSsim >= 0.7) {
          high++;
        } else if (meanSsim >= 0.3) {
          medium++;
        } else {
          low++;
        }

        // Include if high mean SSIM or pixel-identical in any font
        if (meanSsim !== null && meanSsim !== undefined && meanSsim >= SSIM_THRESHOLD) {
          discoveries.push(pair);
        } else if (pair.fonts?.some(f => f.ssim === 1)) {
          discoveries.push(pair);
          // Recount: was counted as medium or low, should be high
          if (meanSsim !== null && meanSsim !== undefined) {
            if (meanSsim >= 0.3) medium--;
            else low--;
            high++;
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  return { discoveries, totalParsed, high, medium, low, noData };
}

async function main() {
  console.log('=== confusable-vision: extract-cross-script (Milestone 5) ===\n');

  if (!fs.existsSync(SCORES_DIR)) {
    console.error(`ERROR: ${SCORES_DIR} not found. Run score-cross-script.ts first.`);
    process.exit(1);
  }

  // Find all score files
  const files = fs.readdirSync(SCORES_DIR)
    .filter(f => f.endsWith('.json.gz') && !f.includes('-progress'))
    .sort();

  if (files.length === 0) {
    console.error('No score files found.');
    process.exit(1);
  }

  console.log(`Found ${files.length} score files\n`);

  const allDiscoveries: CrossScriptPairResult[] = [];
  const pairSummaries: PairSummaryEntry[] = [];
  let totalPairsScored = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pairName = file.replace('.json.gz', '');
    const filePath = path.join(SCORES_DIR, file);

    console.log(`[${i + 1}/${files.length}] ${pairName}...`);

    const result = await extractFromFile(filePath);
    totalPairsScored += result.totalParsed;

    // Sort discoveries by meanSsim desc
    result.discoveries.sort(
      (a, b) => (b.summary.meanSsim ?? -1) - (a.summary.meanSsim ?? -1),
    );

    allDiscoveries.push(...result.discoveries);

    // Extract script names from pair name
    const [scriptA, scriptB] = pairName.split('-');

    // Top 5 for summary
    const topPairs = result.discoveries.slice(0, 5).map(d => ({
      charA: d.charA,
      codepointA: d.codepointA,
      charB: d.charB,
      codepointB: d.codepointB,
      meanSsim: d.summary.meanSsim!,
    }));

    pairSummaries.push({
      scriptA,
      scriptB,
      totalPairsScored: result.totalParsed,
      high: result.high,
      medium: result.medium,
      low: result.low,
      noData: result.noData,
      discoveryCount: result.discoveries.length,
      topPairs,
    });

    if (result.discoveries.length > 0) {
      console.log(`  ${result.discoveries.length} discoveries (${result.totalParsed} total)`);
      for (const d of result.discoveries.slice(0, 3)) {
        console.log(`    ${d.charA} (${d.codepointA}) vs ${d.charB} (${d.codepointB}) -- SSIM ${d.summary.meanSsim?.toFixed(4)}`);
      }
    } else {
      console.log(`  0 discoveries (${result.totalParsed} total)`);
    }
  }

  // Sort all discoveries by meanSsim desc
  allDiscoveries.sort(
    (a, b) => (b.summary.meanSsim ?? -1) - (a.summary.meanSsim ?? -1),
  );

  // Strip per-font detail from discoveries to keep file size manageable.
  // Keep only summary + top font.
  const compactDiscoveries = allDiscoveries.map(d => {
    const bestFont = d.fonts.reduce(
      (best, f) => (!best || (f.ssim ?? -1) > (best.ssim ?? -1) ? f : best),
      null as typeof d.fonts[0] | null,
    );
    return {
      charA: d.charA,
      codepointA: d.codepointA,
      scriptA: d.scriptA,
      charB: d.charB,
      codepointB: d.codepointB,
      scriptB: d.scriptB,
      summary: d.summary,
      bestFont: bestFont
        ? {
            sourceFont: bestFont.sourceFont,
            targetFont: bestFont.targetFont,
            ssim: bestFont.ssim,
            pHash: bestFont.pHash,
          }
        : null,
    };
  });

  // Write discoveries
  const discoveriesOutput = {
    meta: {
      generatedAt: new Date().toISOString(),
      discoveryCount: compactDiscoveries.length,
      totalPairsScored,
      scriptPairsProcessed: files.length,
      ssimThreshold: SSIM_THRESHOLD,
      includesPixelIdentical: true,
      note: 'Cross-script confusable pairs discovered by rendering characters from different Unicode scripts and measuring visual similarity (SSIM) across macOS system fonts. First systematic empirical cross-script confusable dataset.',
      licence: 'CC-BY-4.0',
      attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
    },
    pairs: compactDiscoveries,
  };

  fs.writeFileSync(DISCOVERIES_OUTPUT, JSON.stringify(discoveriesOutput, null, 2));
  const discSizeMB = (fs.statSync(DISCOVERIES_OUTPUT).size / 1024 / 1024).toFixed(1);
  console.log(`\nDiscoveries: ${compactDiscoveries.length} pairs written to ${DISCOVERIES_OUTPUT} (${discSizeMB} MB)`);

  // Write summary
  const totalDiscoveries = pairSummaries.reduce((s, p) => s + p.discoveryCount, 0);
  const summaryOutput = {
    meta: {
      generatedAt: new Date().toISOString(),
      scriptPairsProcessed: pairSummaries.length,
      totalPairsScored,
      totalDiscoveries,
      ssimThreshold: SSIM_THRESHOLD,
    },
    scriptPairs: pairSummaries,
  };

  fs.writeFileSync(SUMMARY_OUTPUT, JSON.stringify(summaryOutput, null, 2));
  console.log(`Summary: ${SUMMARY_OUTPUT}`);

  // Print overview
  console.log('\n--- Overview ---');
  console.log(`Script pairs: ${pairSummaries.length}`);
  console.log(`Total pairs scored: ${totalPairsScored.toLocaleString()}`);
  console.log(`Total discoveries: ${totalDiscoveries}`);
  console.log('');
  console.log('By script pair:');
  for (const s of pairSummaries.filter(p => p.discoveryCount > 0)) {
    console.log(`  ${s.scriptA}-${s.scriptB}: ${s.discoveryCount} (${s.high} high, ${s.medium} med, ${s.low} low)`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
