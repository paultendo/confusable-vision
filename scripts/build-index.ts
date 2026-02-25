/**
 * build-index.ts -- Build the render index
 *
 * Renders all source and target characters from confusable-pairs.json in fonts
 * that natively contain them. Uses fontconfig (fc-list) to query glyph coverage
 * upfront, so we only render in fonts that actually have the character -- no
 * brute-force rendering, no pixel deduplication, no Pango silent fallback.
 *
 * This is the expensive step (renders + image processing). The scoring step
 * (score-all-pairs.ts) loads the index and does pure SSIM/pHash computation,
 * making it fast to re-run with different parameters.
 *
 * Output:
 *   data/output/render-index/index.json  -- metadata, pHash, render status
 *   data/output/render-index/renders/    -- normalised 48x48 greyscale PNGs
 *
 * With --candidates flag (Milestone 2):
 *   data/output/candidate-index/index.json
 *   data/output/candidate-index/renders/
 *
 * Usage:
 *   npx tsx scripts/build-index.ts              # Milestone 1b index
 *   npx tsx scripts/build-index.ts --candidates # Milestone 2 candidate index
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initFonts, queryFontCoverage, discoverFontForCodepoint } from '../src/fonts.js';
import { renderCharacter } from '../src/renderer.js';
import { normaliseImage } from '../src/normalise-image.js';
import { computePHash } from '../src/compare.js';
import type {
  ConfusablePair,
  RenderIndex,
  IndexRenderEntry,
} from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONFUSABLE_INPUT_PATH = path.join(ROOT, 'data/input/confusable-pairs.json');
const CANDIDATES_INPUT_PATH = path.join(ROOT, 'data/output/candidates.json');

const CANDIDATES_MODE = process.argv.includes('--candidates');

// Output directories depend on mode
const INDEX_DIR = path.join(ROOT, CANDIDATES_MODE
  ? 'data/output/candidate-index'
  : 'data/output/render-index');
const RENDERS_DIR = path.join(INDEX_DIR, 'renders');
const INDEX_JSON = path.join(INDEX_DIR, 'index.json');

interface CandidateEntry {
  codepoint: string;
  char: string;
  name: string;
  generalCategory: string;
  script: string;
  fontCoverage: number;
}

async function main() {
  const modeLabel = CANDIDATES_MODE ? 'build-index --candidates (Milestone 2)' : 'build-index';
  console.log(`=== confusable-vision: ${modeLabel} ===\n`);
  const t0 = Date.now();

  // 1. Init fonts
  console.log('[1/5] Initialising fonts...');
  const fonts = initFonts();
  const availableFonts = fonts.filter(f => f.available);
  const standardFonts = availableFonts.filter(f => f.category === 'standard');

  console.log(`  Standard: ${standardFonts.length}, Non-standard: ${availableFonts.length - standardFonts.length}\n`);

  // 2. Load character set (different sources for each mode)
  console.log('[2/5] Loading character set...');

  let uniqueSources: string[];
  let uniqueTargets: string[];
  const codepointMap = new Map<string, string>();

  if (CANDIDATES_MODE) {
    // Milestone 2: load candidates.json
    if (!fs.existsSync(CANDIDATES_INPUT_PATH)) {
      console.error(`ERROR: ${CANDIDATES_INPUT_PATH} not found. Run build-candidates.ts first.`);
      process.exit(1);
    }
    const candidates: CandidateEntry[] = JSON.parse(fs.readFileSync(CANDIDATES_INPUT_PATH, 'utf-8'));
    uniqueSources = candidates.map(c => c.char);
    for (const c of candidates) {
      codepointMap.set(c.char, c.codepoint.replace('U+', ''));
    }

    // Targets are Latin a-z and 0-9
    uniqueTargets = [];
    for (let cp = 0x61; cp <= 0x7A; cp++) uniqueTargets.push(String.fromCodePoint(cp));
    for (let cp = 0x30; cp <= 0x39; cp++) uniqueTargets.push(String.fromCodePoint(cp));
    for (const t of uniqueTargets) {
      codepointMap.set(t, t.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
    }
  } else {
    // Milestone 1b: load confusable-pairs.json
    if (!fs.existsSync(CONFUSABLE_INPUT_PATH)) {
      console.error(`ERROR: ${CONFUSABLE_INPUT_PATH} not found. Run fetch-confusables.ts first.`);
      process.exit(1);
    }
    const pairs: ConfusablePair[] = JSON.parse(fs.readFileSync(CONFUSABLE_INPUT_PATH, 'utf-8'));
    uniqueSources = [...new Set(pairs.map(p => p.source))];
    uniqueTargets = [...new Set(pairs.map(p => p.target))];
    for (const p of pairs) {
      codepointMap.set(p.source, p.sourceCodepoint.replace('U+', ''));
    }
    for (const t of uniqueTargets) {
      codepointMap.set(t, t.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
    }
  }

  console.log(`  ${uniqueSources.length} source characters, ${uniqueTargets.length} target characters\n`);

  // 3. Query fontconfig for coverage of all source characters
  console.log('[3/5] Querying fontconfig for font coverage...');
  const coverageStart = Date.now();
  const coverageMap = new Map<string, typeof availableFonts>();
  let totalCoverageEntries = 0;

  for (let i = 0; i < uniqueSources.length; i++) {
    const char = uniqueSources[i]!;
    const codepoint = char.codePointAt(0)!;

    let covered = queryFontCoverage(codepoint, availableFonts);

    // If no registered font covers this character, try to discover a system
    // font dynamically. This catches Indian script fonts (Tamil Sangam MN),
    // CJK fonts (for fullwidth Latin), Georgian, Ethiopic, etc.
    if (covered.length === 0) {
      const discovered = discoverFontForCodepoint(codepoint);
      if (discovered) {
        covered = [discovered];
      }
    }

    coverageMap.set(char, covered);
    totalCoverageEntries += covered.length;
  }

  const coverageElapsed = ((Date.now() - coverageStart) / 1000).toFixed(1);
  const avgFonts = (totalCoverageEntries / uniqueSources.length).toFixed(1);
  const zeroCoverage = [...coverageMap.values()].filter(v => v.length === 0).length;
  console.log(`  ${uniqueSources.length} characters queried in ${coverageElapsed}s`);
  console.log(`  Average ${avgFonts} fonts per character, ${zeroCoverage} with no coverage`);
  console.log(`  ${totalCoverageEntries} total render jobs (vs ${uniqueSources.length * availableFonts.length} brute-force)\n`);

  // 4. Ensure output dirs (clear old renders)
  if (fs.existsSync(RENDERS_DIR)) {
    fs.rmSync(RENDERS_DIR, { recursive: true });
  }
  fs.mkdirSync(RENDERS_DIR, { recursive: true });

  // 5. Render everything
  let totalRenders = 0;

  // 5a. Target characters in standard fonts only
  console.log('[4/5] Rendering target characters in standard fonts...');
  const targets: Record<string, IndexRenderEntry[]> = {};

  for (const char of uniqueTargets) {
    const hex = codepointMap.get(char)!;
    const entries: IndexRenderEntry[] = [];

    for (const font of standardFonts) {
      const result = renderCharacter(char, font.family);
      if (!result) continue;

      const norm = await normaliseImage(result.pngBuffer);
      const hash = await computePHash(norm.rawPixels, norm.width, norm.height);
      const safeName = font.family.replace(/\s+/g, '-');
      const filename = `tgt_${hex}_${safeName}.png`;
      fs.writeFileSync(path.join(RENDERS_DIR, filename), norm.pngBuffer);

      entries.push({
        font: font.family,
        category: font.category,
        pHash: hash.toString(16).padStart(16, '0'),
        renderStatus: 'native',
        fallbackFont: null,
        png: filename,
      });
      totalRenders++;
    }

    targets[char] = entries;
  }
  console.log(`  ${totalRenders} target renders\n`);

  // 5b. Source characters -- only in fonts that fontconfig says have the glyph.
  //
  // This is the key optimisation: instead of rendering every character in all
  // 111 fonts (where Pango silently falls back for ~90%), we queried fontconfig
  // upfront and only render in fonts that natively contain the character.
  // No pixel deduplication needed -- every render is genuine.
  console.log('[5/5] Rendering source characters (fontconfig-targeted)...');
  const sources: Record<string, IndexRenderEntry[]> = {};
  const sourceStart = Date.now();
  let notdefCount = 0;
  let sourceRenders = 0;

  for (let i = 0; i < uniqueSources.length; i++) {
    const char = uniqueSources[i]!;
    const hex = codepointMap.get(char)!;

    if (i > 0 && i % 200 === 0) {
      const elapsed = (Date.now() - sourceStart) / 1000;
      const rate = i / elapsed;
      const eta = Math.round((uniqueSources.length - i) / rate);
      console.log(`  [${i}/${uniqueSources.length}] ${sourceRenders} renders -- ${rate.toFixed(0)} chars/s, ETA ${eta}s`);
    }

    const coverageFonts = coverageMap.get(char) ?? [];

    if (coverageFonts.length === 0) {
      sources[char] = [];
      continue;
    }

    const entries: IndexRenderEntry[] = [];

    for (const font of coverageFonts) {
      const result = renderCharacter(char, font.family);
      if (!result) {
        // fontconfig said this font has the glyph, but renderCharacter
        // detected .notdef or Last Resort -- rare but possible
        notdefCount++;
        continue;
      }

      const norm = await normaliseImage(result.pngBuffer);
      const hash = await computePHash(norm.rawPixels, norm.width, norm.height);
      const safeName = font.family.replace(/\s+/g, '-');
      const filename = `src_${hex}_${safeName}.png`;
      fs.writeFileSync(path.join(RENDERS_DIR, filename), norm.pngBuffer);

      entries.push({
        font: font.family,
        category: font.category,
        pHash: hash.toString(16).padStart(16, '0'),
        renderStatus: 'native',
        fallbackFont: null,
        png: filename,
      });
      sourceRenders++;
    }

    sources[char] = entries;
    totalRenders += entries.length;
  }

  const sourceElapsed = ((Date.now() - sourceStart) / 1000).toFixed(1);
  console.log(`\n  ${uniqueSources.length} sources rendered in ${sourceElapsed}s`);
  console.log(`  ${sourceRenders} source renders, ${notdefCount} notdef (fontconfig/renderer disagreement)\n`);

  // 6. Write index
  const index: RenderIndex = {
    meta: {
      generatedAt: new Date().toISOString(),
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      renderSize: 48,
      fontsAvailable: availableFonts.length,
      fontsTotal: fonts.length,
      standardFonts: standardFonts.map(f => f.family),
      sourceCharCount: uniqueSources.length,
      targetCharCount: uniqueTargets.length,
      totalRenders,
    },
    sources,
    targets,
  };

  fs.writeFileSync(INDEX_JSON, JSON.stringify(index, null, 2));

  const renderFiles = fs.readdirSync(RENDERS_DIR).length;
  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Index written to: ${INDEX_JSON}`);
  console.log(`PNG renders: ${renderFiles} files in ${RENDERS_DIR}`);
  console.log(`Total time: ${totalElapsed}s`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
