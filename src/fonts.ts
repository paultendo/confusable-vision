import fs from 'node:fs';
import { registerFont } from 'canvas';
import type { FontEntry } from './types.js';

/** Static font list -- 10 standard + 2 math/symbol fonts verified on macOS */
const FONT_DEFINITIONS: Omit<FontEntry, 'available'>[] = [
  // Standard fonts
  { family: 'Arial', path: '/System/Library/Fonts/Supplemental/Arial.ttf', category: 'standard' },
  { family: 'Verdana', path: '/System/Library/Fonts/Supplemental/Verdana.ttf', category: 'standard' },
  { family: 'Trebuchet MS', path: '/System/Library/Fonts/Supplemental/Trebuchet MS.ttf', category: 'standard' },
  { family: 'Tahoma', path: '/System/Library/Fonts/Supplemental/Tahoma.ttf', category: 'standard' },
  { family: 'Geneva', path: '/System/Library/Fonts/Geneva.ttf', category: 'standard' },
  { family: 'Georgia', path: '/System/Library/Fonts/Supplemental/Georgia.ttf', category: 'standard' },
  { family: 'Times New Roman', path: '/System/Library/Fonts/Supplemental/Times New Roman.ttf', category: 'standard' },
  { family: 'Courier New', path: '/System/Library/Fonts/Supplemental/Courier New.ttf', category: 'standard' },
  { family: 'Monaco', path: '/System/Library/Fonts/Monaco.ttf', category: 'standard' },
  { family: 'Impact', path: '/System/Library/Fonts/Supplemental/Impact.ttf', category: 'standard' },
  // Math/symbol fonts (needed for SMP Mathematical Alphanumeric Symbols)
  { family: 'STIX Two Math', path: '/System/Library/Fonts/Supplemental/STIXTwoMath.otf', category: 'math' },
  { family: 'Apple Symbols', path: '/System/Library/Fonts/Apple Symbols.ttf', category: 'symbol' },
];

/**
 * Check which fonts are available on this system and register them with node-canvas.
 * Returns the font list with availability status.
 */
export function initFonts(): FontEntry[] {
  const fonts: FontEntry[] = [];

  for (const def of FONT_DEFINITIONS) {
    const available = fs.existsSync(def.path);

    if (available) {
      try {
        registerFont(def.path, { family: def.family });
        console.log(`  [font] registered: ${def.family} (${def.path})`);
      } catch (err) {
        console.warn(`  [font] FAILED to register ${def.family}: ${err}`);
        fonts.push({ ...def, available: false });
        continue;
      }
    } else {
      console.log(`  [font] not found: ${def.family} (${def.path})`);
    }

    fonts.push({ ...def, available });
  }

  const availableCount = fonts.filter(f => f.available).length;
  console.log(`  [font] ${availableCount}/${fonts.length} fonts available\n`);

  return fonts;
}
