/**
 * build-index-cross-script.ts -- Milestone 5, Step 2
 *
 * Renders every character from all 12 ICANN script families in every
 * font that covers it, computes pHash per render.
 *
 * Output is per-script:
 *   data/output/cross-script-index/{Script}/index.json
 *   data/output/cross-script-index/{Script}/renders/
 *
 * Each script directory has its own progress.jsonl for resume capability.
 *
 * Prerequisite:
 *   npx tsx scripts/define-cross-script-sets.ts
 *
 * Usage:
 *   npx tsx scripts/build-index-cross-script.ts             # fresh or auto-resume
 *   npx tsx scripts/build-index-cross-script.ts --fresh      # force fresh start
 *   npx tsx scripts/build-index-cross-script.ts --script Han # single script only
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initFonts, queryFontCoverage, discoverFontForCodepoint } from '../src/fonts.js';
import { renderCharacter } from '../src/renderer.js';
import { normaliseImage, decodeAndFindBounds, getInkWidth } from '../src/normalise-image.js';
import { computePHash } from '../src/compare.js';
import type {
  FontEntry,
  RenderIndex,
  IndexRenderEntry,
} from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SETS_INPUT = path.join(ROOT, 'data/output/cross-script-sets.json');
const INDEX_ROOT = path.join(ROOT, 'data/output/cross-script-index');

const FORCE_FRESH = process.argv.includes('--fresh');
const SINGLE_SCRIPT = (() => {
  const idx = process.argv.indexOf('--script');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

// ---------------------------------------------------------------------------
// Types for the input JSON
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

interface CrossScriptSetsInput {
  meta: { generatedAt: string; scriptsCount: number; totalCharacters: number };
  scripts: Record<string, ScriptSet>;
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

function loadProgress(progressPath: string): Map<string, IndexRenderEntry[]> {
  const completed = new Map<string, IndexRenderEntry[]>();
  if (!fs.existsSync(progressPath)) return completed;

  const lines = fs.readFileSync(progressPath, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      completed.set(obj.char, obj.entries);
    } catch {
      console.log('  Skipping corrupt progress line');
    }
  }
  return completed;
}

// ---------------------------------------------------------------------------
// Render one script
// ---------------------------------------------------------------------------

async function buildScriptIndex(
  scriptName: string,
  scriptSet: ScriptSet,
  availableFonts: FontEntry[],
  standardFonts: FontEntry[],
  allFonts: FontEntry[],
): Promise<void> {
  const scriptDir = path.join(INDEX_ROOT, scriptName);
  const rendersDir = path.join(scriptDir, 'renders');
  const indexJson = path.join(scriptDir, 'index.json');
  const progressPath = path.join(scriptDir, 'progress.jsonl');

  console.log(`\n--- ${scriptName} (${scriptSet.characterCount} characters) ---`);
  const t0 = Date.now();

  const chars = scriptSet.characters;

  // Query fontconfig coverage
  console.log('  Querying fontconfig coverage...');
  const coverageStart = Date.now();
  const coverageMap = new Map<string, FontEntry[]>();
  let totalCoverageEntries = 0;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i].char;
    const codepoint = char.codePointAt(0)!;

    let covered = queryFontCoverage(codepoint, availableFonts);

    if (covered.length === 0) {
      const discovered = discoverFontForCodepoint(codepoint);
      if (discovered) {
        covered = [discovered];
      }
    }

    coverageMap.set(char, covered);
    totalCoverageEntries += covered.length;

    if (i > 0 && i % 5000 === 0) {
      console.log(`  [${i}/${chars.length}] fontconfig queried`);
    }
  }

  const coverageElapsed = ((Date.now() - coverageStart) / 1000).toFixed(1);
  const avgFonts = chars.length > 0
    ? (totalCoverageEntries / chars.length).toFixed(1)
    : '0';
  console.log(`  ${chars.length} characters queried in ${coverageElapsed}s (avg ${avgFonts} fonts/char)`);
  console.log(`  ${totalCoverageEntries} total render jobs`);

  // Check for resume
  let completedSources: Map<string, IndexRenderEntry[]>;

  if (FORCE_FRESH || !fs.existsSync(progressPath)) {
    if (fs.existsSync(rendersDir)) {
      fs.rmSync(rendersDir, { recursive: true });
    }
    if (fs.existsSync(progressPath)) {
      fs.unlinkSync(progressPath);
    }
    completedSources = new Map();
    console.log('  Rendering (fresh start)...');
  } else {
    completedSources = loadProgress(progressPath);
    console.log(`  Rendering (resuming: ${completedSources.size}/${chars.length} done)...`);
  }
  fs.mkdirSync(rendersDir, { recursive: true });

  const progressFd = fs.openSync(progressPath, 'a');
  const sources: Record<string, IndexRenderEntry[]> = {};
  const renderStart = Date.now();
  let notdefCount = 0;
  let newRenders = 0;
  let totalRenders = 0;
  let skippedResume = 0;

  for (let i = 0; i < chars.length; i++) {
    const { char, codepoint } = chars[i];
    const hex = codepoint.replace('U+', '');

    // Resume: skip already-completed characters
    if (completedSources.has(char)) {
      sources[char] = completedSources.get(char)!;
      totalRenders += sources[char].length;
      skippedResume++;
      continue;
    }

    if ((i - skippedResume) > 0 && (i - skippedResume) % 500 === 0) {
      const elapsed = (Date.now() - renderStart) / 1000;
      const rendered = i - skippedResume;
      const rate = rendered / elapsed;
      const remaining = chars.length - i;
      const eta = Math.round(remaining / rate);
      console.log(`  [${i}/${chars.length}] ${newRenders} renders -- ${rate.toFixed(0)} chars/s, ETA ${eta}s`);
    }

    const coverageFonts = coverageMap.get(char) ?? [];

    if (coverageFonts.length === 0) {
      sources[char] = [];
      fs.writeSync(progressFd, JSON.stringify({ char, entries: [] }) + '\n');
      continue;
    }

    const entries: IndexRenderEntry[] = [];

    for (const font of coverageFonts) {
      const result = renderCharacter(char, font.family);
      if (!result) {
        notdefCount++;
        continue;
      }

      const rawDecoded = await decodeAndFindBounds(result.pngBuffer);
      const inkWidth = getInkWidth(rawDecoded);
      const inkHeight = rawDecoded.bounds
        ? rawDecoded.bounds.bottom - rawDecoded.bounds.top + 1
        : null;

      const norm = await normaliseImage(result.pngBuffer);
      const hash = await computePHash(norm.rawPixels, norm.width, norm.height);
      const safeName = font.family.replace(/\s+/g, '-');
      const filename = `${hex}_${safeName}.png`;
      fs.writeFileSync(path.join(rendersDir, filename), norm.pngBuffer);

      entries.push({
        font: font.family,
        category: font.category,
        pHash: hash.toString(16).padStart(16, '0'),
        renderStatus: 'native',
        fallbackFont: null,
        png: filename,
        inkWidth,
        inkHeight,
      });
      newRenders++;
    }

    sources[char] = entries;
    totalRenders += entries.length;

    fs.writeSync(progressFd, JSON.stringify({ char, entries }) + '\n');
  }

  fs.closeSync(progressFd);

  const renderElapsed = ((Date.now() - renderStart) / 1000).toFixed(1);
  console.log(`  ${chars.length} characters processed in ${renderElapsed}s`);
  if (skippedResume > 0) {
    console.log(`  ${skippedResume} skipped (resumed), ${chars.length - skippedResume} rendered`);
  }
  console.log(`  ${newRenders} new renders, ${notdefCount} notdef`);

  // Write index
  const index: RenderIndex = {
    meta: {
      generatedAt: new Date().toISOString(),
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      renderSize: 48,
      fontsAvailable: availableFonts.length,
      fontsTotal: allFonts.length,
      standardFonts: standardFonts.map(f => f.family),
      sourceCharCount: chars.length,
      targetCharCount: 0, // no separate targets in cross-script mode
      totalRenders,
    },
    sources,
    targets: {}, // cross-script has no source/target distinction
  };

  fs.writeFileSync(indexJson, JSON.stringify(index));
  console.log(`  Index: ${indexJson} (${totalRenders} renders)`);

  // Clean up progress on success
  if (fs.existsSync(progressPath)) {
    fs.unlinkSync(progressPath);
  }

  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Done in ${totalElapsed}s`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== confusable-vision: build-index-cross-script (Milestone 5) ===\n');
  const t0 = Date.now();

  // Load character sets
  if (!fs.existsSync(SETS_INPUT)) {
    console.error(`ERROR: ${SETS_INPUT} not found. Run define-cross-script-sets.ts first.`);
    process.exit(1);
  }
  const setsData: CrossScriptSetsInput = JSON.parse(fs.readFileSync(SETS_INPUT, 'utf-8'));
  console.log(`Loaded ${setsData.meta.scriptsCount} scripts, ${setsData.meta.totalCharacters} characters\n`);

  // Init fonts
  console.log('Initialising fonts...');
  const allFonts = initFonts();
  const availableFonts = allFonts.filter(f => f.available);
  const standardFonts = availableFonts.filter(f => f.category === 'standard');
  console.log(`  ${availableFonts.length} available (${standardFonts.length} standard)\n`);

  fs.mkdirSync(INDEX_ROOT, { recursive: true });

  // Determine which scripts to process
  const scriptNames = SINGLE_SCRIPT
    ? [SINGLE_SCRIPT]
    : Object.keys(setsData.scripts);

  if (SINGLE_SCRIPT && !setsData.scripts[SINGLE_SCRIPT]) {
    console.error(`ERROR: Unknown script "${SINGLE_SCRIPT}". Available: ${Object.keys(setsData.scripts).join(', ')}`);
    process.exit(1);
  }

  // Process each script
  for (const scriptName of scriptNames) {
    const scriptSet = setsData.scripts[scriptName];

    // Check if already completed (index exists and no progress file)
    const scriptDir = path.join(INDEX_ROOT, scriptName);
    const indexJson = path.join(scriptDir, 'index.json');
    const progressPath = path.join(scriptDir, 'progress.jsonl');

    if (!FORCE_FRESH && fs.existsSync(indexJson) && !fs.existsSync(progressPath)) {
      console.log(`\n--- ${scriptName}: already complete, skipping ---`);
      continue;
    }

    await buildScriptIndex(scriptName, scriptSet, availableFonts, standardFonts, allFonts);
  }

  // Write top-level meta
  const metaPath = path.join(INDEX_ROOT, 'meta.json');
  const scriptSummary: Record<string, { characterCount: number; indexExists: boolean }> = {};
  for (const name of Object.keys(setsData.scripts)) {
    const indexPath = path.join(INDEX_ROOT, name, 'index.json');
    scriptSummary[name] = {
      characterCount: setsData.scripts[name].characterCount,
      indexExists: fs.existsSync(indexPath),
    };
  }
  fs.writeFileSync(metaPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    scripts: scriptSummary,
  }, null, 2));

  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== All scripts processed in ${totalElapsed}s ===`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
