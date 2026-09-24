import fs from "node:fs";
import path from "node:path";
import { initFonts } from "./fonts.js";
import { extractGlyphPath, loadFont } from "./glyph-path.js";
import { sideBankFonts } from "./bank-load.js";

/** A glyph's outline box in em units, baseline at 0 (y up), with its advance width. */
export type GlyphBox = { xMin: number; yMin: number; xMax: number; yMax: number; advance: number };

let paths: Map<string, string> | null = null;

/** Font family (as the signature bank names it) to file, for macOS system fonts. */
export function systemFontPaths(): Map<string, string> {
  if (paths) return paths;
  paths = new Map();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ttf|otf|ttc)$/i.test(e.name)) paths!.set(e.name.replace(/\.(ttf|otf|ttc)$/i, ""), p);
    }
  };
  walk("/System/Library/Fonts");
  for (const f of initFonts()) if (f.available && f.path.startsWith("/System/Library/Fonts/")) paths.set(f.family, f.path);
  for (const [family, file] of sideBankFonts()) paths.set(family, file);
  return paths;
}

const cache = new Map<string, GlyphBox | null>();

export function glyphBox(family: string, cp: number): GlyphBox | null {
  const key = `${family}|${cp}`;
  if (cache.has(key)) return cache.get(key)!;
  const file = systemFontPaths().get(family);
  const font = file ? loadFont(file) : null;
  const g = font ? extractGlyphPath(font, cp) : null;
  const em = font?.unitsPerEm ?? 1;
  const box = g
    ? { xMin: g.bbox.minX / em, yMin: g.bbox.minY / em, xMax: g.bbox.maxX / em, yMax: g.bbox.maxY / em, advance: g.advanceWidth / em }
    : null;
  cache.set(key, box);
  return box;
}

/** How far apart two glyphs sit in running text at one size: the largest gap between tops, bottoms or ink widths. */
export function boxGap(a: GlyphBox, b: GlyphBox): number {
  return Math.max(Math.abs(a.yMax - b.yMax), Math.abs(a.yMin - b.yMin), Math.abs((a.xMax - a.xMin) - (b.xMax - b.xMin)));
}
