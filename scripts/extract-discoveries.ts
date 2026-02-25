/**
 * extract-discoveries.ts
 *
 * Extracts high-scoring pairs from both Milestone 1b (TR39 confusables) and
 * Milestone 2 (novel candidates) into compact JSON files suitable for
 * committing to the repository.
 *
 * Output:
 *   data/output/confusable-discoveries.json  -- TR39 pairs with meanSsim >= 0.7 or any font SSIM = 1.0
 *   data/output/candidate-discoveries.json   -- novel pairs with meanSsim >= 0.7
 *
 * Usage:
 *   npx tsx scripts/extract-discoveries.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data/output');

const M1B_SCORES = path.join(OUTPUT_DIR, 'confusable-scores.json');
const M2_SCORES = path.join(OUTPUT_DIR, 'candidate-scores.json');
const M1B_OUTPUT = path.join(OUTPUT_DIR, 'confusable-discoveries.json');
const M2_OUTPUT = path.join(OUTPUT_DIR, 'candidate-discoveries.json');

const SSIM_THRESHOLD = 0.7;

async function extractM1b() {
  console.log('[1/2] Extracting TR39 confusable discoveries...');

  if (!fs.existsSync(M1B_SCORES)) {
    console.log('  SKIP: confusable-scores.json not found');
    return;
  }

  const data = JSON.parse(fs.readFileSync(M1B_SCORES, 'utf-8'));
  const pairs = data.pairs as any[];

  // High mean SSIM or pixel-identical in at least one font
  const high = pairs.filter(p => {
    const meanSsim = p.summary?.meanSsim;
    if (meanSsim !== null && meanSsim >= SSIM_THRESHOLD) return true;
    // Check for any font with SSIM = 1.0 (pixel-identical)
    const fonts = p.fonts as any[];
    return fonts?.some((f: any) => f.ssim === 1);
  });

  high.sort((a: any, b: any) => (b.summary.meanSsim ?? -1) - (a.summary.meanSsim ?? -1));

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      pairCount: high.length,
      totalPairsScored: pairs.length,
      ssimThreshold: SSIM_THRESHOLD,
      includesPixelIdentical: true,
      note: 'TR39 confusable pairs scoring >= 0.7 mean SSIM or pixel-identical (1.0) in at least one font. Scored across macOS system fonts.',
      licence: 'CC-BY-4.0',
      attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
    },
    pairs: high,
  };

  fs.writeFileSync(M1B_OUTPUT, JSON.stringify(output, null, 2));
  const sizeMB = (fs.statSync(M1B_OUTPUT).size / 1024 / 1024).toFixed(1);
  console.log(`  ${high.length} pairs (${pairs.length} total), written to ${M1B_OUTPUT} (${sizeMB} MB)`);
}

async function extractM2() {
  console.log('[2/2] Extracting novel candidate discoveries...');

  if (!fs.existsSync(M2_SCORES)) {
    console.log('  SKIP: candidate-scores.json not found');
    return;
  }

  // candidate-scores.json is too large for readFileSync (572 MB).
  // Stream-parse line by line. Each pair is written as one JSON object per line.
  const rl = createInterface({
    input: createReadStream(M2_SCORES, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const highPairs: any[] = [];
  let totalParsed = 0;

  for await (const line of rl) {
    const trimmed = line.trim();

    // Pair lines start with { and contain "source"
    if (trimmed.startsWith('{') && trimmed.includes('"source"')) {
      const json = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
      try {
        const pair = JSON.parse(json);
        totalParsed++;
        if (pair.summary?.meanSsim !== null && pair.summary?.meanSsim >= SSIM_THRESHOLD) {
          highPairs.push(pair);
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  highPairs.sort((a, b) => (b.summary.meanSsim ?? -1) - (a.summary.meanSsim ?? -1));

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      pairCount: highPairs.length,
      totalCandidatesScored: totalParsed,
      ssimThreshold: SSIM_THRESHOLD,
      note: 'Novel confusable pairs not in Unicode TR39 confusables.txt, discovered by rendering identifier-safe Unicode characters and measuring visual similarity (SSIM) against Latin a-z/0-9 across macOS system fonts.',
      licence: 'CC-BY-4.0',
      attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
    },
    pairs: highPairs,
  };

  fs.writeFileSync(M2_OUTPUT, JSON.stringify(output, null, 2));
  const sizeMB = (fs.statSync(M2_OUTPUT).size / 1024 / 1024).toFixed(1);
  console.log(`  ${highPairs.length} pairs (${totalParsed} total), written to ${M2_OUTPUT} (${sizeMB} MB)`);
}

async function main() {
  console.log('=== confusable-vision: extract discoveries ===\n');
  await extractM1b();
  console.log('');
  await extractM2();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
