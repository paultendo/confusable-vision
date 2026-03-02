/**
 * fetch-confusables.ts
 *
 * Download Unicode TR39 confusables.txt and parse it into a structured JSON file
 * for use by score-all-pairs.ts.
 *
 * Filtering (matches namespace-guard's logic):
 * - Single-character targets only (skip multi-char sequences)
 * - Targets must be lowercase Latin letters (a-z) or digits (0-9)
 * - Skip basic Latin sources that map to themselves
 *
 * Output: data/input/confusable-pairs.json
 *
 * Usage: npx tsx scripts/fetch-confusables.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ConfusablePair, MulticharConfusable } from '../src/types.js';

const URL = 'https://unicode.org/Public/security/latest/confusables.txt';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'data/input/confusable-pairs.json');
const MULTICHAR_OUTPUT_PATH = path.join(ROOT, 'data/input/confusable-multichar.json');

const LATIN_LOWER = new Set('abcdefghijklmnopqrstuvwxyz'.split(''));
const DIGITS = new Set('0123456789'.split(''));
const VALID_TARGETS = new Set([...LATIN_LOWER, ...DIGITS]);

// Basic Latin ranges to skip as sources (they map to themselves)
function isBasicLatin(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5A) || // A-Z
         (cp >= 0x61 && cp <= 0x7A) || // a-z
         (cp >= 0x30 && cp <= 0x39);   // 0-9
}

function codePointToHex(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

async function main() {
  console.log(`Fetching confusables.txt from ${URL}...`);
  const response = await fetch(URL);
  if (!response.ok) {
    console.error(`Failed to fetch: ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const text = await response.text();
  const lines = text.split('\n');
  console.log(`Downloaded ${text.length} bytes, ${lines.length} lines`);

  const pairs: ConfusablePair[] = [];
  const multicharPairs: MulticharConfusable[] = [];
  let skippedMultiChar = 0;
  let skippedNonLatin = 0;
  let skippedBasicLatin = 0;

  for (const line of lines) {
    // Skip comments and empty lines
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Format: SOURCE_HEX ; TARGET_HEX(S) ; TYPE # comment
    const parts = trimmed.split(';');
    if (parts.length < 2) continue;

    const sourceHexes = parts[0]!.trim().split(/\s+/);
    const targetHexes = parts[1]!.trim().split(/\s+/);

    // Parse source codepoints
    const sourceCps = sourceHexes.map(h => parseInt(h, 16));
    if (sourceCps.some(cp => isNaN(cp))) continue;

    // Parse target codepoints
    const targetCps = targetHexes.map(h => parseInt(h, 16));
    if (targetCps.some(cp => isNaN(cp))) continue;

    // Multi-character: source or target has multiple codepoints
    if (sourceHexes.length > 1 || targetHexes.length > 1) {
      const sourceStr = sourceCps.map(cp => String.fromCodePoint(cp)).join('');
      const targetStr = targetCps.map(cp => String.fromCodePoint(cp)).join('');
      multicharPairs.push({
        source: sourceStr,
        sourceCodepoints: sourceCps.map(codePointToHex),
        target: targetStr,
        targetCodepoints: targetCps.map(codePointToHex),
      });
      skippedMultiChar++;
      continue;
    }

    // Single-character source and target from here
    const sourceCp = sourceCps[0]!;

    // Skip basic Latin sources
    if (isBasicLatin(sourceCp)) {
      skippedBasicLatin++;
      continue;
    }

    const targetCp = targetCps[0]!;
    const targetChar = String.fromCodePoint(targetCp).toLowerCase();

    // Target must be a-z or 0-9
    if (!VALID_TARGETS.has(targetChar)) {
      skippedNonLatin++;
      continue;
    }

    const sourceChar = String.fromCodePoint(sourceCp);

    pairs.push({
      source: sourceChar,
      sourceCodepoint: codePointToHex(sourceCp),
      target: targetChar,
    });
  }

  // Sort by codepoint for stable output
  pairs.sort((a, b) => {
    const cpA = parseInt(a.sourceCodepoint.slice(2), 16);
    const cpB = parseInt(b.sourceCodepoint.slice(2), 16);
    return cpA - cpB;
  });

  // Sort multi-char pairs by first source codepoint
  multicharPairs.sort((a, b) => {
    const cpA = parseInt(a.sourceCodepoints[0]!.slice(2), 16);
    const cpB = parseInt(b.sourceCodepoints[0]!.slice(2), 16);
    return cpA - cpB;
  });

  // Write outputs
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(pairs, null, 2));
  fs.writeFileSync(MULTICHAR_OUTPUT_PATH, JSON.stringify(multicharPairs, null, 2));

  // Stats
  const bmpCount = pairs.filter(p => parseInt(p.sourceCodepoint.slice(2), 16) <= 0xFFFF).length;
  const smpCount = pairs.length - bmpCount;

  // Target distribution
  const targetCounts = new Map<string, number>();
  for (const p of pairs) {
    targetCounts.set(p.target, (targetCounts.get(p.target) || 0) + 1);
  }
  const topTargets = [...targetCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  console.log(`\nParsed ${pairs.length} confusable pairs`);
  console.log(`  BMP: ${bmpCount}, SMP: ${smpCount}`);
  console.log(`  Skipped: ${skippedMultiChar} multi-char, ${skippedNonLatin} non-Latin target, ${skippedBasicLatin} basic Latin`);
  console.log(`  Top targets: ${topTargets.map(([t, c]) => `"${t}":${c}`).join(', ')}`);
  console.log(`\n  Multi-char mappings: ${multicharPairs.length}`);
  console.log(`\nWritten to: ${OUTPUT_PATH}`);
  console.log(`Written to: ${MULTICHAR_OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
