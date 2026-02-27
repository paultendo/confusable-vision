/**
 * Milestone 2b, Step 1: Build CJK/Hangul/logographic candidate set
 *
 * Inverts the range filter from build-candidates.ts: only includes codepoints
 * from EXCLUDED_RANGES. Same exclusions for existing TR39 sources and Latin
 * targets. Same fontconfig coverage query.
 *
 * This tests the assumption that CJK/Hangul/logographic characters are
 * structurally too different from Latin to produce high visual similarity.
 *
 * Output: data/output/m2b-candidates.json
 *
 * Usage:
 *   npx tsx scripts/build-candidates-m2b.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const DATA_INPUT = join(import.meta.dirname, '..', 'data', 'input');
const DATA_OUTPUT = join(import.meta.dirname, '..', 'data', 'output');
const UNICODE_DATA_PATH = join(DATA_INPUT, 'UnicodeData.txt');
const UNICODE_DATA_URL = 'https://unicode.org/Public/UNIDATA/UnicodeData.txt';
const CONFUSABLE_PAIRS_PATH = join(DATA_INPUT, 'confusable-pairs.json');
const OUTPUT_PATH = join(DATA_OUTPUT, 'm2b-candidates.json');

// Same excluded ranges as M2 -- but here we INCLUDE only these ranges
const EXCLUDED_RANGES: [number, number, string][] = [
  // CJK Ideographs (all extensions)
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
  // Hangul (composed Korean syllables)
  [0xAC00, 0xD7AF, 'Hangul Syllables'],
  [0x1100, 0x11FF, 'Hangul Jamo'],
  [0x3130, 0x318F, 'Hangul Compatibility Jamo'],
  [0xA960, 0xA97F, 'Hangul Jamo Extended-A'],
  [0xD7B0, 0xD7FF, 'Hangul Jamo Extended-B'],
  // Logographic/pictographic scripts (structurally unlike Latin)
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
  // CJK-adjacent
  [0x31C0, 0x31EF, 'CJK Strokes'],
  [0x2E80, 0x2FDF, 'CJK Radicals'],
  [0x3000, 0x312F, 'CJK Symbols, Hiragana, Katakana (base)'],
  [0x31F0, 0x31FF, 'Katakana Phonetic Extensions'],
  [0xFF65, 0xFFDC, 'Halfwidth Katakana/Hangul'],
];

// Latin targets to exclude
const LATIN_TARGETS = new Set<number>();
for (let cp = 0x41; cp <= 0x5A; cp++) LATIN_TARGETS.add(cp); // A-Z
for (let cp = 0x61; cp <= 0x7A; cp++) LATIN_TARGETS.add(cp); // a-z
for (let cp = 0x30; cp <= 0x39; cp++) LATIN_TARGETS.add(cp); // 0-9

interface Candidate {
  codepoint: string;
  char: string;
  name: string;
  generalCategory: string;
  script: string;
  fontCoverage: number;
}

function isInExcludedRange(cp: number): string | null {
  for (const [lo, hi, label] of EXCLUDED_RANGES) {
    if (cp >= lo && cp <= hi) return label;
  }
  return null;
}

function parseCp(s: string): number {
  return parseInt(s.replace('U+', ''), 16);
}

function formatCp(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Parse UnicodeData.txt to extract all L* and N* general categories.
 * Handles CJK range markers (First/Last).
 */
function parseUnicodeData(path: string): Map<number, { name: string; gc: string }> {
  const lines = readFileSync(path, 'utf-8').split('\n');
  const result = new Map<number, { name: string; gc: string }>();
  let rangeStart: { cp: number; name: string; gc: string } | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.split(';');
    const cp = parseInt(fields[0], 16);
    const name = fields[1];
    const gc = fields[2];

    if (!gc.startsWith('L') && !gc.startsWith('N')) {
      if (rangeStart && name.endsWith(', Last>')) {
        for (let i = rangeStart.cp; i <= cp; i++) {
          result.set(i, { name: rangeStart.name.replace(', First>', ''), gc: rangeStart.gc });
        }
        rangeStart = null;
      }
      continue;
    }

    if (name.endsWith(', First>')) {
      rangeStart = { cp, name, gc };
      continue;
    }
    if (name.endsWith(', Last>')) {
      if (rangeStart) {
        for (let i = rangeStart.cp; i <= cp; i++) {
          result.set(i, { name: rangeStart.name.replace(', First>', ''), gc: rangeStart.gc });
        }
        rangeStart = null;
      }
      continue;
    }

    result.set(cp, { name, gc });
  }

  return result;
}

function queryFontCoverageBatch(codepoints: number[]): Map<number, number> {
  const result = new Map<number, number>();
  const BATCH_SIZE = 100;
  const total = codepoints.length;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = codepoints.slice(i, i + BATCH_SIZE);

    for (const cp of batch) {
      const hex = cp.toString(16).toUpperCase();
      try {
        const out = execSync(
          `fc-list ':charset=${hex}' file 2>/dev/null | wc -l`,
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        result.set(cp, parseInt(out, 10) || 0);
      } catch {
        result.set(cp, 0);
      }
    }

    if ((i + BATCH_SIZE) % 5000 === 0 || i + BATCH_SIZE >= total) {
      const done = Math.min(i + BATCH_SIZE, total);
      const withCoverage = [...result.values()].filter(v => v > 0).length;
      console.log(`  [${done}/${total}] queried -- ${withCoverage} with font coverage so far`);
    }
  }

  return result;
}

