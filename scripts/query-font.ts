/**
 * query-font.ts: query confusable pairs by font name
 *
 * Reads the intermediate discovery files and outputs every confusable pair
 * where a given font scored above threshold, sorted by SSIM descending.
 *
 * Usage:
 *   npx tsx scripts/query-font.ts "Arial"
 *   npx tsx scripts/query-font.ts "Arial" --threshold 0.8
 *   npx tsx scripts/query-font.ts "Arial" --compare "Inter"
 *   npx tsx scripts/query-font.ts --list-fonts
 *   npx tsx scripts/query-font.ts "Arial" --json
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data/output');

const CONFUSABLE_PATH = path.join(DATA, 'confusable-discoveries.json');
const CANDIDATE_PATH = path.join(DATA, 'candidate-discoveries.json');
const CROSS_SCRIPT_PATH = path.join(DATA, 'cross-script-discoveries.json');

const DEFAULT_THRESHOLD = 0.7;

// --- On-disk shapes (match what the pipeline actually writes) ---

interface DiscoveryFontEntry {
  sourceFont: string;
  targetFont: string;
  ssim: number | null;
  pHash: number | null;
  sourceRenderStatus: 'native' | 'fallback' | 'notdef';
  sourceFallbackFont: string | null;
  ssimSkipped: boolean;
}

interface DiscoveryPair {
  source: string;
  sourceCodepoint: string;
  target: string;
  fonts: DiscoveryFontEntry[];
  summary: {
    meanSsim: number | null;
    meanPHash: number | null;
    validFontCount: number;
  };
}

interface CrossScriptPair {
  charA: string;
  codepointA: string;
  scriptA: string;
  charB: string;
  codepointB: string;
  scriptB: string;
  summary: {
    meanSsim: number | null;
    meanPHash: number | null;
    validFontCount: number;
  };
  bestFont: {
    sourceFont: string;
    targetFont: string;
    ssim: number;
    pHash: number;
  };
}

// --- Query result ---

interface FontPairResult {
  source: string;
  sourceCodepoint: string;
  target: string;
  ssim: number;
  pHash: number | null;
  renderStatus: 'native' | 'fallback' | 'notdef';
  fallbackFont: string | null;
  /** Which font was used for the source side */
  sourceFont: string;
  /** Which font was used for the target side */
  targetFont: string;
  dataSource: 'tr39' | 'novel' | 'cross-script';
}

// --- File loading ---

function loadDiscoveryFile(filePath: string): { pairs: DiscoveryPair[] } | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function loadCrossScriptFile(filePath: string): { pairs: CrossScriptPair[] } | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// --- Font matching ---

function fontMatches(fontName: string, query: string): boolean {
  return fontName.toLowerCase().includes(query.toLowerCase());
}

// --- Core query ---

function queryFont(
  confusable: DiscoveryPair[],
  candidate: DiscoveryPair[],
  crossScript: CrossScriptPair[],
  fontQuery: string,
  threshold: number,
): FontPairResult[] {
  const results: FontPairResult[] = [];

  function scanDiscoveryPairs(pairs: DiscoveryPair[], dataSource: 'tr39' | 'novel') {
    for (const pair of pairs) {
      // Find the best matching font entry for this pair
      let best: DiscoveryFontEntry | null = null;
      for (const f of pair.fonts) {
        if (f.ssim === null) continue;
        if (!fontMatches(f.sourceFont, fontQuery) && !fontMatches(f.targetFont, fontQuery)) continue;
        if (best === null || f.ssim > (best.ssim ?? -Infinity)) {
          best = f;
        }
      }
      if (best === null || best.ssim === null) continue;
      if (best.ssim < threshold) continue;

      results.push({
        source: pair.source,
        sourceCodepoint: pair.sourceCodepoint,
        target: pair.target,
        ssim: best.ssim,
        pHash: best.pHash,
        renderStatus: best.sourceRenderStatus,
        fallbackFont: best.sourceFallbackFont,
        sourceFont: best.sourceFont,
        targetFont: best.targetFont,
        dataSource,
      });
    }
  }

  scanDiscoveryPairs(confusable, 'tr39');
  scanDiscoveryPairs(candidate, 'novel');

  // Cross-script: only bestFont available
  for (const pair of crossScript) {
    if (!fontMatches(pair.bestFont.sourceFont, fontQuery) &&
        !fontMatches(pair.bestFont.targetFont, fontQuery)) continue;
    if (pair.bestFont.ssim < threshold) continue;

    results.push({
      source: pair.charA,
      sourceCodepoint: pair.codepointA,
      target: pair.charB,
      ssim: pair.bestFont.ssim,
      pHash: pair.bestFont.pHash,
      renderStatus: 'native', // cross-script doesn't store render status
      fallbackFont: null,
      sourceFont: pair.bestFont.sourceFont,
      targetFont: pair.bestFont.targetFont,
      dataSource: 'cross-script',
    });
  }

  results.sort((a, b) => b.ssim - a.ssim);
  return results;
}

