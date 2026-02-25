/**
 * annotate-properties.ts
 *
 * Annotate novel discoveries with Unicode identifier properties:
 * - XID_Start, XID_Continue (UAX #31, from DerivedCoreProperties.txt)
 * - IDNA 2008 PVALID (from IdnaMappingTable.txt)
 * - TR39 Identifier_Status = Allowed (from IdentifierStatus.txt)
 *
 * Downloads the 3 Unicode data files if not already present (same pattern
 * as fetch-confusables.ts).
 *
 * Output: data/output/candidate-discoveries-annotated.json
 *
 * Usage: npx tsx scripts/annotate-properties.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import type { IdentifierProperties } from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const INPUT_DIR = path.join(ROOT, 'data/input');
const CANDIDATE_PATH = path.join(ROOT, 'data/output/candidate-discoveries.json');
const CONFUSABLE_PATH = path.join(ROOT, 'data/output/confusable-discoveries.json');
const OUTPUT_PATH = path.join(ROOT, 'data/output/candidate-discoveries-annotated.json');
const OUTPUT_TR39_PATH = path.join(ROOT, 'data/output/confusable-discoveries-annotated.json');

const UNICODE_FILES = [
  {
    name: 'DerivedCoreProperties.txt',
    url: 'https://unicode.org/Public/16.0.0/ucd/DerivedCoreProperties.txt',
  },
  {
    name: 'IdnaMappingTable.txt',
    url: 'https://unicode.org/Public/idna/16.0.0/IdnaMappingTable.txt',
  },
  {
    name: 'IdentifierStatus.txt',
    url: 'https://unicode.org/Public/security/16.0.0/IdentifierStatus.txt',
  },
];

/**
 * Download a file if it doesn't exist locally.
 */