function deriveScript(cp: number, _name: string): string {
  // Map codepoint to the excluded range label
  const label = isInExcludedRange(cp);
  if (label) return label;
  return 'Other';
}

// --- Main ---

async function main() {
  console.log('=== confusable-vision: build-candidates-m2b (Milestone 2b) ===\n');

  // Step 0: Download UnicodeData.txt if not present
  if (!existsSync(UNICODE_DATA_PATH)) {
    console.log(`Downloading UnicodeData.txt from ${UNICODE_DATA_URL}...`);
    execSync(`curl -sL "${UNICODE_DATA_URL}" -o "${UNICODE_DATA_PATH}"`, { timeout: 30000 });
    console.log('  Downloaded.\n');
  }

  // Step 1: Parse UnicodeData.txt
  console.log('[1/4] Parsing UnicodeData.txt...');
  const unicodeData = parseUnicodeData(UNICODE_DATA_PATH);
  console.log(`  ${unicodeData.size} codepoints with General Category L or N\n`);

  // Step 2: Load existing confusable sources to exclude
  console.log('[2/4] Loading exclusion sets...');
  const confusablePairs: { sourceCodepoint: string }[] = JSON.parse(
    readFileSync(CONFUSABLE_PAIRS_PATH, 'utf-8')
  );
  const existingSources = new Set(confusablePairs.map(p => parseCp(p.sourceCodepoint)));
  console.log(`  ${existingSources.size} existing confusable source codepoints`);

  // Step 3: Filter candidates -- INVERTED: only include chars IN excluded ranges
  const includedByRange = new Map<string, number>();
  let excludedLatinTarget = 0;
  let excludedExistingSource = 0;
  let excludedNotInRange = 0;
  const preFontCandidates: { cp: number; name: string; gc: string }[] = [];

  for (const [cp, { name, gc }] of unicodeData) {
    // Must be in one of the excluded ranges
    const rangeLabel = isInExcludedRange(cp);
    if (!rangeLabel) {
      excludedNotInRange++;
      continue;
    }

    if (LATIN_TARGETS.has(cp)) {
      excludedLatinTarget++;
      continue;
    }
    if (existingSources.has(cp)) {
      excludedExistingSource++;
      continue;
    }

    includedByRange.set(rangeLabel, (includedByRange.get(rangeLabel) || 0) + 1);
    preFontCandidates.push({ cp, name, gc });
  }

  console.log(`  Not in excluded ranges (skipped): ${excludedNotInRange}`);
  console.log(`  Included by range: ${preFontCandidates.length}`);
  for (const [label, count] of [...includedByRange.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${label.padEnd(45)} ${count}`);
  }
  console.log(`  Excluded Latin targets: ${excludedLatinTarget}`);
  console.log(`  Excluded existing confusables: ${excludedExistingSource}`);
  console.log(`  Pre-font candidates: ${preFontCandidates.length}\n`);

  // Step 4: Query fontconfig coverage
  console.log(`[3/4] Querying fontconfig coverage for ${preFontCandidates.length} candidates...`);
  const coverageMap = queryFontCoverageBatch(preFontCandidates.map(c => c.cp));

  let excludedNoFont = 0;
  const candidates: Candidate[] = [];

  for (const { cp, name, gc } of preFontCandidates) {
    const coverage = coverageMap.get(cp) || 0;
    if (coverage === 0) {
      excludedNoFont++;
      continue;
    }
    candidates.push({
      codepoint: formatCp(cp),
      char: String.fromCodePoint(cp),
      name,
      generalCategory: gc,
      script: deriveScript(cp, name),
      fontCoverage: coverage,
    });
  }

  console.log(`  Excluded: ${excludedNoFont} with zero font coverage`);
  console.log(`  Final candidates: ${candidates.length}\n`);

  // Sort by codepoint for deterministic output
  candidates.sort((a, b) => parseCp(a.codepoint) - parseCp(b.codepoint));

  // Step 5: Write output
  console.log('[4/4] Writing m2b-candidates.json...');
  writeFileSync(OUTPUT_PATH, JSON.stringify(candidates, null, 2));
  console.log(`  Written to ${OUTPUT_PATH}\n`);

  // Summary
  console.log('=== Summary ===\n');
  console.log(`  Total Unicode L+N codepoints:     ${unicodeData.size}`);
  console.log(`  Not in excluded ranges:            ${excludedNotInRange}`);
  console.log(`  Excluded Latin targets (a-z/0-9):  ${excludedLatinTarget}`);
  console.log(`  Excluded existing confusables:     ${excludedExistingSource}`);
  console.log(`  Excluded no font coverage:         ${excludedNoFont}`);
  console.log(`  Final candidates:                  ${candidates.length}`);
  console.log();

  // Range breakdown
  const rangeCounts = new Map<string, number>();
  for (const c of candidates) {
    rangeCounts.set(c.script, (rangeCounts.get(c.script) || 0) + 1);
  }
  const sorted = [...rangeCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('  Range breakdown:');
  for (const [range, count] of sorted) {
    console.log(`    ${range.padEnd(45)} ${count}`);
  }

  // General category breakdown
  const gcCounts = new Map<string, number>();
  for (const c of candidates) {
    gcCounts.set(c.generalCategory, (gcCounts.get(c.generalCategory) || 0) + 1);
  }
  console.log('\n  General category breakdown:');
  for (const [gc, count] of [...gcCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${gc.padEnd(10)} ${count}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
