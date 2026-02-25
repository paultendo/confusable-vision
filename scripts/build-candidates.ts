/**
 * Milestone 2, Step 1: Build candidate character set
 *
 * Finds all Unicode L (Letter) and N (Number) codepoints not already in
 * confusables.txt, filters out CJK and Latin targets, queries fontconfig
 * coverage, and outputs candidates.json for the rendering pipeline.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const DATA_INPUT = join(import.meta.dirname, '..', 'data', 'input');
const DATA_OUTPUT = join(import.meta.dirname, '..', 'data', 'output');
const UNICODE_DATA_PATH = join(DATA_INPUT, 'UnicodeData.txt');
const UNICODE_DATA_URL = 'https://unicode.org/Public/UNIDATA/UnicodeData.txt';
const CONFUSABLE_PAIRS_PATH = join(DATA_INPUT, 'confusable-pairs.json');
const OUTPUT_PATH = join(DATA_OUTPUT, 'candidates.json');

// Ranges to exclude (won't resemble Latin characters)
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

function isExcludedRange(cp: number): string | null {
  for (const [lo, hi, label] of EXCLUDED_RANGES) {
    if (cp >= lo && cp <= hi) return label;
  }
  return null;
}

/** Parse a codepoint string like "U+0430" to a number */
function parseCp(s: string): number {
  return parseInt(s.replace('U+', ''), 16);
}

/** Format a number as "U+XXXX" */
function formatCp(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Parse UnicodeData.txt to extract all L* and N* general categories.
 * Returns Map<codepoint, { name, gc }>
 *
 * UnicodeData.txt uses ranges for CJK blocks:
 *   4E00;<CJK Ideograph, First>;Lo;...
 *   9FFF;<CJK Ideograph, Last>;Lo;...
 * We expand these into the full range.
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

    // Only L (Letter) and N (Number) categories
    if (!gc.startsWith('L') && !gc.startsWith('N')) {
      // But still check for range end
      if (rangeStart && name.endsWith(', Last>')) {
        // Expand the range
        for (let i = rangeStart.cp; i <= cp; i++) {
          result.set(i, { name: rangeStart.name.replace(', First>', ''), gc: rangeStart.gc });
        }
        rangeStart = null;
      }
      continue;
    }

    // Handle range markers
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

/**
 * Query fontconfig for how many fonts cover a codepoint.
 * Batches queries for efficiency.
 */
function queryFontCoverageBatch(codepoints: number[]): Map<number, number> {
  const result = new Map<number, number>();

  // Process in batches to avoid command line length limits
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

    if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= total) {
      const done = Math.min(i + BATCH_SIZE, total);
      const withCoverage = [...result.values()].filter(v => v > 0).length;
      console.log(`  [${done}/${total}] queried -- ${withCoverage} with font coverage so far`);
    }
  }

  return result;
}

/**
 * Derive script name from Unicode block/codepoint.
 * This is a simplified heuristic -- not a full Unicode Script property lookup.
 */
