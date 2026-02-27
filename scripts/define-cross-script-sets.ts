/**
 * define-cross-script-sets.ts -- Milestone 5, Step 1
 *
 * Defines the 12 ICANN-relevant script character sets for cross-script
 * confusable scanning. Uses Unicode's authoritative Scripts.txt for
 * script assignment (not heuristic block ranges).
 *
 * For each of the 12 scripts: intersects the Unicode Script property with
 * explicit codepoint range restrictions and General_Category L/N filter,
 * then queries fontconfig for coverage.
 *
 * Output: data/output/cross-script-sets.json
 *
 * Usage:
 *   npx tsx scripts/define-cross-script-sets.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const DATA_INPUT = join(import.meta.dirname, '..', 'data', 'input');
const DATA_OUTPUT = join(import.meta.dirname, '..', 'data', 'output');
const UNICODE_DATA_PATH = join(DATA_INPUT, 'UnicodeData.txt');
const UNICODE_DATA_URL = 'https://unicode.org/Public/UNIDATA/UnicodeData.txt';
const SCRIPTS_PATH = join(DATA_INPUT, 'Scripts.txt');
const SCRIPTS_URL = 'https://unicode.org/Public/UNIDATA/Scripts.txt';
const OUTPUT_PATH = join(DATA_OUTPUT, 'cross-script-sets.json');

// ---------------------------------------------------------------------------
// Script family definitions
// ---------------------------------------------------------------------------

interface ScriptFamily {
  scriptNames: string[];        // Unicode Script property values to include
  ranges: [number, number][];   // codepoint range restrictions
  description: string;
}

const SCRIPT_FAMILIES: Record<string, ScriptFamily> = {
  Latin: {
    scriptNames: ['Latin', 'Common'], // Common needed for digits 0-9
    ranges: [[0x0041, 0x005A], [0x0061, 0x007A], [0x0030, 0x0039]],
    description: 'Basic Latin letters and digits (A-Z, a-z, 0-9)',
  },
  Cyrillic: {
    scriptNames: ['Cyrillic'],
    ranges: [[0x0400, 0x04FF], [0x0500, 0x052F]],
    description: 'Cyrillic + Cyrillic Supplement',
  },
  Greek: {
    scriptNames: ['Greek'],
    ranges: [[0x0370, 0x03FF]],
    description: 'Greek and Coptic block',
  },
  Arabic: {
    scriptNames: ['Arabic'],
    ranges: [[0x0600, 0x06FF], [0x0750, 0x077F]],
    description: 'Arabic + Arabic Supplement',
  },
  Han: {
    scriptNames: ['Han'],
    ranges: [[0x4E00, 0x9FFF]],
    description: 'CJK Unified Ideographs base block (no extensions)',
  },
  Hangul: {
    scriptNames: ['Hangul'],
    ranges: [[0x1100, 0x11FF], [0x3131, 0x318E]],
    description: 'Hangul Jamo + Compatibility Jamo (atomic visual components)',
  },
  Katakana: {
    scriptNames: ['Katakana'],
    ranges: [[0x30A0, 0x30FF]],
    description: 'Katakana block',
  },
  Hiragana: {
    scriptNames: ['Hiragana'],
    ranges: [[0x3040, 0x309F]],
    description: 'Hiragana block',
  },
  Devanagari: {
    scriptNames: ['Devanagari'],
    ranges: [[0x0900, 0x097F]],
    description: 'Devanagari block',
  },
  Thai: {
    scriptNames: ['Thai'],
    ranges: [[0x0E00, 0x0E7F]],
    description: 'Thai block',
  },
  Georgian: {
    scriptNames: ['Georgian'],
    ranges: [[0x10A0, 0x10FF], [0x2D00, 0x2D2F]],
    description: 'Georgian + Georgian Supplement',
  },
  Armenian: {
    scriptNames: ['Armenian'],
    ranges: [[0x0530, 0x058F]],
    description: 'Armenian block',
  },
};

// ---------------------------------------------------------------------------
// Parsers (UnicodeData.txt reused from build-candidates.ts)
// ---------------------------------------------------------------------------

function formatCp(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Parse UnicodeData.txt to extract all L* and N* general categories.
 * Returns Map<codepoint, { name, gc }>
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

/**
 * Parse Scripts.txt to build Map<codepoint, scriptName>.
 *
 * Format:
 *   0041..005A    ; Latin # L&  [26] ...
 *   0061          ; Latin # L&       ...
 */
function parseScripts(path: string): Map<number, string> {
  const lines = readFileSync(path, 'utf-8').split('\n');
  const result = new Map<number, string>();

  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    const commentIdx = line.indexOf('#');
    const data = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    const parts = data.split(';');
    if (parts.length < 2) continue;

    const rangePart = parts[0].trim();
    const scriptName = parts[1].trim();

    if (rangePart.includes('..')) {
      const [startStr, endStr] = rangePart.split('..');
      const start = parseInt(startStr, 16);
      const end = parseInt(endStr, 16);
      for (let cp = start; cp <= end; cp++) {
        result.set(cp, scriptName);
      }
    } else {
      const cp = parseInt(rangePart, 16);
      if (!isNaN(cp)) {
        result.set(cp, scriptName);
      }
    }
  }

  return result;
}

