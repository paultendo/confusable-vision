/**
 * score-intralatin.ts -- Generate intra-Latin character visual similarity matrix
 *
 * Renders all 36 basic characters (a-z, 0-9) across all available fonts,
 * computes pairwise SSIM for all 630 character pairs (same font), and
 * outputs aggregate statistics (mean, max, p95 SSIM across fonts).
 *
 * Output: data/output/intralatin-similarity.json
 *
 * Usage: npx tsx scripts/score-intralatin.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { renderCharacter } from '../src/renderer.js';
import { normaliseImage } from '../src/normalise-image.js';
import { computeSsimFast } from '../src/compare.js';
import { initFonts } from '../src/fonts.js';
import type { NormalisedResult } from '../src/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'data/output/intralatin-similarity.json');

const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

async function main() {
  console.log('=== Intra-Latin character visual similarity ===\n');

  // Load available fonts
  const fonts = initFonts();
  // Only use standard Latin fonts (not CJK, symbol, etc.)
  const latinFonts = fonts.filter(f => f.category === 'standard' || f.category === 'noto');
  console.log(`Fonts: ${fonts.length} total, ${latinFonts.length} Latin-capable`);
  console.log(`Characters: ${CHARS.length}`);
  console.log(`Pairs: ${CHARS.length * (CHARS.length - 1) / 2}\n`);

  // Render all characters in all fonts
  const renders = new Map<string, Map<string, NormalisedResult>>(); // char -> font -> normalised
  let renderCount = 0;
  let skipCount = 0;

  for (const ch of CHARS) {
    const fontRenders = new Map<string, NormalisedResult>();
    for (const font of latinFonts) {
      const result = renderCharacter(ch, font.family);
      if (!result) { skipCount++; continue; }
      try {
        const norm = await normaliseImage(result.pngBuffer);
        if (norm) {
          fontRenders.set(font.family, norm);
          renderCount++;
        }
      } catch { skipCount++; }
    }
    renders.set(ch, fontRenders);
  }
  console.log(`Rendered: ${renderCount} glyphs, ${skipCount} skipped\n`);

  // Compute pairwise SSIM for all character pairs (same font)
  interface PairResult {
    source: string;
    target: string;
    ssimScores: number[];
    sameMean: number;
    sameMax: number;
    sameP95: number;
    sameMedian: number;
    fontCount: number;
  }

  const results: PairResult[] = [];
  let pairsDone = 0;
  const totalPairs = CHARS.length * (CHARS.length - 1) / 2;

  for (let i = 0; i < CHARS.length; i++) {
    for (let j = i + 1; j < CHARS.length; j++) {
      const a = CHARS[i]!, b = CHARS[j]!;
      const rendersA = renders.get(a)!;
      const rendersB = renders.get(b)!;
      const ssimScores: number[] = [];

      // Same-font comparison
      for (const [fontFamily, normA] of rendersA) {
        const normB = rendersB.get(fontFamily);
        if (!normB) continue;
        const sim = computeSsimFast(normA, normB);
        if (isFinite(sim)) ssimScores.push(sim);
      }

      if (ssimScores.length > 0) {
        ssimScores.sort((a, b) => a - b);
        const mean = ssimScores.reduce((s, v) => s + v, 0) / ssimScores.length;
        const max = ssimScores[ssimScores.length - 1]!;
        const p95Idx = Math.min(Math.floor(ssimScores.length * 0.95), ssimScores.length - 1);
        const medIdx = Math.floor(ssimScores.length / 2);

        results.push({
          source: a,
          target: b,
          ssimScores: [], // omit raw scores to save space
          sameMean: Math.round(mean * 10000) / 10000,
          sameMax: Math.round(max * 10000) / 10000,
          sameP95: Math.round(ssimScores[p95Idx]! * 10000) / 10000,
          sameMedian: Math.round(ssimScores[medIdx]! * 10000) / 10000,
          fontCount: ssimScores.length,
        });
      }

      pairsDone++;
      if (pairsDone % 100 === 0) {
        console.log(`  ${pairsDone}/${totalPairs} pairs scored`);
      }
    }
  }

  // Sort by similarity (most confusable first)
  results.sort((a, b) => b.sameMean - a.sameMean);

  // Show top 30 most confusable
  console.log('\nTop 30 most visually similar intra-Latin pairs:');
  for (const r of results.slice(0, 30)) {
    console.log(`  ${r.source} <-> ${r.target}: mean=${r.sameMean.toFixed(3)} max=${r.sameMax.toFixed(3)} p95=${r.sameP95.toFixed(3)} (${r.fontCount} fonts)`);
  }

  // Build a lookup matrix for easy consumption
  const matrix: Record<string, Record<string, number>> = {};
  for (const ch of CHARS) {
    matrix[ch] = {};
    matrix[ch]![ch] = 1.0;
  }
  for (const r of results) {
    matrix[r.source]![r.target] = r.sameMean;
    matrix[r.target]![r.source] = r.sameMean;
  }

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      characters: CHARS.join(''),
      pairCount: results.length,
      fontCount: latinFonts.length,
      scorer: 'ssim-grey (same-font comparison)',
    },
    edges: results,
    matrix,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${results.length} pairs to ${OUTPUT_PATH}`);
}

main().catch(console.error);
