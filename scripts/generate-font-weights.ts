/**
 * generate-font-weights.ts
 *
 * Generates per-font confusable weight maps from the discovery pipeline outputs.
 * Each font gets its own set of edges with font-specific SSIM scores, giving
 * apps precise coverage for their actual font stack.
 *
 * Groups by targetFont (the font rendering the Latin side), which captures the
 * realistic scenario: the target renders in the app's font, the source renders
 * in whatever the OS falls back to.
 *
 * Inputs:
 *   - confusable-discoveries.json (110 TR39 high-risk pairs)
 *   - candidate-discoveries.json (793 novel pairs)
 *   - confusable-discoveries-annotated.json (property flags)
 *   - candidate-discoveries-annotated.json (property flags)
 *
 * Output: data/output/font-specific-weights.json
 *
 * Usage: npx tsx scripts/generate-font-weights.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IdentifierProperties } from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data/output');

const CONFUSABLE_PATH = path.join(DATA, 'confusable-discoveries.json');
const CANDIDATE_PATH = path.join(DATA, 'candidate-discoveries.json');
const CONFUSABLE_ANNOTATED_PATH = path.join(DATA, 'confusable-discoveries-annotated.json');
const CANDIDATE_ANNOTATED_PATH = path.join(DATA, 'candidate-discoveries-annotated.json');
const OUTPUT_PATH = path.join(DATA, 'font-specific-weights.json');

const FONT_SET_ID = 'macos-m1-system-230fonts';
const SSIM_THRESHOLD = 0.7;

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
    nativeFontCount: number;
    fallbackFontCount: number;
    notdefFontCount: number;
    validFontCount: number;
  };
}

interface AnnotatedPair extends DiscoveryPair {
  properties: IdentifierProperties;
}

interface FontEdge {
  source: string;
  sourceCodepoint: string;
  target: string;
  ssim: number;
  sourceFont: string;
  dataSource: 'tr39' | 'novel';
  xidContinue: boolean;
  xidStart: boolean;
  idnaPvalid: boolean;
  tr39Allowed: boolean;
}

interface FontData {
  font: string;
  totalPairs: number;
  highRiskPairs: number;
  dangerRate: number;
  edges: FontEdge[];
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function main() {
  console.log('generate-font-weights: loading inputs...\n');

  const confusable = JSON.parse(fs.readFileSync(CONFUSABLE_PATH, 'utf-8'));
  const candidate = JSON.parse(fs.readFileSync(CANDIDATE_PATH, 'utf-8'));
  const confusableAnnotated = JSON.parse(fs.readFileSync(CONFUSABLE_ANNOTATED_PATH, 'utf-8'));
  const candidateAnnotated = JSON.parse(fs.readFileSync(CANDIDATE_ANNOTATED_PATH, 'utf-8'));

  console.log(`  TR39 pairs:  ${confusable.pairs.length}`);
  console.log(`  Novel pairs: ${candidate.pairs.length}`);

  // Build property lookup by sourceCodepoint:target
  const propLookup = new Map<string, IdentifierProperties>();
  for (const p of confusableAnnotated.pairs) {
    propLookup.set(`${p.sourceCodepoint}:${p.target}`, p.properties);
  }
  for (const p of candidateAnnotated.pairs) {
    propLookup.set(`${p.sourceCodepoint}:${p.target}`, p.properties);
  }

  // Group by targetFont. For each (targetFont, pair), keep the best SSIM.
  // fontMap: targetFont -> pairKey -> { bestSsim, bestSourceFont, pair metadata }
  const fontMap = new Map<string, Map<string, {
    source: string;
    sourceCodepoint: string;
    target: string;
    ssim: number;
    sourceFont: string;
    dataSource: 'tr39' | 'novel';
    properties: IdentifierProperties;
  }>>();

  function processPairs(pairs: DiscoveryPair[], dataSource: 'tr39' | 'novel') {
    for (const pair of pairs) {
      const pairKey = `${pair.sourceCodepoint}:${pair.target}`;
      const properties = propLookup.get(pairKey) ?? {
        xidStart: false, xidContinue: false, idnaPvalid: false, tr39Allowed: false,
      };

      for (const f of pair.fonts) {
        // Skip null SSIM and notdef renders
        if (f.ssim === null) continue;
        if (f.sourceRenderStatus === 'notdef') continue;

        const targetFont = f.targetFont;

        if (!fontMap.has(targetFont)) {
          fontMap.set(targetFont, new Map());
        }
        const pairMap = fontMap.get(targetFont)!;

        const existing = pairMap.get(pairKey);
        if (!existing || f.ssim > existing.ssim) {
          pairMap.set(pairKey, {
            source: pair.source,
            sourceCodepoint: pair.sourceCodepoint,
            target: pair.target,
            ssim: round(f.ssim),
            sourceFont: f.sourceFont,
            dataSource,
            properties,
          });
        }
      }
    }
  }

  processPairs(confusable.pairs as DiscoveryPair[], 'tr39');
  processPairs(candidate.pairs as DiscoveryPair[], 'novel');

  // Build the per-font output
  const totalUniquePairs = new Set<string>();
  const fonts: Record<string, FontData> = {};
  const sortedFontNames = [...fontMap.keys()].sort((a, b) => a.localeCompare(b));

  for (const fontName of sortedFontNames) {
    const pairMap = fontMap.get(fontName)!;

    const edges: FontEdge[] = [];
    let highRiskPairs = 0;

    for (const entry of pairMap.values()) {
      totalUniquePairs.add(`${entry.sourceCodepoint}:${entry.target}`);

      if (entry.ssim >= SSIM_THRESHOLD) {
        highRiskPairs++;
      }

      edges.push({
        source: entry.source,
        sourceCodepoint: entry.sourceCodepoint,
        target: entry.target,
        ssim: entry.ssim,
        sourceFont: entry.sourceFont,
        dataSource: entry.dataSource,
        xidContinue: entry.properties.xidContinue,
        xidStart: entry.properties.xidStart,
        idnaPvalid: entry.properties.idnaPvalid,
        tr39Allowed: entry.properties.tr39Allowed,
      });
    }

    // Sort edges by SSIM descending
    edges.sort((a, b) => b.ssim - a.ssim || a.sourceCodepoint.localeCompare(b.sourceCodepoint));

    fonts[fontName] = {
      font: fontName,
      totalPairs: pairMap.size,
      highRiskPairs,
      dangerRate: round(pairMap.size > 0 ? highRiskPairs / pairMap.size : 0),
      edges,
    };
  }

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      fontCount: sortedFontNames.length,
      totalUniquePairs: totalUniquePairs.size,
      ssimThreshold: SSIM_THRESHOLD,
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      fontSetId: FONT_SET_ID,
      licence: 'CC-BY-4.0',
      attribution: 'Paul Wood FRSA (@paultendo), confusable-vision',
    },
    fonts,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  // Summary stats
  console.log(`\n=== Font-Specific Weights Summary ===`);
  console.log(`  Fonts:              ${sortedFontNames.length}`);
  console.log(`  Total unique pairs: ${totalUniquePairs.size}`);
  console.log(`  SSIM threshold:     ${SSIM_THRESHOLD}`);

  // Top 10 by danger rate
  const byDangerRate = sortedFontNames
    .map(name => fonts[name]!)
    .sort((a, b) => b.dangerRate - a.dangerRate);

  console.log(`\n  Top 10 fonts by danger rate:`);
  for (const f of byDangerRate.slice(0, 10)) {
    console.log(`    ${f.font.padEnd(28)} ${f.highRiskPairs}/${f.totalPairs} pairs  (${(f.dangerRate * 100).toFixed(1)}%)`);
  }

  // Bottom 5
  console.log(`\n  Bottom 5 fonts by danger rate:`);
  for (const f of byDangerRate.slice(-5)) {
    console.log(`    ${f.font.padEnd(28)} ${f.highRiskPairs}/${f.totalPairs} pairs  (${(f.dangerRate * 100).toFixed(1)}%)`);
  }

  // Size comparison with universal map
  const universalEdgeCount = confusable.pairs.length + candidate.pairs.length;
  const medianPairCount = byDangerRate[Math.floor(byDangerRate.length / 2)]!.totalPairs;
  console.log(`\n  Universal map edges: ${universalEdgeCount}`);
  console.log(`  Median font pairs:  ${medianPairCount} (${(universalEdgeCount / medianPairCount).toFixed(0)}x reduction)`);

  const fileSize = fs.statSync(OUTPUT_PATH).size;
  console.log(`\nWritten: ${OUTPUT_PATH} (${(fileSize / 1024).toFixed(0)} KB)`);
}

main();
