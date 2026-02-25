/**
 * detect-glyph-reuse.ts
 *
 * For same-font pairs with SSIM >= 0.999, check if both codepoints map to the
 * same glyph ID in the font's cmap table. Splits "pixel-identical" into
 * "glyph-reuse" (same glyph ID, intentional) vs "raster-coincidence"
 * (different glyph IDs, accidental outline match).
 *
 * Uses fontkit for cmap lookups because it supports TTC collections natively,
 * unlike opentype.js.
 *
 * Output:
 *   data/output/confusable-glyph-reuse.json   (TR39 pairs)
 *   data/output/candidate-glyph-reuse.json    (novel pairs)
 *
 * Usage: npx tsx scripts/detect-glyph-reuse.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as fontkit from 'fontkit';
import type { GlyphReuseCheck, GlyphReuseSummary } from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONFUSABLE_PATH = path.join(ROOT, 'data/output/confusable-discoveries.json');
const CANDIDATE_PATH = path.join(ROOT, 'data/output/candidate-discoveries.json');
const OUTPUT_CONFUSABLE = path.join(ROOT, 'data/output/confusable-glyph-reuse.json');
const OUTPUT_CANDIDATE = path.join(ROOT, 'data/output/candidate-glyph-reuse.json');

const SSIM_THRESHOLD = 0.999;

/** Cache opened font objects to avoid repeated disk reads */
const fontCache = new Map<string, ReturnType<typeof fontkit.openSync> | null>();

/** Font family -> file path lookup, built once from fc-list */
let fontPathMap: Map<string, string> | null = null;

/**
 * Build a font family -> file path map using fc-list.
 * Groups by family, picks best path (Regular weight preferred).
 */
function buildFontPathMap(): Map<string, string> {
  if (fontPathMap) return fontPathMap;

  const output = execFileSync('fc-list', [
    '--format=%{file}|%{family[0]}\n',
  ], { encoding: 'utf-8', timeout: 15000 });

  const familyPaths = new Map<string, string[]>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.indexOf('|');
    if (sepIdx < 0) continue;
    const filePath = trimmed.slice(0, sepIdx).trim();
    const family = trimmed.slice(sepIdx + 1).trim();
    if (!filePath || !family) continue;

    if (!familyPaths.has(family)) familyPaths.set(family, []);
    familyPaths.get(family)!.push(filePath);
  }

  fontPathMap = new Map<string, string>();
  for (const [family, paths] of familyPaths) {
    // Prefer Regular weight, prefer .ttf/.otf over .ttc
    const best = [...paths].sort((a, b) => {
      const aWeight = /Bold|Italic/i.test(path.basename(a)) ? 1 : 0;
      const bWeight = /Bold|Italic/i.test(path.basename(b)) ? 1 : 0;
      if (aWeight !== bWeight) return aWeight - bWeight;
      const aTtc = a.endsWith('.ttc') ? 1 : 0;
      const bTtc = b.endsWith('.ttc') ? 1 : 0;
      return aTtc - bTtc;
    })[0]!;
    fontPathMap.set(family, best);
  }

  console.log(`  [fc-list] ${fontPathMap.size} font families mapped`);
  return fontPathMap;
}

/**
 * Open a font file with fontkit, returning the first face.
 * Handles TTC collections by selecting face 0.
 */
function openFont(fontPath: string): ReturnType<typeof fontkit.openSync> | null {
  if (fontCache.has(fontPath)) return fontCache.get(fontPath)!;

  try {
    let font = fontkit.openSync(fontPath);
    // TTC collection: use face 0
    if ('fonts' in font && Array.isArray((font as any).fonts)) {
      font = (font as any).fonts[0];
    }
    fontCache.set(fontPath, font);
    return font;
  } catch {
    fontCache.set(fontPath, null);
    return null;
  }
}

/**
 * Get the glyph ID for a codepoint in a font. Returns null if .notdef (ID 0).
 */
function getGlyphId(font: ReturnType<typeof fontkit.openSync>, codepoint: number): number | null {
  try {
    const glyph = font.glyphForCodePoint(codepoint);
    return glyph.id === 0 ? null : glyph.id;
  } catch {
    return null;
  }
}

interface DiscoveryPair {
  source: string;
  sourceCodepoint: string;
  target: string;
  fonts: Array<{
    sourceFont: string;
    targetFont: string;
    ssim: number | null;
    pHash: number | null;
    sourceRenderStatus: string;
    sourceFallbackFont: string | null;
    ssimSkipped: boolean;
  }>;
}

/**
 * Process a set of discovery pairs and check glyph reuse for pixel-identical ones.
 */
