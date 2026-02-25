import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { registerFont } from 'canvas';
import type { FontEntry } from './types.js';

const FONT_DIRS = [
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
];

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
 * Discover Noto Sans fonts across system font directories.
 * Scans both /System/Library/Fonts/ and /System/Library/Fonts/Supplemental/
 * for NotoSans* files in .ttf, .otf, and .ttc (TrueType Collection) formats.
 *
 * macOS ships ~100 Noto Sans fonts covering scripts like Tifinagh, Armenian,
 * NKo, Osage, Kannada, Myanmar, Oriya, Lisu, etc. Browsers use them via
 * system font fallback; we register them explicitly for node-canvas.
 *
 * For .ttc files (collections with multiple weights), we register only the
 * first face (index 0), which is typically the Regular weight.
 */
function discoverNotoFonts(): Omit<FontEntry, 'available'>[] {
  const results: Omit<FontEntry, 'available'>[] = [];
  const seen = new Set<string>();

  for (const dir of FONT_DIRS) {
    if (!fs.existsSync(dir)) continue;

    const entries = fs.readdirSync(dir);
    const notoFiles = entries.filter(
      f => f.startsWith('NotoSans') && /\.(ttf|otf|ttc)$/i.test(f),
    );

    for (const filename of notoFiles) {
      const filePath = path.join(dir, filename);
      const family = notoFamilyFromFilename(filename);
      if (seen.has(family)) continue;
      seen.add(family);
      results.push({ family, path: filePath, category: 'noto' as const });
    }
  }

  return results;
}

/**
 * Extract a readable font family name from a Noto Sans filename.
 * "NotoSansTifinagh-Regular.otf" -> "Noto Sans Tifinagh"
 * "NotoSansArmenian.ttc"         -> "Noto Sans Armenian"
 */
function notoFamilyFromFilename(filename: string): string {
  // Strip extension and optional weight suffix
  const base = filename
    .replace(/\.(ttf|otf|ttc)$/i, '')
    .replace(/-(Regular|Bold|Italic|Light|Medium|Thin|SemiBold|ExtraBold|Black|Blk|ExtLt)$/i, '');
  // Insert space before uppercase letters following lowercase: "NotoSans" -> "Noto Sans"
  return base.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Check which fonts are available on this system and register them with node-canvas.
 * Returns the font list with availability status.
 *
 * Discovers Noto Sans supplemental fonts automatically in addition to the
 * hardcoded standard/math/symbol fonts.
 */
export function initFonts(): FontEntry[] {
  const notoFonts = discoverNotoFonts();
  const allDefs = [...FONT_DEFINITIONS, ...notoFonts];

  const fonts: FontEntry[] = [];

  for (const def of allDefs) {
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
  const notoCount = fonts.filter(f => f.category === 'noto' && f.available).length;
  console.log(`  [font] ${availableCount}/${fonts.length} fonts available (${notoCount} Noto script fonts)\n`);

  return fonts;
}

/**
 * Query fontconfig to find which of our registered fonts natively contain
 * a given codepoint. Uses `fc-list ':charset=XXXX' file` and matches the
 * returned file paths against our font list.
 *
 * This replaces brute-force rendering + pixel deduplication. Instead of
 * rendering every character in all 111 fonts (where Pango silently falls back
 * for most), we ask fontconfig upfront which fonts actually have the glyph.
 */
export function queryFontCoverage(
  codepoint: number,
  fonts: FontEntry[],
): FontEntry[] {
  const hex = codepoint.toString(16).toUpperCase();
  const paths = fcListCharset(hex);
  return fonts.filter(f => f.available && paths.has(f.path));
}

/**
 * For a character with zero coverage in our registered fonts, discover and
 * register a system font that has it. Returns the newly registered FontEntry,
 * or null if no system font covers this character.
 *
 * Picks the best system font by preferring /System/Library/Fonts/ over
 * user-installed fonts, and preferring Supplemental/ directory fonts.
 * Caches registrations so each font file is only registered once.
 */
const dynamicFonts = new Map<string, FontEntry>();

export function discoverFontForCodepoint(codepoint: number): FontEntry | null {
  const hex = codepoint.toString(16).toUpperCase();
  const paths = fcListCharset(hex);

  // Filter to system fonts, excluding LastResort and user-installed fonts
  const systemPaths = [...paths].filter(p =>
    p.startsWith('/System/Library/Fonts/') ||
    p.startsWith('/Library/Fonts/')
  ).filter(p =>
    !p.includes('LastResort')
  );

  if (systemPaths.length === 0) return null;

  // Check if we already registered any of these
  for (const p of systemPaths) {
    const existing = dynamicFonts.get(p);
    if (existing) return existing;
  }

  // Pick the best candidate: prefer Supplemental/ (purpose-built script fonts),
  // then /System/Library/Fonts/, then /Library/Fonts/
  systemPaths.sort((a, b) => {
    const scoreA = a.includes('Supplemental') ? 2 : a.startsWith('/System') ? 1 : 0;
    const scoreB = b.includes('Supplemental') ? 2 : b.startsWith('/System') ? 1 : 0;
    return scoreB - scoreA;
  });

  const fontPath = systemPaths[0]!;

  // Derive a family name from the filename
  const basename = path.basename(fontPath).replace(/\.(ttf|otf|ttc)$/i, '');
  // Use the basename as-is for non-Noto fonts (e.g. "Tamil Sangam MN", "Arial Unicode")
  const family = basename;

  try {
    registerFont(fontPath, { family });
  } catch {
    return null;
  }

  const entry: FontEntry = {
    family,
    path: fontPath,
    category: 'noto', // treat all dynamically discovered fonts as non-standard
    available: true,
  };
  dynamicFonts.set(fontPath, entry);
  console.log(`  [font] dynamic: ${family} (${fontPath})`);
  return entry;
}

/** Run fc-list for a charset query and return the set of file paths */
function fcListCharset(hex: string): Set<string> {
  try {
    const output = execFileSync('fc-list', [`:charset=${hex}`, 'file'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const paths = new Set<string>();
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.lastIndexOf(':');
      const filePath = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
      paths.add(filePath);
    }
    return paths;
  } catch {
    return new Set();
  }
}
