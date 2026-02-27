/**
 * extract-multichar.ts -- Milestone 4
 *
 * Extracts high-scoring multi-character confusable pairs (meanSsim >= 0.7)
 * from multichar-scores.json.
 *
 * Output:
 *   data/output/multichar-discoveries.json
 *
 * Candidate space: (a-z + A-Z + 0-9) pairs = 3,844 sequences vs 62 targets.
 * Expected discoveries: "rn"/"m", "cl"/"d", "vv"/"w", "Il"/"l", possibly others.
 *
 * Usage:
 *   npx tsx scripts/extract-multichar.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { createGzLineReader } from '../src/gz-json.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data/output');

const SCORES_PATH = path.join(OUTPUT_DIR, 'multichar-scores.json.gz');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'multichar-discoveries.json');

const SSIM_THRESHOLD = 0.7;

async function main() {
  console.log('=== confusable-vision: extract-multichar (Milestone 4) ===\n');

  if (!fs.existsSync(SCORES_PATH)) {
    console.error(`ERROR: ${SCORES_PATH} not found. Run score-multichar.ts first.`);
    process.exit(1);
  }

  // Stream line-by-line through gunzip
  console.log('[1/2] Streaming multichar scores...');
  const rl = createGzLineReader(SCORES_PATH);
  let inPairs = false;
  const high: any[] = [];
  let totalPairs = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '"pairs": [') { inPairs = true; continue; }
    if (!inPairs) continue;
    if (trimmed === ']' || trimmed === ']}') break;
    try {
      const clean = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
      const pair = JSON.parse(clean);
      totalPairs++;
      if (pair.summary?.meanSsim !== null && pair.summary?.meanSsim >= SSIM_THRESHOLD) {
        high.push(pair);
      }
    } catch { /* skip malformed lines */ }
  }

  console.log(`  ${totalPairs} total scored pairs (streamed)\n`);

  console.log('[2/2] Extracting discoveries...');

  high.sort((a: any, b: any) => (b.summary.meanSsim ?? -1) - (a.summary.meanSsim ?? -1));

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      pairCount: high.length,
      totalPairsScored: totalPairs,
      ssimThreshold: SSIM_THRESHOLD,
      note: 'Multi-character confusable pairs where two-char sequences from (a-z + A-Z + 0-9) visually resemble a single character from the same set. Scored across macOS system fonts (same-font comparisons only).',
      licence: 'CC-BY-4.0',
      attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
    },
    pairs: high,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  const sizeKB = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1);
  console.log(`  ${high.length} discoveries (from ${totalPairs} scored), written to ${OUTPUT_PATH} (${sizeKB} KB)\n`);

  // Print discoveries
  console.log('=== DISCOVERIES ===\n');
  for (const p of high) {
    const s = p.summary;
    const scored = p.fonts.filter((f: any) => f.ssim !== null);
    const topFonts = [...scored]
      .sort((a: any, b: any) => (b.ssim ?? 0) - (a.ssim ?? 0))
      .slice(0, 5)
      .map((f: any) => `${f.sourceFont}=${f.ssim.toFixed(3)}`);
    console.log(
      `  "${p.source}" -> "${p.target}"  SSIM=${s.meanSsim.toFixed(4)}  (${scored.length} fonts)  top: ${topFonts.join('  ')}`,
    );
  }

  if (high.length === 0) {
    console.log('  No pairs above threshold.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
