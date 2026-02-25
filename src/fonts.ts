import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { registerFont } from 'canvas';
import type { FontEntry } from './types.js';

const FONT_DIRS = [
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
];

/** Category overrides for specific font families */
const CATEGORY_OVERRIDES: Record<string, FontEntry['category']> = {
  'STIX Two Math': 'math',
  'STIX Two Text': 'math',
  'STIXGeneral': 'math',
  'Apple Symbols': 'symbol',
};

/** Fonts to exclude (render symbols/dingbats instead of actual Latin letters) */
const EXCLUDED_FAMILIES = new Set([
  'Webdings',
  'Wingdings',
  'Wingdings 2',
  'Wingdings 3',
  'Bodoni Ornaments',
]);

/**
 * Classify a font family into a category based on its name.
 * Returns null for fonts that should be skipped (internal, dingbats).
 *
 * Categories:
 * - 'standard': Latin-primary fonts (web standard + macOS system + display)
 * - 'script': CJK, Indic, Thai, and other script-primary fonts that also have Latin
 * - 'noto': Noto Sans/Serif variants
 * - 'math': STIX math fonts
 * - 'symbol': Apple Symbols
 */
function classifyFont(family: string): FontEntry['category'] | null {
  // Skip internal/system-private fonts (prefixed with ".")
  if (family.startsWith('.')) return null;
  if (EXCLUDED_FAMILIES.has(family)) return null;

  // Explicit overrides
  const override = CATEGORY_OVERRIDES[family];
  if (override) return override;

  // Noto fonts
  if (family.startsWith('Noto')) return 'noto';

  // Script-primary fonts (CJK, Indic, Thai, etc.) -- these have Latin glyphs
  // but are primarily designed for other writing systems
  const scriptPattern = /^(Bangla|Tamil|Kannada|Telugu|Malayalam|Oriya|Gurmukhi|Gujarati|Devanagari|Sinhala|Myanmar|Khmer|Lao|Kohinoor|Mukta|Shree|InaiMathi|Grantha|Hiragino|Heiti|STSong|Songti|Apple SD|AppleGothic|AppleMyungjo|Thonburi|Sathu|Krungthep|Silom|Sukhumvit|Ayuthaya|Kefa|Euphemia|Plantagenet)/;
  if (scriptPattern.test(family)) return 'script';

  return 'standard';
}

/**
 * Discover all macOS system fonts with Latin a-z coverage using fontconfig.
 * Groups results by family and picks the best file path (preferring Regular weight).
 *
 * For .ttc files with multiple families, only the primary family (shortest name)
 * is registered since node-canvas registerFont always uses face index 0.
 */
function discoverSystemLatinFonts(): Omit<FontEntry, 'available'>[] {
  try {
    const output = execFileSync('fc-list', [
      ':charset=61-7A', '--format=%{file}|%{family[0]}\n',
    ], { encoding: 'utf-8', timeout: 10000 });

    // Group paths by family
    const familyPaths = new Map<string, string[]>();
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sepIdx = trimmed.indexOf('|');
      if (sepIdx < 0) continue;
      const filePath = trimmed.slice(0, sepIdx).trim();
      const family = trimmed.slice(sepIdx + 1).trim();
      if (!filePath || !family) continue;

      // System fonts only
      if (!filePath.startsWith('/System/Library/Fonts/') &&
          !filePath.startsWith('/Library/Fonts/')) continue;

      if (!familyPaths.has(family)) familyPaths.set(family, []);
      familyPaths.get(family)!.push(filePath);
    }

    const results: Omit<FontEntry, 'available'>[] = [];
    const usedTtcPaths = new Set<string>();

    // Process families sorted by name length (shorter = more primary) to ensure
    // .ttc dedup picks the base family (e.g. "PT Sans" over "PT Sans Narrow")
    const sortedFamilies = [...familyPaths.entries()]
      .sort(([a], [b]) => a.length - b.length || a.localeCompare(b));

    for (const [family, paths] of sortedFamilies) {
      const category = classifyFont(family);
      if (!category) continue;

      // Pick best path: prefer non-Bold/Italic filename, prefer .ttf/.otf over .ttc
      const bestPath = [...paths].sort((a, b) => {
        const aWeight = /Bold|Italic/i.test(path.basename(a)) ? 1 : 0;
        const bWeight = /Bold|Italic/i.test(path.basename(b)) ? 1 : 0;
        if (aWeight !== bWeight) return aWeight - bWeight;
        const aTtc = a.endsWith('.ttc') ? 1 : 0;
        const bTtc = b.endsWith('.ttc') ? 1 : 0;
        return aTtc - bTtc;
      })[0]!;

      // For .ttc files, skip if already registered under another family
      // (registerFont only uses face 0 regardless of family name)
      if (bestPath.endsWith('.ttc')) {
        if (usedTtcPaths.has(bestPath)) continue;
        usedTtcPaths.add(bestPath);
      }

      results.push({ family, path: bestPath, category });
    }

    return results;
  } catch {
    console.warn('  [font] fc-list discovery failed');
    return [];
  }
}