function processDiscoveries(pairs: DiscoveryPair[]): GlyphReuseSummary[] {
  const pathMap = buildFontPathMap();
  const results: GlyphReuseSummary[] = [];

  for (const pair of pairs) {
    const srcCp = parseInt(pair.sourceCodepoint.slice(2), 16);
    const tgtCp = pair.target.codePointAt(0)!;

    // Filter to same-font comparisons with SSIM >= threshold
    const sameFontHigh = pair.fonts.filter(f =>
      f.sourceFont === f.targetFont &&
      f.ssim !== null &&
      f.ssim >= SSIM_THRESHOLD
    );

    if (sameFontHigh.length === 0) {
      // No pixel-identical same-font comparisons; still emit entry
      results.push({
        source: pair.source,
        sourceCodepoint: pair.sourceCodepoint,
        target: pair.target,
        checkedCount: 0,
        glyphReuseCount: 0,
        rasterCoincidenceCount: 0,
        glyphReuse: false,
        fonts: [],
      });
      continue;
    }

    const checks: GlyphReuseCheck[] = [];
    let glyphReuseCount = 0;
    let rasterCoincidenceCount = 0;

    for (const comp of sameFontHigh) {
      const fontPath = pathMap.get(comp.sourceFont);
      if (!fontPath) continue;

      const font = openFont(fontPath);
      if (!font) continue;

      const srcGlyph = getGlyphId(font, srcCp);
      const tgtGlyph = getGlyphId(font, tgtCp);

      const isReuse = srcGlyph !== null && tgtGlyph !== null && srcGlyph === tgtGlyph;
      if (isReuse) glyphReuseCount++;
      else rasterCoincidenceCount++;

      checks.push({
        font: comp.sourceFont,
        fontPath,
        sourceGlyphId: srcGlyph,
        targetGlyphId: tgtGlyph,
        glyphReuse: isReuse,
      });
    }

    results.push({
      source: pair.source,
      sourceCodepoint: pair.sourceCodepoint,
      target: pair.target,
      checkedCount: checks.length,
      glyphReuseCount,
      rasterCoincidenceCount,
      glyphReuse: glyphReuseCount > 0,
      fonts: checks,
    });
  }

  return results;
}

function main() {
  console.log('detect-glyph-reuse: loading discoveries...\n');

  const confusable = JSON.parse(fs.readFileSync(CONFUSABLE_PATH, 'utf-8'));
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE_PATH, 'utf-8'));

  console.log(`  TR39 pairs: ${confusable.pairs.length}`);
  console.log(`  Novel pairs: ${candidate.pairs.length}\n`);

  // Process TR39 pairs
  console.log('Processing TR39 pairs...');
  const confusableResults = processDiscoveries(confusable.pairs);

  // Process novel pairs
  console.log('Processing novel pairs...');
  const candidateResults = processDiscoveries(candidate.pairs);

  // Write outputs
  fs.writeFileSync(OUTPUT_CONFUSABLE, JSON.stringify(confusableResults, null, 2));
  fs.writeFileSync(OUTPUT_CANDIDATE, JSON.stringify(candidateResults, null, 2));

  // Summary
  const confusableReuse = confusableResults.filter(r => r.glyphReuse);
  const confusableRaster = confusableResults.filter(r => r.checkedCount > 0 && !r.glyphReuse);
  const confusableNone = confusableResults.filter(r => r.checkedCount === 0);
  const candidateReuse = candidateResults.filter(r => r.glyphReuse);
  const candidateRaster = candidateResults.filter(r => r.checkedCount > 0 && !r.glyphReuse);
  const candidateNone = candidateResults.filter(r => r.checkedCount === 0);

  console.log('\n=== TR39 Pairs (110) ===');
  console.log(`  Glyph reuse:        ${confusableReuse.length}`);
  console.log(`  Raster coincidence: ${confusableRaster.length}`);
  console.log(`  No pixel-identical: ${confusableNone.length}`);

  console.log('\n=== Novel Pairs (793) ===');
  console.log(`  Glyph reuse:        ${candidateReuse.length}`);
  console.log(`  Raster coincidence: ${candidateRaster.length}`);
  console.log(`  No pixel-identical: ${candidateNone.length}`);

  if (confusableReuse.length > 0) {
    console.log('\nGlyph-reuse TR39 pairs:');
    for (const r of confusableReuse.slice(0, 10)) {
      console.log(`  ${r.sourceCodepoint} ${r.source} -> ${r.target}  (${r.glyphReuseCount} fonts)`);
    }
  }

  if (candidateReuse.length > 0) {
    console.log('\nGlyph-reuse novel pairs:');
    for (const r of candidateReuse.slice(0, 10)) {
      console.log(`  ${r.sourceCodepoint} ${r.source} -> ${r.target}  (${r.glyphReuseCount} fonts)`);
    }
  }

  console.log(`\nWritten: ${OUTPUT_CONFUSABLE}`);
  console.log(`Written: ${OUTPUT_CANDIDATE}`);
  console.log(`\nFonts cached: ${fontCache.size}`);
}

main();