async function ensureFile(name: string, url: string): Promise<string> {
  const localPath = path.join(INPUT_DIR, name);
  if (fs.existsSync(localPath)) {
    console.log(`  [cached] ${name}`);
    return localPath;
  }

  console.log(`  [download] ${name} from ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${name}: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, text);
  console.log(`  [saved] ${name} (${(text.length / 1024).toFixed(0)} KB)`);
  return localPath;
}

/**
 * Parse a Unicode data file with range-based format into a Set of codepoints.
 * Format: XXXX..YYYY ; Property  or  XXXX ; Property
 * Filters lines matching the given property name.
 */
function parseRangeSet(filePath: string, property: string): Set<number> {
  const text = fs.readFileSync(filePath, 'utf-8');
  const result = new Set<number>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(';');
    if (parts.length < 2) continue;

    const propField = parts[1]!.trim().split('#')[0]!.trim();
    if (propField !== property) continue;

    const range = parts[0]!.trim();
    if (range.includes('..')) {
      const [startHex, endHex] = range.split('..');
      const start = parseInt(startHex!, 16);
      const end = parseInt(endHex!, 16);
      for (let cp = start; cp <= end; cp++) {
        result.add(cp);
      }
    } else {
      result.add(parseInt(range, 16));
    }
  }

  return result;
}

/**
 * Parse IdnaMappingTable.txt for PVALID codepoints.
 * IDNA format: XXXX..YYYY ; status  or  XXXX ; status ; mapping
 * We want entries where status is "valid" (which means PVALID in IDNA 2008).
 */
function parseIdnaPvalid(filePath: string): Set<number> {
  const text = fs.readFileSync(filePath, 'utf-8');
  const result = new Set<number>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(';');
    if (parts.length < 2) continue;

    const status = parts[1]!.trim().split('#')[0]!.trim();
    if (status !== 'valid') continue;

    const range = parts[0]!.trim();
    if (range.includes('..')) {
      const [startHex, endHex] = range.split('..');
      const start = parseInt(startHex!, 16);
      const end = parseInt(endHex!, 16);
      for (let cp = start; cp <= end; cp++) {
        result.add(cp);
      }
    } else {
      result.add(parseInt(range, 16));
    }
  }

  return result;
}

/**
 * Parse IdentifierStatus.txt for Allowed codepoints.
 * Format: XXXX..YYYY ; Allowed  or  XXXX ; Restricted
 */
function parseTr39Allowed(filePath: string): Set<number> {
  return parseRangeSet(filePath, 'Allowed');
}

/**
 * Get identifier properties for a single codepoint.
 */
function getProperties(
  cp: number,
  xidStart: Set<number>,
  xidContinue: Set<number>,
  idnaPvalid: Set<number>,
  tr39Allowed: Set<number>,
): IdentifierProperties {
  return {
    xidStart: xidStart.has(cp),
    xidContinue: xidContinue.has(cp),
    idnaPvalid: idnaPvalid.has(cp),
    tr39Allowed: tr39Allowed.has(cp),
  };
}

interface DiscoveryPair {
  source: string;
  sourceCodepoint: string;
  target: string;
  fonts: unknown[];
  summary: unknown;
}

async function main() {
  console.log('annotate-properties: downloading Unicode data files...\n');

  // Download files
  const paths: string[] = [];
  for (const file of UNICODE_FILES) {
    paths.push(await ensureFile(file.name, file.url));
  }

  // Parse property sets
  console.log('\nParsing property sets...');
  const xidStart = parseRangeSet(paths[0]!, 'XID_Start');
  const xidContinue = parseRangeSet(paths[0]!, 'XID_Continue');
  const idnaPvalid = parseIdnaPvalid(paths[1]!);
  const tr39Allowed = parseTr39Allowed(paths[2]!);

  console.log(`  XID_Start:    ${xidStart.size.toLocaleString()} codepoints`);
  console.log(`  XID_Continue: ${xidContinue.size.toLocaleString()} codepoints`);
  console.log(`  IDNA PVALID:  ${idnaPvalid.size.toLocaleString()} codepoints`);
  console.log(`  TR39 Allowed: ${tr39Allowed.size.toLocaleString()} codepoints`);

  // Load discoveries
  console.log('\nAnnotating discoveries...');
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE_PATH, 'utf-8'));
  const confusable = JSON.parse(fs.readFileSync(CONFUSABLE_PATH, 'utf-8'));

  // Annotate novel pairs
  const annotatedPairs = candidate.pairs.map((pair: DiscoveryPair) => {
    const cp = parseInt(pair.sourceCodepoint.slice(2), 16);
    const props = getProperties(cp, xidStart, xidContinue, idnaPvalid, tr39Allowed);
    return { ...pair, properties: props };
  });

  // Annotate TR39 pairs too (for weight generation)
  const annotatedTr39 = confusable.pairs.map((pair: DiscoveryPair) => {
    const cp = parseInt(pair.sourceCodepoint.slice(2), 16);
    const props = getProperties(cp, xidStart, xidContinue, idnaPvalid, tr39Allowed);
    return { ...pair, properties: props };
  });

  // Write output
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(
    { ...candidate, pairs: annotatedPairs },
    null,
    2,
  ));
  fs.writeFileSync(OUTPUT_TR39_PATH, JSON.stringify(
    { ...confusable, pairs: annotatedTr39 },
    null,
    2,
  ));

  // Summary table
  const allPairs = annotatedPairs;
  const xidContinueCount = allPairs.filter((p: any) => p.properties.xidContinue).length;
  const xidStartCount = allPairs.filter((p: any) => p.properties.xidStart).length;
  const idnaCount = allPairs.filter((p: any) => p.properties.idnaPvalid).length;
  const allowedCount = allPairs.filter((p: any) => p.properties.tr39Allowed).length;
  const xidAndIdna = allPairs.filter((p: any) =>
    p.properties.xidContinue && p.properties.idnaPvalid
  ).length;

  console.log(`\n=== Novel Pairs Property Summary (${allPairs.length} pairs) ===`);
  console.log(`  XID_Continue:           ${xidContinueCount}  (${(100 * xidContinueCount / allPairs.length).toFixed(1)}%)`);
  console.log(`  XID_Start:              ${xidStartCount}  (${(100 * xidStartCount / allPairs.length).toFixed(1)}%)`);
  console.log(`  IDNA PVALID:            ${idnaCount}  (${(100 * idnaCount / allPairs.length).toFixed(1)}%)`);
  console.log(`  TR39 Allowed:           ${allowedCount}  (${(100 * allowedCount / allPairs.length).toFixed(1)}%)`);
  console.log(`  XID_Continue AND IDNA:  ${xidAndIdna}  (${(100 * xidAndIdna / allPairs.length).toFixed(1)}%) -- most dangerous`);

  // TR39 pairs summary
  const tr39XidCont = annotatedTr39.filter((p: any) => p.properties.xidContinue).length;
  const tr39Idna = annotatedTr39.filter((p: any) => p.properties.idnaPvalid).length;
  const tr39AllowedCount = annotatedTr39.filter((p: any) => p.properties.tr39Allowed).length;

  console.log(`\n=== TR39 Pairs Property Summary (${annotatedTr39.length} pairs) ===`);
  console.log(`  XID_Continue:           ${tr39XidCont}`);
  console.log(`  IDNA PVALID:            ${tr39Idna}`);
  console.log(`  TR39 Allowed:           ${tr39AllowedCount}`);

  console.log(`\nWritten: ${OUTPUT_PATH}`);
  console.log(`Written: ${OUTPUT_TR39_PATH}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