function deriveScript(cp: number, name: string): string {
  // Common script ranges
  if (cp >= 0x0370 && cp <= 0x03FF) return 'Greek';
  if (cp >= 0x0400 && cp <= 0x04FF) return 'Cyrillic';
  if (cp >= 0x0500 && cp <= 0x052F) return 'Cyrillic Supplement';
  if (cp >= 0x0530 && cp <= 0x058F) return 'Armenian';
  if (cp >= 0x0590 && cp <= 0x05FF) return 'Hebrew';
  if (cp >= 0x0600 && cp <= 0x06FF) return 'Arabic';
  if (cp >= 0x0700 && cp <= 0x074F) return 'Syriac';
  if (cp >= 0x0900 && cp <= 0x097F) return 'Devanagari';
  if (cp >= 0x0980 && cp <= 0x09FF) return 'Bengali';
  if (cp >= 0x0A00 && cp <= 0x0A7F) return 'Gurmukhi';
  if (cp >= 0x0A80 && cp <= 0x0AFF) return 'Gujarati';
  if (cp >= 0x0B00 && cp <= 0x0B7F) return 'Oriya';
  if (cp >= 0x0B80 && cp <= 0x0BFF) return 'Tamil';
  if (cp >= 0x0C00 && cp <= 0x0C7F) return 'Telugu';
  if (cp >= 0x0C80 && cp <= 0x0CFF) return 'Kannada';
  if (cp >= 0x0D00 && cp <= 0x0D7F) return 'Malayalam';
  if (cp >= 0x0D80 && cp <= 0x0DFF) return 'Sinhala';
  if (cp >= 0x0E00 && cp <= 0x0E7F) return 'Thai';
  if (cp >= 0x0E80 && cp <= 0x0EFF) return 'Lao';
  if (cp >= 0x0F00 && cp <= 0x0FFF) return 'Tibetan';
  if (cp >= 0x1000 && cp <= 0x109F) return 'Myanmar';
  if (cp >= 0x10A0 && cp <= 0x10FF) return 'Georgian';
  if (cp >= 0x1100 && cp <= 0x11FF) return 'Hangul Jamo';
  if (cp >= 0x1200 && cp <= 0x137F) return 'Ethiopic';
  if (cp >= 0x13A0 && cp <= 0x13FF) return 'Cherokee';
  if (cp >= 0x1400 && cp <= 0x167F) return 'Canadian Aboriginal';
  if (cp >= 0x1680 && cp <= 0x169F) return 'Ogham';
  if (cp >= 0x16A0 && cp <= 0x16FF) return 'Runic';
  if (cp >= 0x1780 && cp <= 0x17FF) return 'Khmer';
  if (cp >= 0x1800 && cp <= 0x18AF) return 'Mongolian';
  if (cp >= 0x2C00 && cp <= 0x2C5F) return 'Glagolitic';
  if (cp >= 0x2C60 && cp <= 0x2C7F) return 'Latin Extended-C';
  if (cp >= 0x2C80 && cp <= 0x2CFF) return 'Coptic';
  if (cp >= 0x2D00 && cp <= 0x2D2F) return 'Georgian Supplement';
  if (cp >= 0x2D30 && cp <= 0x2D7F) return 'Tifinagh';
  if (cp >= 0xA640 && cp <= 0xA69F) return 'Cyrillic Extended-B';
  if (cp >= 0xA720 && cp <= 0xA7FF) return 'Latin Extended-D';
  if (cp >= 0xA800 && cp <= 0xA82F) return 'Syloti Nagri';
  if (cp >= 0xA840 && cp <= 0xA87F) return 'Phags-pa';
  if (cp >= 0xAB00 && cp <= 0xAB2F) return 'Ethiopic Extended-A';
  if (cp >= 0xAB70 && cp <= 0xABBF) return 'Cherokee Supplement';
  if (cp >= 0xAC00 && cp <= 0xD7AF) return 'Hangul Syllables';
  if (cp >= 0xFB50 && cp <= 0xFDFF) return 'Arabic Presentation Forms-A';
  if (cp >= 0xFE70 && cp <= 0xFEFF) return 'Arabic Presentation Forms-B';
  if (cp >= 0xFF00 && cp <= 0xFFEF) return 'Halfwidth and Fullwidth Forms';

  // SMP ranges
  if (cp >= 0x10000 && cp <= 0x1007F) return 'Linear B Syllabary';
  if (cp >= 0x10080 && cp <= 0x100FF) return 'Linear B Ideograms';
  if (cp >= 0x10300 && cp <= 0x1032F) return 'Old Italic';
  if (cp >= 0x10330 && cp <= 0x1034F) return 'Gothic';
  if (cp >= 0x10400 && cp <= 0x1044F) return 'Deseret';
  if (cp >= 0x10800 && cp <= 0x1083F) return 'Cypriot';
  if (cp >= 0x10900 && cp <= 0x1091F) return 'Phoenician';
  if (cp >= 0x10920 && cp <= 0x1093F) return 'Lydian';
  if (cp >= 0x10A00 && cp <= 0x10A5F) return 'Kharoshthi';
  if (cp >= 0x1D400 && cp <= 0x1D7FF) return 'Mathematical Alphanumeric Symbols';
  if (cp >= 0x1F100 && cp <= 0x1F1FF) return 'Enclosed Alphanumeric Supplement';

  // Latin ranges
  if (cp >= 0x0000 && cp <= 0x007F) return 'Basic Latin';
  if (cp >= 0x0080 && cp <= 0x00FF) return 'Latin-1 Supplement';
  if (cp >= 0x0100 && cp <= 0x024F) return 'Latin Extended-A/B';
  if (cp >= 0x0250 && cp <= 0x02AF) return 'IPA Extensions';
  if (cp >= 0x1D00 && cp <= 0x1DBF) return 'Phonetic Extensions';
  if (cp >= 0x1E00 && cp <= 0x1EFF) return 'Latin Extended Additional';
  if (cp >= 0xA720 && cp <= 0xA7FF) return 'Latin Extended-D';
  if (cp >= 0xAB30 && cp <= 0xAB6F) return 'Latin Extended-E';

  // Fallback: use the character name for hints
  if (name.includes('LATIN')) return 'Latin (other)';
  if (name.includes('GREEK')) return 'Greek (other)';
  if (name.includes('CYRILLIC')) return 'Cyrillic (other)';
  if (name.includes('ARABIC')) return 'Arabic (other)';
  if (name.includes('CHEROKEE')) return 'Cherokee (other)';
  if (name.includes('GEORGIAN')) return 'Georgian (other)';

  return 'Other';
}