/**
 * Discover Noto Sans fonts across system font directories.
 * Scans both /System/Library/Fonts/ and /System/Library/Fonts/Supplemental/
 * for NotoSans* files in .ttf, .otf, and .ttc (TrueType Collection) formats.
 *
 * Many Noto fonts cover non-Latin scripts that fc-list ':charset=61-7A' would
 * miss. This filesystem scan catches all of them so we can render confusable
 * source characters from those scripts.
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
 * Discover and register all system fonts.
 *
 * 1. fc-list auto-discovers all system fonts with Latin a-z coverage.
 *    This finds standard fonts (Arial, Helvetica, Futura...), display fonts
 *    (Papyrus, Zapfino...), CJK/Indic/Thai fonts with Latin glyphs, and
 *    any Noto fonts that have Latin.
 * 2. Filesystem scan discovers Noto fonts for non-Latin scripts (Tifinagh,
 *    Armenian, NKo, Osage...) that fc-list would miss.
 * 3. Results are merged (deduplicated by family), registered with node-canvas,
 *    and returned with availability status.
 */
export function initFonts(): FontEntry[] {
  // Step 1: Auto-discover system fonts with Latin a-z
  const systemFonts = discoverSystemLatinFonts();

  // Step 2: Discover Noto fonts (includes non-Latin scripts)
  const notoFonts = discoverNotoFonts();

  // Step 3: Merge, deduplicating by family name (system fonts take precedence)
  const seenFamilies = new Set<string>();
  const allDefs: Omit<FontEntry, 'available'>[] = [];

  for (const f of systemFonts) {
    seenFamilies.add(f.family);
    allDefs.push(f);
  }
  for (const f of notoFonts) {
    if (seenFamilies.has(f.family)) continue;
    seenFamilies.add(f.family);
    allDefs.push(f);
  }

  // Step 4: Register all fonts with node-canvas
  const fonts: FontEntry[] = [];
  let registered = 0;
  let failed = 0;

  for (const def of allDefs) {
    const available = fs.existsSync(def.path);

    if (available) {
      try {
        registerFont(def.path, { family: def.family });
        registered++;
      } catch {
        fonts.push({ ...def, available: false });
        failed++;
        continue;
      }
    }

    fonts.push({ ...def, available });
  }

  // Print summary by category
  const counts: Record<string, number> = {};
  for (const f of fonts) {
    if (!f.available) continue;
    counts[f.category] = (counts[f.category] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const parts = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([cat, n]) => `${cat}: ${n}`)
    .join(', ');

  console.log(`  [font] ${total} fonts registered (${parts})`);
  if (failed > 0) console.log(`  [font] ${failed} fonts failed to register`);
  console.log('');

  return fonts;
}

/**
 * Query fontconfig to find which of our registered fonts natively contain
 * a given codepoint. Uses `fc-list ':charset=XXXX' file` and matches the
 * returned file paths against our font list.
 *
 * This replaces brute-force rendering + pixel deduplication. Instead of
 * rendering every character in all fonts (where Pango silently falls back
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
  const family = basename;

  try {
    registerFont(fontPath, { family });
  } catch {
    return null;
  }

  const entry: FontEntry = {
    family,
    path: fontPath,
    category: 'script', // dynamically discovered fonts are non-standard
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