/**
 * Query fontconfig for how many fonts cover a codepoint.
 * Batches queries for efficiency.
 */
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

    if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= total) {
      const done = Math.min(i + BATCH_SIZE, total);
      const withCoverage = [...result.values()].filter(v => v > 0).length;
      console.log(`  [${done}/${total}] queried -- ${withCoverage} with font coverage so far`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface CharEntry {
  codepoint: string;
  char: string;
  name: string;
  generalCategory: string;
  fontCoverage: number;
}

interface ScriptSet {
  description: string;
  characterCount: number;
  characters: CharEntry[];
}

async function main() {
  console.log('=== confusable-vision: define-cross-script-sets (Milestone 5) ===\n');

  // Step 0: Download data files if not present
  if (!existsSync(UNICODE_DATA_PATH)) {
    console.log(`Downloading UnicodeData.txt...`);
    execSync(`curl -sL "${UNICODE_DATA_URL}" -o "${UNICODE_DATA_PATH}"`, { timeout: 30000 });
    console.log('  Downloaded.\n');
  }
  if (!existsSync(SCRIPTS_PATH)) {
    console.log(`Downloading Scripts.txt...`);
    execSync(`curl -sL "${SCRIPTS_URL}" -o "${SCRIPTS_PATH}"`, { timeout: 30000 });
    console.log('  Downloaded.\n');
  }

  // Step 1: Parse data files
  console.log('[1/4] Parsing UnicodeData.txt...');
  const unicodeData = parseUnicodeData(UNICODE_DATA_PATH);
  console.log(`  ${unicodeData.size} codepoints with General Category L or N\n`);

  console.log('[1/4] Parsing Scripts.txt...');
  const scriptMap = parseScripts(SCRIPTS_PATH);
  console.log(`  ${scriptMap.size} codepoints with script assignments\n`);

  // Step 2: Build character sets for each script family
  console.log('[2/4] Building script character sets...');
  const scriptFamilyNames = Object.keys(SCRIPT_FAMILIES);
  const preFontSets = new Map<string, { cp: number; name: string; gc: string }[]>();
  let totalPreFont = 0;

  for (const familyName of scriptFamilyNames) {
    const family = SCRIPT_FAMILIES[familyName];
    const chars: { cp: number; name: string; gc: string }[] = [];

    // For each codepoint in the allowed ranges
    for (const [lo, hi] of family.ranges) {
      for (let cp = lo; cp <= hi; cp++) {
        // Must have a Unicode Script assignment matching one of the family's script names
        const script = scriptMap.get(cp);
        if (!script || !family.scriptNames.includes(script)) continue;

        // Must be L* or N* category
        const data = unicodeData.get(cp);
        if (!data) continue;

        chars.push({ cp, name: data.name, gc: data.gc });
      }
    }

    preFontSets.set(familyName, chars);
    totalPreFont += chars.length;
    console.log(`  ${familyName.padEnd(15)} ${chars.length} characters (pre-font-filter)`);
  }
  console.log(`  Total: ${totalPreFont}\n`);

  // Step 3: Query fontconfig coverage
  console.log('[3/4] Querying fontconfig coverage...');
  const allCodepoints: number[] = [];
  for (const chars of preFontSets.values()) {
    for (const c of chars) allCodepoints.push(c.cp);
  }

  const coverageMap = queryFontCoverageBatch(allCodepoints);

  // Step 4: Build final output
  console.log('\n[4/4] Building output...');
  const scripts: Record<string, ScriptSet> = {};
  let totalWithCoverage = 0;
  let totalExcluded = 0;

  for (const familyName of scriptFamilyNames) {
    const family = SCRIPT_FAMILIES[familyName];
    const preFont = preFontSets.get(familyName)!;
    const characters: CharEntry[] = [];

    for (const { cp, name, gc } of preFont) {
      const coverage = coverageMap.get(cp) || 0;
      if (coverage === 0) {
        totalExcluded++;
        continue;
      }
      characters.push({
        codepoint: formatCp(cp),
        char: String.fromCodePoint(cp),
        name,
        generalCategory: gc,
        fontCoverage: coverage,
      });
    }

    // Sort by codepoint
    characters.sort((a, b) => {
      const cpA = parseInt(a.codepoint.replace('U+', ''), 16);
      const cpB = parseInt(b.codepoint.replace('U+', ''), 16);
      return cpA - cpB;
    });

    scripts[familyName] = {
      description: family.description,
      characterCount: characters.length,
      characters,
    };

    totalWithCoverage += characters.length;
    console.log(`  ${familyName.padEnd(15)} ${characters.length} characters with font coverage`);
  }

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      scriptsCount: scriptFamilyNames.length,
      totalCharacters: totalWithCoverage,
      totalExcludedNoFont: totalExcluded,
    },
    scripts,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWritten to ${OUTPUT_PATH}`);
  console.log(`  ${scriptFamilyNames.length} scripts, ${totalWithCoverage} characters total`);
  console.log(`  ${totalExcluded} excluded (zero font coverage)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