// --- Main ---

async function main() {
  console.log('=== confusable-vision: build-candidates (Milestone 2) ===\n');

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

  // Step 3: Filter candidates
  const excludedByRange = new Map<string, number>();
  let excludedLatinTarget = 0;
  let excludedExistingSource = 0;
  const preFontCandidates: { cp: number; name: string; gc: string }[] = [];

  for (const [cp, { name, gc }] of unicodeData) {
    if (LATIN_TARGETS.has(cp)) {
      excludedLatinTarget++;
      continue;
    }
    if (existingSources.has(cp)) {
      excludedExistingSource++;
      continue;
    }
    const rangeLabel = isExcludedRange(cp);
    if (rangeLabel) {
      excludedByRange.set(rangeLabel, (excludedByRange.get(rangeLabel) || 0) + 1);
      continue;
    }
    preFontCandidates.push({ cp, name, gc });
  }

  const totalExcludedByRange = [...excludedByRange.values()].reduce((a, b) => a + b, 0);
  console.log(`  Excluded by range: ${totalExcludedByRange}`);
  for (const [label, count] of [...excludedByRange.entries()].sort((a, b) => b[1] - a[1])) {
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
  console.log('[4/4] Writing candidates.json...');
  writeFileSync(OUTPUT_PATH, JSON.stringify(candidates, null, 2));
  console.log(`  Written to ${OUTPUT_PATH}\n`);

  // Summary
  console.log('=== Summary ===\n');
  console.log(`  Total Unicode L+N codepoints:     ${unicodeData.size}`);
  console.log(`  Excluded by range:                ${totalExcludedByRange}`);
  console.log(`  Excluded Latin targets (a-z/0-9):  ${excludedLatinTarget}`);
  console.log(`  Excluded existing confusables:     ${excludedExistingSource}`);
  console.log(`  Excluded no font coverage:         ${excludedNoFont}`);
  console.log(`  Final candidates:                  ${candidates.length}`);
  console.log();

  // Script breakdown
  const scriptCounts = new Map<string, number>();
  for (const c of candidates) {
    scriptCounts.set(c.script, (scriptCounts.get(c.script) || 0) + 1);
  }
  const sorted = [...scriptCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('  Script breakdown:');
  for (const [script, count] of sorted.slice(0, 20)) {
    console.log(`    ${script.padEnd(40)} ${count}`);
  }
  if (sorted.length > 20) {
    const rest = sorted.slice(20).reduce((sum, [, c]) => sum + c, 0);
    console.log(`    ... ${sorted.length - 20} more scripts              ${rest}`);
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
