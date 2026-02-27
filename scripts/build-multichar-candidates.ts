/**
 * build-multichar-candidates.ts -- Milestone 4, Step 1
 *
 * Generates all 3,844 two-character combinations from (a-z + A-Z + 0-9).
 * These are compared against single-char targets to find multi-character
 * confusables like "rn" vs "m", "cl" vs "d", "vv" vs "w", "Il" vs "l",
 * "0O" vs "O", "l1" vs "l".
 *
 * Output: data/output/multichar-candidates.json
 *
 * Usage:
 *   npx tsx scripts/build-multichar-candidates.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MulticharCandidate } from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data/output');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'multichar-candidates.json');

/** Build the 62-char alphabet: a-z, A-Z, 0-9 */
function buildAlphabet(): string[] {
  const chars: string[] = [];
  for (let cp = 0x61; cp <= 0x7A; cp++) chars.push(String.fromCharCode(cp)); // a-z
  for (let cp = 0x41; cp <= 0x5A; cp++) chars.push(String.fromCharCode(cp)); // A-Z
  for (let cp = 0x30; cp <= 0x39; cp++) chars.push(String.fromCharCode(cp)); // 0-9
  return chars;
}

function main() {
  console.log('=== confusable-vision: build-multichar-candidates (Milestone 4) ===\n');

  const alphabet = buildAlphabet();
  const candidates: MulticharCandidate[] = [];

  // Generate all 62x62 = 3,844 two-char combinations
  for (const c1 of alphabet) {
    for (const c2 of alphabet) {
      const sequence = c1 + c2;
      candidates.push({
        sequence,
        chars: [c1, c2],
        length: 2,
      });
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(candidates, null, 2));

  console.log(`  Generated ${candidates.length} two-character combinations`);
  console.log(`  Alphabet: ${alphabet.length} chars (a-z + A-Z + 0-9)`);
  console.log(`  Written to ${OUTPUT_PATH}`);

  // Show some key additions
  const examples = ['rn', 'cl', 'vv', 'Il', 'I1', 'lI', '0O', 'O0', 'l1', 'Cl', 'VV'];
  const found = examples.filter(e => candidates.some(c => c.sequence === e));
  console.log(`  Key pairs included: ${found.join(', ')}`);
}

main();