// --- List all fonts ---

function collectAllFonts(
  confusable: DiscoveryPair[],
  candidate: DiscoveryPair[],
  crossScript: CrossScriptPair[],
): string[] {
  const fonts = new Set<string>();

  for (const pairs of [confusable, candidate]) {
    for (const pair of pairs) {
      for (const f of pair.fonts) {
        fonts.add(f.sourceFont);
        fonts.add(f.targetFont);
      }
    }
  }

  for (const pair of crossScript) {
    fonts.add(pair.bestFont.sourceFont);
    fonts.add(pair.bestFont.targetFont);
  }

  return [...fonts].sort((a, b) => a.localeCompare(b));
}

// --- Output formatting ---

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function formatTable(results: FontPairResult[], fontQuery: string, threshold: number, totalPairs: number) {
  console.log(`\nConfusable pairs for "${fontQuery}" (threshold >= ${threshold})`);
  console.log(`${results.length} pairs above threshold (of ${totalPairs} total in data)\n`);

  if (results.length === 0) {
    console.log('  No pairs found. Try a lower --threshold or check --list-fonts for available font names.');
    return;
  }

  // Header
  console.log(
    `  ${padRight('Source', 10)} ${padRight('Target', 8)} ${padLeft('SSIM', 6)} ${padLeft('pHash', 6)}  ${padRight('Render', 9)} ${padRight('Type', 13)}`
  );
  console.log(`  ${'-'.repeat(10)} ${'-'.repeat(8)} ${'-'.repeat(6)} ${'-'.repeat(6)}  ${'-'.repeat(9)} ${'-'.repeat(13)}`);

  for (const r of results) {
    const ssimStr = r.ssim.toFixed(4);
    const pHashStr = r.pHash !== null ? r.pHash.toFixed(3) : '  --';
    const renderStr = r.renderStatus === 'fallback'
      ? `fb:${r.fallbackFont ?? '?'}`
      : r.renderStatus;
    console.log(
      `  ${padRight(`${r.sourceCodepoint} ${r.source}`, 10)} ${padRight(`-> ${r.target}`, 8)} ${padLeft(ssimStr, 6)} ${padLeft(pHashStr, 6)}  ${padRight(renderStr, 9)} ${padRight(r.dataSource, 13)}`
    );
  }
}

function formatCompareTable(
  resultsA: FontPairResult[],
  resultsB: FontPairResult[],
  fontA: string,
  fontB: string,
  threshold: number,
) {
  // Build lookup by pair key
  const keyOf = (r: FontPairResult) => `${r.sourceCodepoint}:${r.target}`;

  const mapA = new Map<string, FontPairResult>();
  for (const r of resultsA) mapA.set(keyOf(r), r);

  const mapB = new Map<string, FontPairResult>();
  for (const r of resultsB) mapB.set(keyOf(r), r);

  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

  interface CompareRow {
    source: string;
    sourceCodepoint: string;
    target: string;
    ssimA: number | null;
    ssimB: number | null;
    delta: number | null; // A - B, null if one side missing
    absDelta: number;
    note: string;
  }

  const rows: CompareRow[] = [];
  for (const key of allKeys) {
    const a = mapA.get(key) ?? null;
    const b = mapB.get(key) ?? null;

    const ssimA = a?.ssim ?? null;
    const ssimB = b?.ssim ?? null;

    let delta: number | null = null;
    let absDelta = 0;
    let note = '';

    if (ssimA !== null && ssimB !== null) {
      delta = ssimA - ssimB;
      absDelta = Math.abs(delta);
      if (delta > 0.01) note = `more confusable in ${fontA}`;
      else if (delta < -0.01) note = `more confusable in ${fontB}`;
    } else if (ssimA !== null) {
      absDelta = ssimA;
      note = `${fontA} only`;
    } else if (ssimB !== null) {
      absDelta = ssimB;
      note = `${fontB} only`;
    }

    rows.push({
      source: (a ?? b)!.source,
      sourceCodepoint: (a ?? b)!.sourceCodepoint,
      target: (a ?? b)!.target,
      ssimA,
      ssimB,
      delta,
      absDelta,
      note,
    });
  }

  // Sort by absolute delta descending (biggest differences first)
  rows.sort((a, b) => b.absDelta - a.absDelta);

  console.log(`\nFont comparison: "${fontA}" vs "${fontB}" (threshold >= ${threshold})`);
  console.log(`${fontA}: ${resultsA.length} pairs | ${fontB}: ${resultsB.length} pairs | combined: ${rows.length}\n`);

  if (rows.length === 0) {
    console.log('  No pairs found for either font above threshold.');
    return;
  }

  // Truncate long font names for column headers
  const colA = fontA.length > 8 ? fontA.slice(0, 8) : fontA;
  const colB = fontB.length > 8 ? fontB.slice(0, 8) : fontB;

  console.log(
    `  ${padRight('Source', 10)} ${padRight('Target', 8)} ${padLeft(colA, 8)} ${padLeft(colB, 8)} ${padLeft('Delta', 7)}  ${padRight('Notes', 30)}`
  );
  console.log(
    `  ${'-'.repeat(10)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(7)}  ${'-'.repeat(30)}`
  );

  for (const r of rows) {
    const aStr = r.ssimA !== null ? r.ssimA.toFixed(4) : '    --';
    const bStr = r.ssimB !== null ? r.ssimB.toFixed(4) : '    --';
    const dStr = r.delta !== null
      ? (r.delta >= 0 ? '+' : '') + r.delta.toFixed(3)
      : '     --';

    console.log(
      `  ${padRight(`${r.sourceCodepoint} ${r.source}`, 10)} ${padRight(`-> ${r.target}`, 8)} ${padLeft(aStr, 8)} ${padLeft(bStr, 8)} ${padLeft(dStr, 7)}  ${r.note}`
    );
  }
}

