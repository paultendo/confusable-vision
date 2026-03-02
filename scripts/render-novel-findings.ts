/**
 * render-novel-findings.ts -- Visual renders of key novel cross-script SDF discoveries
 *
 * Renders the most surprising/important findings from the singlechar SDF
 * discovery run so they can be visually verified:
 *
 *   1. m/т perfect identity in cursive fonts (font-conditional confusable)
 *   2. Latin-Thai novel pairs (Thai absent from TR39)
 *   3. Georgian ჿ (U+10FF) universal confusable
 *   4. Han-Katakana etymological pairs
 *   5. Arabic alef/Latin l near-identity
 *
 * Usage: npx tsx scripts/render-novel-findings.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { renderCharacter } from '../src/renderer.js';
import { normaliseImage } from '../src/normalise-image.js';
import { initFonts } from '../src/fonts.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'data/output/novel-findings');

interface Finding {
  title: string;
  subtitle: string;
  pairs: Array<{
    source: string;
    sourceLabel: string;
    target: string;
    targetLabel: string;
    ncc: number;
    l2: number;
  }>;
  /** Fonts to render in -- chosen to show where the finding is most striking */
  fonts: string[];
}

const FINDINGS: Finding[] = [
  {
    title: 'Finding 1: m/т Perfect Identity in Cursive Fonts',
    subtitle: 'Latin m and Cyrillic т (U+0442) share byte-identical outlines in cursive typefaces -- NCC=1.0, L2=0.0',
    pairs: [
      { source: 'm', sourceLabel: 'm (U+006D, Latin)', target: '\u0442', targetLabel: 'т (U+0442, Cyrillic)', ncc: 1.0, l2: 0.0 },
    ],
    // Note: SignPainter and Arial excluded. SignPainter has identical glyph paths
    // (confirmed via fontkit) but node-canvas triggers OS font fallback for Cyrillic,
    // producing a misleading render. Arial genuinely differs (т is upright T shape).
    fonts: ['Brush Script MT', 'Snell Roundhand', 'Savoye LET', 'Trattatello', 'Marker Felt'],
  },
  {
    title: 'Finding 2: Thai as Novel Threat Vector',
    subtitle: 'Thai characters absent from TR39 confusables.txt -- 163 novel Latin-Thai pairs discovered',
    pairs: [
      { source: 'n', sourceLabel: 'n (U+006E, Latin)', target: '\u0E01', targetLabel: 'ก (U+0E01, Thai)', ncc: 0.997, l2: 1.75 },
      { source: 'a', sourceLabel: 'a (U+0061, Latin)', target: '\u0E25', targetLabel: 'ล (U+0E25, Thai)', ncc: 0.998, l2: 1.06 },
      { source: 'o', sourceLabel: 'o (U+006F, Latin)', target: '\u0E2D', targetLabel: 'อ (U+0E2D, Thai)', ncc: 0.996, l2: 1.64 },
      { source: 'l', sourceLabel: 'l (U+006C, Latin)', target: '\u0E40', targetLabel: 'เ (U+0E40, Thai)', ncc: 0.999, l2: 1.51 },
    ],
    fonts: ['Krungthep', 'Thonburi', 'Sukhumvit Set', 'Microsoft Sans Serif', 'Tahoma'],
  },
  {
    title: 'Finding 3: Georgian ჿ Near-Identical to Latin/Cyrillic/Greek o',
    subtitle: 'Georgian ჿ (U+10FF) matches o-shapes across 3 scripts at NCC 0.997-0.999 (c/e are SDF false positives)',
    pairs: [
      { source: 'o', sourceLabel: 'o (U+006F, Latin)', target: '\u10FF', targetLabel: 'ჿ (U+10FF, Georgian)', ncc: 0.999, l2: 1.60 },
      { source: '\u043E', sourceLabel: 'о (U+043E, Cyrillic)', target: '\u10FF', targetLabel: 'ჿ (U+10FF, Georgian)', ncc: 0.999, l2: 1.60 },
      { source: '\u03BF', sourceLabel: 'ο (U+03BF, Greek)', target: '\u10FF', targetLabel: 'ჿ (U+10FF, Georgian)', ncc: 0.999, l2: 1.60 },
    ],
    // Note: c/ჿ (NCC=0.995) and e/ჿ (NCC=0.992) are SDF false positives --
    // the SDF grids are similar (both roughly round) but the gap in c and
    // crossbar in e are clearly visible. Only o-shapes truly match.
    fonts: ['Helvetica Neue', 'Helvetica', 'Arial', 'Verdana', 'Georgia'],
  },
  {
    title: 'Finding 4: Han-Katakana Etymological Rediscovery',
    subtitle: 'SDF independently found kanji-katakana pairs that reflect historical derivation',
    pairs: [
      { source: '\u535C', sourceLabel: '卜 (U+535C, Han)', target: '\u30C8', targetLabel: 'ト (U+30C8, Katakana)', ncc: 0.993, l2: 1.83 },
      { source: '\u4E36', sourceLabel: '丶 (U+4E36, Han)', target: '\u30FD', targetLabel: 'ヽ (U+30FD, Katakana)', ncc: 0.995, l2: 2.40 },
      { source: '\u5915', sourceLabel: '夕 (U+5915, Han)', target: '\u30BF', targetLabel: 'タ (U+30BF, Katakana)', ncc: 0.990, l2: 1.92 },
    ],
    fonts: ['Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'Heiti TC', 'Apple SD Gothic Neo'],
  },
  {
    title: 'Finding 5: Arabic Alef / Latin l Near-Identity',
    subtitle: 'Arabic alef (U+0627) is geometrically near-identical to Latin l -- NCC=0.9999, rayDistance=0.0',
    pairs: [
      { source: 'l', sourceLabel: 'l (U+006C, Latin)', target: '\u0627', targetLabel: 'ا (U+0627, Arabic)', ncc: 0.9999, l2: 0.47 },
    ],
    // Note: i/alef removed -- the dot on i is clearly visible despite NCC=0.9997.
    // Raycasting detects the dot (13.4% of rays differ, 4-intersection bin unique
    // to i) but the averaged metric (0.37) falls below the 2.0 threshold.
    // A contour-count or max-per-angle check would catch it.
    fonts: ['Tahoma', 'Arial Unicode MS', 'Microsoft Sans Serif', 'Arial', 'Geeza Pro'],
  },
];

async function renderFinding(finding: Finding, allFonts: ReturnType<typeof initFonts>): Promise<void> {
  const available = allFonts.filter(f => f.available);

  // Resolve requested fonts
  const fonts = finding.fonts
    .map(name => available.find(f => f.family === name))
    .filter((f): f is NonNullable<typeof f> => f != null);

  if (fonts.length === 0) {
    console.log(`  SKIP -- no fonts available from: ${finding.fonts.join(', ')}`);
    return;
  }

  console.log(`  Using ${fonts.length} fonts: ${fonts.map(f => f.family).join(', ')}`);

  const cellSize = 96;
  const pairGap = 8;   // Gap between source and target within a pair
  const fontGap = 20;  // Gap between font columns
  const headerHeight = 56;
  const fontLabelHeight = 20;
  const pairLabelHeight = 20;
  const rowGap = 12;   // Gap between pair rows
  const leftMargin = 20;

  const colWidth = cellSize * 2 + pairGap;
  const totalWidth = Math.max(
    leftMargin * 2 + fonts.length * colWidth + (fonts.length - 1) * fontGap,
    700, // minimum width for header text
  );
  const rowHeight = pairLabelHeight + cellSize;
  const totalHeight = headerHeight + finding.pairs.length * rowHeight + (finding.pairs.length - 1) * rowGap + fontLabelHeight + 30;

  const composites: sharp.OverlayOptions[] = [];

  // Header
  const headerSvg = Buffer.from(`<svg width="${totalWidth}" height="${headerHeight}">
    <text x="${leftMargin}" y="24" font-family="Helvetica, Arial" font-size="15" font-weight="bold" fill="#222">${escapeXml(finding.title)}</text>
    <text x="${leftMargin}" y="44" font-family="Helvetica, Arial" font-size="11" fill="#666">${escapeXml(finding.subtitle)}</text>
  </svg>`);
  composites.push({ input: headerSvg, left: 0, top: 0 });

  // Font column headers
  for (let fi = 0; fi < fonts.length; fi++) {
    const xOffset = leftMargin + fi * (colWidth + fontGap);
    const label = Buffer.from(`<svg width="${colWidth}" height="${fontLabelHeight}">
      <text x="${colWidth / 2}" y="14" text-anchor="middle" font-family="Helvetica, Arial" font-size="11" font-weight="bold" fill="#444">${escapeXml(fonts[fi]!.family)}</text>
    </svg>`);
    composites.push({ input: label, left: xOffset, top: headerHeight - 2 });
  }

  // Render each pair row
  for (let pi = 0; pi < finding.pairs.length; pi++) {
    const pair = finding.pairs[pi]!;
    const rowTop = headerHeight + fontLabelHeight + pi * (rowHeight + rowGap);

    // Pair label on the left side as an SVG overlay
    const pairInfo = `${pair.sourceLabel}  vs  ${pair.targetLabel}    NCC=${pair.ncc}  L2=${pair.l2}`;
    const pairLabelSvg = Buffer.from(`<svg width="${totalWidth}" height="${pairLabelHeight}">
      <text x="${leftMargin}" y="14" font-family="Helvetica, Arial" font-size="10" fill="#888">${escapeXml(pairInfo)}</text>
    </svg>`);
    composites.push({ input: pairLabelSvg, left: 0, top: rowTop });

    for (let fi = 0; fi < fonts.length; fi++) {
      const font = fonts[fi]!;
      const xOffset = leftMargin + fi * (colWidth + fontGap);
      const yOffset = rowTop + pairLabelHeight;

      // Render source
      const sourceRender = renderCharacter(pair.source, font.family);
      if (sourceRender) {
        const norm = await normaliseImage(sourceRender.pngBuffer);
        const resized = await sharp(norm.pngBuffer)
          .resize(cellSize, cellSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
          .png()
          .toBuffer();
        composites.push({ input: resized, left: xOffset, top: yOffset });
      } else {
        // Draw a light grey X to indicate missing glyph
        const miss = Buffer.from(`<svg width="${cellSize}" height="${cellSize}">
          <rect width="${cellSize}" height="${cellSize}" fill="#f8f8f8"/>
          <text x="${cellSize / 2}" y="${cellSize / 2 + 4}" text-anchor="middle" font-family="Arial" font-size="12" fill="#ccc">missing</text>
        </svg>`);
        composites.push({ input: miss, left: xOffset, top: yOffset });
      }

      // Separator
      const separator = await sharp({
        create: { width: 2, height: cellSize, channels: 4, background: { r: 220, g: 220, b: 220, alpha: 1 } },
      }).png().toBuffer();
      composites.push({ input: separator, left: xOffset + cellSize + pairGap / 2 - 1, top: yOffset });

      // Render target
      const targetRender = renderCharacter(pair.target, font.family);
      if (targetRender) {
        const norm = await normaliseImage(targetRender.pngBuffer);
        const resized = await sharp(norm.pngBuffer)
          .resize(cellSize, cellSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
          .png()
          .toBuffer();
        composites.push({ input: resized, left: xOffset + cellSize + pairGap, top: yOffset });
      } else {
        const miss = Buffer.from(`<svg width="${cellSize}" height="${cellSize}">
          <rect width="${cellSize}" height="${cellSize}" fill="#f8f8f8"/>
          <text x="${cellSize / 2}" y="${cellSize / 2 + 4}" text-anchor="middle" font-family="Arial" font-size="12" fill="#ccc">missing</text>
        </svg>`);
        composites.push({ input: miss, left: xOffset + cellSize + pairGap, top: yOffset });
      }
    }
  }

  // Create the composite image
  const image = sharp({
    create: {
      width: totalWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).composite(composites);

  const safeName = finding.title.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const outputPath = path.join(OUTPUT_DIR, `${safeName}.png`);
  await image.png().toFile(outputPath);
  console.log(`  -> ${outputPath}`);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const allFonts = initFonts();
  console.log(`Registered ${allFonts.filter(f => f.available).length} fonts\n`);

  for (const finding of FINDINGS) {
    console.log(`\n=== ${finding.title} ===`);
    await renderFinding(finding, allFonts);
  }

  console.log(`\nDone! ${FINDINGS.length} finding images saved to ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
