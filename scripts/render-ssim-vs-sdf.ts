/**
 * render-ssim-vs-sdf.ts -- Visual comparison of the 6 "low SSIM but low L2" pairs
 *
 * Renders each pair across a few representative fonts so you can see
 * with your own eyes that these are near-identical glyphs that SSIM underscored.
 *
 * Usage: npx tsx scripts/render-ssim-vs-sdf.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { renderCharacter } from '../src/renderer.js';
import { normaliseImage } from '../src/normalise-image.js';
import { initFonts } from '../src/fonts.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data/output/ssim-vs-sdf');

// The 6 pairs where SSIM underscores but SDF correctly identifies similarity
const PAIRS = [
  { source: '\u217E', target: 'd', label: 'ⅾ vs d', ssim: 0.474, l2: 0.09, ncc: 0.999 },
  { source: '\u0261', target: 'g', label: 'ɡ vs g', ssim: 0.342, l2: 1.56, ncc: 0.984 },
  { source: '\u0440', target: 'p', label: 'р vs p', ssim: 0.388, l2: 2.15, ncc: 0.955 },
  { source: '\u0430', target: 'a', label: 'а vs a', ssim: 0.411, l2: 2.34, ncc: 0.950 },
  { source: '\u0435', target: 'e', label: 'е vs e', ssim: 0.490, l2: 2.41, ncc: 0.945 },
  { source: '\u03BF', target: 'o', label: 'ο vs o', ssim: 0.495, l2: 2.59, ncc: 0.936 },
];

// Preferred fonts to show -- common, recognisable names
const PREFERRED_FONTS = ['Arial', 'Verdana', 'Georgia', 'Times New Roman', 'Courier New'];

async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const allFonts = initFonts();
  const available = allFonts.filter(f => f.available);

  // Pick fonts that are in our preferred list
  const fonts = PREFERRED_FONTS
    .map(name => available.find(f => f.family === name))
    .filter((f): f is NonNullable<typeof f> => f !== null && f !== undefined);

  console.log(`Using ${fonts.length} fonts: ${fonts.map(f => f.family).join(', ')}`);

  // For each pair, render source and target in each font, create comparison strip
  for (const pair of PAIRS) {
    console.log(`\n--- ${pair.label} (SSIM=${pair.ssim}, L2=${pair.l2}, NCC=${pair.ncc}) ---`);

    const cellSize = 96; // Larger cells for visibility
    const labelHeight = 28;
    const pairGap = 16; // Gap between source and target
    const fontGap = 24; // Gap between font columns
    const headerHeight = 48; // Top header with pair info
    const fontLabelHeight = 24; // Font name below each column

    const colWidth = cellSize * 2 + pairGap; // source + gap + target
    const totalWidth = fonts.length * colWidth + (fonts.length - 1) * fontGap + 40; // 40 padding
    const totalHeight = headerHeight + cellSize + fontLabelHeight + 20; // 20 padding

    const strips: Array<{ font: string; sourceImg: Buffer | null; targetImg: Buffer | null }> = [];

    for (const font of fonts) {
      const sourceRender = renderCharacter(pair.source, font.family);
      const targetRender = renderCharacter(pair.target, font.family);

      let sourceNorm: Buffer | null = null;
      let targetNorm: Buffer | null = null;

      if (sourceRender) {
        const norm = await normaliseImage(sourceRender.pngBuffer);
        sourceNorm = norm.pngBuffer;
      }
      if (targetRender) {
        const norm = await normaliseImage(targetRender.pngBuffer);
        targetNorm = norm.pngBuffer;
      }

      strips.push({ font: font.family, sourceImg: sourceNorm, targetImg: targetNorm });

      const srcStatus = sourceRender ? 'OK' : 'MISS';
      const tgtStatus = targetRender ? 'OK' : 'MISS';
      console.log(`  ${font.family}: source=${srcStatus}, target=${tgtStatus}`);
    }

    // Build composite image using sharp
    // Create white background
    const composites: sharp.OverlayOptions[] = [];

    for (let i = 0; i < strips.length; i++) {
      const strip = strips[i]!;
      const xOffset = 20 + i * (colWidth + fontGap);

      // Resize and place source image
      if (strip.sourceImg) {
        const resized = await sharp(strip.sourceImg)
          .resize(cellSize, cellSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
          .png()
          .toBuffer();
        composites.push({ input: resized, left: xOffset, top: headerHeight });
      }

      // Resize and place target image
      if (strip.targetImg) {
        const resized = await sharp(strip.targetImg)
          .resize(cellSize, cellSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
          .png()
          .toBuffer();
        composites.push({ input: resized, left: xOffset + cellSize + pairGap, top: headerHeight });
      }

      // Add a thin vertical separator between source and target
      const separator = await sharp({
        create: { width: 2, height: cellSize, channels: 4, background: { r: 200, g: 200, b: 200, alpha: 1 } },
      }).png().toBuffer();
      composites.push({ input: separator, left: xOffset + cellSize + pairGap / 2 - 1, top: headerHeight });

      // Create font name label using SVG
      const fontLabel = Buffer.from(`<svg width="${colWidth}" height="${fontLabelHeight}">
        <text x="${colWidth / 2}" y="16" text-anchor="middle" font-family="Arial" font-size="12" fill="#666">${strip.font}</text>
      </svg>`);
      composites.push({ input: fontLabel, left: xOffset, top: headerHeight + cellSize + 2 });

      // Create "src" and "tgt" labels
      const srcLabel = Buffer.from(`<svg width="${cellSize}" height="16">
        <text x="${cellSize / 2}" y="12" text-anchor="middle" font-family="Arial" font-size="10" fill="#999">source</text>
      </svg>`);
      composites.push({ input: srcLabel, left: xOffset, top: headerHeight - 16 });

      const tgtLabel = Buffer.from(`<svg width="${cellSize}" height="16">
        <text x="${cellSize / 2}" y="12" text-anchor="middle" font-family="Arial" font-size="10" fill="#999">target</text>
      </svg>`);
      composites.push({ input: tgtLabel, left: xOffset + cellSize + pairGap, top: headerHeight - 16 });
    }

    // Create header with pair info
    const headerSvg = Buffer.from(`<svg width="${totalWidth}" height="${headerHeight}">
      <text x="20" y="24" font-family="Arial" font-size="16" font-weight="bold" fill="#333">${pair.label}</text>
      <text x="20" y="42" font-family="Arial" font-size="12" fill="#666">SSIM=${pair.ssim}  L2=${pair.l2}  NCC=${pair.ncc}</text>
    </svg>`);

    const image = sharp({
      create: {
        width: totalWidth,
        height: totalHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    }).composite([
      { input: headerSvg, left: 0, top: 0 },
      ...composites,
    ]);

    const safeName = pair.label.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
    const outputPath = path.join(OUTPUT_DIR, `${safeName}.png`);
    await image.png().toFile(outputPath);
    console.log(`  -> ${outputPath}`);
  }

  console.log(`\nDone! ${PAIRS.length} comparison images saved to ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