// --- CLI ---

function printUsage() {
  console.log(`Usage:
  npx tsx scripts/query-font.ts <font-name>
  npx tsx scripts/query-font.ts <font-name> --threshold <n>
  npx tsx scripts/query-font.ts <font-name> --compare <font-name>
  npx tsx scripts/query-font.ts <font-name> --json
  npx tsx scripts/query-font.ts --list-fonts`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  // Parse flags
  const listFonts = args.includes('--list-fonts');
  const jsonOutput = args.includes('--json');

  let threshold = DEFAULT_THRESHOLD;
  const threshIdx = args.indexOf('--threshold');
  if (threshIdx !== -1 && args[threshIdx + 1]) {
    threshold = parseFloat(args[threshIdx + 1]!);
    if (isNaN(threshold)) {
      console.error('Invalid --threshold value');
      process.exit(1);
    }
  }

  let compareFont: string | null = null;
  const compareIdx = args.indexOf('--compare');
  if (compareIdx !== -1 && args[compareIdx + 1]) {
    compareFont = args[compareIdx + 1]!;
  }

  // Font name is the first positional arg (not a flag)
  let fontQuery: string | null = null;
  for (const arg of args) {
    if (arg.startsWith('--')) break;
    fontQuery = arg;
    break;
  }

  // Load data
  const confusableData = loadDiscoveryFile(CONFUSABLE_PATH);
  const candidateData = loadDiscoveryFile(CANDIDATE_PATH);
  const crossScriptData = loadCrossScriptFile(CROSS_SCRIPT_PATH);

  const confusable = confusableData?.pairs ?? [];
  const candidate = candidateData?.pairs ?? [];
  const crossScript = crossScriptData?.pairs ?? [];

  const filesLoaded: string[] = [];
  if (confusableData) filesLoaded.push(`confusable-discoveries.json (${confusable.length} pairs)`);
  if (candidateData) filesLoaded.push(`candidate-discoveries.json (${candidate.length} pairs)`);
  if (crossScriptData) filesLoaded.push(`cross-script-discoveries.json (${crossScript.length} pairs)`);

  if (filesLoaded.length === 0) {
    console.error('No discovery files found in data/output/.');
    console.error('Run the scoring pipeline first (npm run score-all-pairs, etc.).');
    process.exit(1);
  }

  console.log(`[data] Loaded: ${filesLoaded.join(', ')}`);

  const totalPairs = confusable.length + candidate.length + crossScript.length;

  // --list-fonts
  if (listFonts) {
    const fonts = collectAllFonts(confusable, candidate, crossScript);
    console.log(`\n${fonts.length} fonts found in discovery data:\n`);
    for (const f of fonts) {
      console.log(`  ${f}`);
    }
    return;
  }

  if (!fontQuery) {
    console.error('No font name provided. Use --list-fonts to see available fonts.');
    printUsage();
    process.exit(1);
  }

  // Single font query
  const results = queryFont(confusable, candidate, crossScript, fontQuery, threshold);

  if (compareFont) {
    // Compare mode
    const resultsB = queryFont(confusable, candidate, crossScript, compareFont, threshold);

    if (jsonOutput) {
      console.log(JSON.stringify({
        fontA: fontQuery,
        fontB: compareFont,
        threshold,
        pairsA: results.length,
        pairsB: resultsB.length,
        resultsA: results,
        resultsB: resultsB,
      }, null, 2));
    } else {
      formatCompareTable(results, resultsB, fontQuery, compareFont, threshold);
    }
  } else {
    // Single font mode
    if (jsonOutput) {
      console.log(JSON.stringify({
        font: fontQuery,
        threshold,
        pairCount: results.length,
        totalPairsInData: totalPairs,
        results,
      }, null, 2));
    } else {
      formatTable(results, fontQuery, threshold, totalPairs);
    }
  }
}

main();
