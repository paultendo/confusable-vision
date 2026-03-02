/**
 * glyph-path.ts
 *
 * Extracts Bezier outlines from font glyphs using fontkit and normalises
 * them to a grid coordinate system for raycasting and SDF computation.
 *
 * Handles TTC collections (face 0), .notdef detection, and multi-character
 * sequences with kerning + ligature substitution.
 */

import * as fontkit from 'fontkit';
import type { PathPoint, PathSegment, GlyphPathData, FontMetricsData } from './types.js';

/** Cache opened font objects to avoid repeated disk reads */
const fontCache = new Map<string, ReturnType<typeof fontkit.openSync> | null>();

/**
 * Open a font file with fontkit, returning the first face.
 * Handles TTC collections by selecting face 0.
 */
export function loadFont(fontPath: string): ReturnType<typeof fontkit.openSync> | null {
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
 * Evict a single entry from the font cache, releasing the fontkit object.
 * Used by FontLRU to free memory when cycling through many fonts.
 */
export function evictFontCache(fontPath: string): void {
  fontCache.delete(fontPath);
}

/**
 * Extract font-level metrics needed for coordinate normalisation.
 */
export function getFontMetrics(font: ReturnType<typeof fontkit.openSync>): FontMetricsData {
  return {
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascent,
    descender: font.descent,
  };
}

/**
 * Convert fontkit path commands to typed PathSegment array.
 * Tracks the current point through moveTo/lineTo/curveTo commands.
 */
function commandsToSegments(commands: any[]): PathSegment[] {
  const segments: PathSegment[] = [];
  let currentX = 0;
  let currentY = 0;
  let subpathStartX = 0;
  let subpathStartY = 0;

  for (const cmd of commands) {
    const type = cmd.command ?? cmd.type;
    switch (type) {
      case 'moveTo':
        currentX = cmd.args[0];
        currentY = cmd.args[1];
        subpathStartX = currentX;
        subpathStartY = currentY;
        break;

      case 'lineTo': {
        const p0: PathPoint = { x: currentX, y: currentY };
        const p1: PathPoint = { x: cmd.args[0], y: cmd.args[1] };
        // Skip zero-length lines
        if (p0.x !== p1.x || p0.y !== p1.y) {
          segments.push({ type: 'line', p0, p1 });
        }
        currentX = p1.x;
        currentY = p1.y;
        break;
      }

      case 'quadraticCurveTo': {
        const p0: PathPoint = { x: currentX, y: currentY };
        const p1: PathPoint = { x: cmd.args[0], y: cmd.args[1] };
        const p2: PathPoint = { x: cmd.args[2], y: cmd.args[3] };
        segments.push({ type: 'quadratic', p0, p1, p2 });
        currentX = p2.x;
        currentY = p2.y;
        break;
      }

      case 'bezierCurveTo': {
        const p0: PathPoint = { x: currentX, y: currentY };
        const p1: PathPoint = { x: cmd.args[0], y: cmd.args[1] };
        const p2: PathPoint = { x: cmd.args[2], y: cmd.args[3] };
        const p3: PathPoint = { x: cmd.args[4], y: cmd.args[5] };
        segments.push({ type: 'cubic', p0, p1, p2, p3 });
        currentX = p3.x;
        currentY = p3.y;
        break;
      }

      case 'closePath': {
        // Close with a line back to subpath start if not already there
        if (currentX !== subpathStartX || currentY !== subpathStartY) {
          segments.push({
            type: 'line',
            p0: { x: currentX, y: currentY },
            p1: { x: subpathStartX, y: subpathStartY },
          });
        }
        currentX = subpathStartX;
        currentY = subpathStartY;
        break;
      }
    }
  }

  return segments;
}

/**
 * Compute bounding box from path segments.
 * Uses control points as a conservative approximation (the true bbox
 * from Bezier extrema would be tighter, but control-point bbox is
 * sufficient for our normalisation and ray-casting grid).
 */
function computeBBox(segments: PathSegment[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  function update(p: PathPoint): void {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  for (const seg of segments) {
    update(seg.p0);
    if (seg.type === 'line') {
      update(seg.p1);
    } else if (seg.type === 'quadratic') {
      update(seg.p1);
      update(seg.p2);
    } else {
      update(seg.p1);
      update(seg.p2);
      update(seg.p3);
    }
  }

  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * Extract Bezier outline for a single codepoint.
 * Returns null for .notdef (glyph ID 0 or empty path).
 */
export function extractGlyphPath(
  font: ReturnType<typeof fontkit.openSync>,
  codePoint: number,
): GlyphPathData | null {
  try {
    const glyph = font.glyphForCodePoint(codePoint);
    if (glyph.id === 0) return null;

    const pathObj = glyph.path;
    if (!pathObj || !pathObj.commands || pathObj.commands.length === 0) return null;

    const segments = commandsToSegments(pathObj.commands);
    if (segments.length === 0) return null;

    return {
      segments,
      advanceWidth: glyph.advanceWidth,
      bbox: computeBBox(segments),
    };
  } catch {
    return null;
  }
}

/**
 * Extract Bezier outline for a multi-character text string.
 * Uses font.layout() for kerning + ligature substitution.
 *
 * If layout produces a single ligature glyph, that path is returned directly.
 * Otherwise, individual glyph paths are concatenated, offset by each glyph's
 * advance width + positioning adjustments.
 */
export function extractSequencePath(
  font: ReturnType<typeof fontkit.openSync>,
  text: string,
): GlyphPathData | null {
  try {
    // Pre-check: verify all codepoints have non-.notdef glyphs BEFORE calling
    // font.layout(). layout() triggers full OpenType shaping which can cause
    // pathological memory allocation in certain font+text combinations
    // (e.g. Thai fonts processing Arabic text). This cheap cmap check avoids
    // the expensive layout call entirely for unsupported text.
    for (const char of text) {
      const cp = char.codePointAt(0)!;
      try {
        const g = font.glyphForCodePoint(cp);
        if (g.id === 0) return null;
      } catch {
        return null;
      }
    }

    const run = font.layout(text, ['liga', 'kern']);
    if (!run.glyphs || run.glyphs.length === 0) return null;

    // Check for .notdef in any position (layout may produce different glyphs
    // than individual codepoint lookups due to substitution rules)
    for (const g of run.glyphs) {
      if (g.id === 0) return null;
    }

    const allSegments: PathSegment[] = [];
    let xCursor = 0;
    let totalAdvance = 0;

    for (let i = 0; i < run.glyphs.length; i++) {
      const glyph = run.glyphs[i]!;
      const pos = run.positions[i]!;

      const pathObj = glyph.path;
      if (!pathObj || !pathObj.commands || pathObj.commands.length === 0) continue;

      const xOffset = xCursor + (pos.xOffset ?? 0);
      const yOffset = pos.yOffset ?? 0;

      // Convert commands to segments with position offset applied
      const rawSegments = commandsToSegments(pathObj.commands);
      for (const seg of rawSegments) {
        allSegments.push(offsetSegment(seg, xOffset, yOffset));
      }

      xCursor += (pos.xAdvance ?? glyph.advanceWidth);
      totalAdvance = xCursor;
    }

    if (allSegments.length === 0) return null;

    return {
      segments: allSegments,
      advanceWidth: totalAdvance,
      bbox: computeBBox(allSegments),
    };
  } catch {
    return null;
  }
}

/**
 * Build a kern pair lookup from the font's kern table.
 * Returns a Map keyed by "leftGlyphId,rightGlyphId" with values in font units.
 * Returns an empty map if the font has no kern table.
 */
function buildKernMap(font: ReturnType<typeof fontkit.openSync>): Map<string, number> {
  const map = new Map<string, number>();
  const kern = (font as any).kern;
  if (!kern?.tables) return map;
  for (const table of kern.tables) {
    const pairs = table?.subtable?.pairs;
    if (!pairs) continue;
    for (const p of pairs) {
      map.set(`${p.left},${p.right}`, p.value);
    }
  }
  return map;
}

/** Cache kern maps per font path to avoid rebuilding */
const kernMapCache = new Map<string, Map<string, number>>();

/**
 * Get the kern adjustment between two glyph IDs from the font's kern table.
 * Returns 0 if no kern pair exists. Uses a cached lookup map.
 */
export function getKernValue(
  font: ReturnType<typeof fontkit.openSync>,
  leftGlyphId: number,
  rightGlyphId: number,
): number {
  // Use the font's postscriptName as cache key (unique per face)
  const cacheKey = (font as any).postscriptName ?? '';
  let map = kernMapCache.get(cacheKey);
  if (!map) {
    map = buildKernMap(font);
    kernMapCache.set(cacheKey, map);
  }
  return map.get(`${leftGlyphId},${rightGlyphId}`) ?? 0;
}

/**
 * Concatenate individual glyph paths for a multi-character string.
 * Uses glyphForCodePoint() and kern table lookups -- never calls
 * font.layout(), avoiding fontkit shaping bugs that cause V8-fatal OOM
 * on certain complex-script fonts (Thai, Gujarati, etc.).
 *
 * Kern adjustments are applied from the font's kern table (a static pair
 * lookup, no shaping engine involved). No ligature substitution.
 */
export function concatGlyphPaths(
  font: ReturnType<typeof fontkit.openSync>,
  text: string,
): GlyphPathData | null {
  const chars = [...text];
  if (chars.length === 0) return null;

  // Extract all glyphs first (fail fast if any missing)
  const glyphs: Array<{ id: number; data: GlyphPathData }> = [];
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    const glyph = font.glyphForCodePoint(cp);
    if (glyph.id === 0) return null;
    const data = extractGlyphPath(font, cp);
    if (!data) return null;
    glyphs.push({ id: glyph.id, data });
  }

  const allSegments: PathSegment[] = [];
  let xCursor = 0;

  for (let i = 0; i < glyphs.length; i++) {
    const { id, data } = glyphs[i]!;

    // Apply kern adjustment from previous glyph
    if (i > 0) {
      xCursor += getKernValue(font, glyphs[i - 1]!.id, id);
    }

    if (xCursor !== 0) {
      for (const seg of data.segments) {
        allSegments.push(offsetSegment(seg, xCursor, 0));
      }
    } else {
      allSegments.push(...data.segments);
    }
    xCursor += data.advanceWidth;
  }

  if (allSegments.length === 0) return null;

  return {
    segments: allSegments,
    advanceWidth: xCursor,
    bbox: computeBBox(allSegments),
  };
}

/**
 * Offset all points in a segment by (dx, dy).
 */
function offsetSegment(seg: PathSegment, dx: number, dy: number): PathSegment {
  const off = (p: PathPoint): PathPoint => ({ x: p.x + dx, y: p.y + dy });

  switch (seg.type) {
    case 'line':
      return { type: 'line', p0: off(seg.p0), p1: off(seg.p1) };
    case 'quadratic':
      return { type: 'quadratic', p0: off(seg.p0), p1: off(seg.p1), p2: off(seg.p2) };
    case 'cubic':
      return { type: 'cubic', p0: off(seg.p0), p1: off(seg.p1), p2: off(seg.p2), p3: off(seg.p3) };
  }
}

/**
 * Scale path segments from font units to a normalised grid coordinate system.
 *
 * The grid is `gridSize x gridSize`. The font's full em-square height
 * (ascender to descender) maps to the grid height. The baseline is anchored
 * at the vertical centre of the grid, adjusted by the font's
 * ascender/descender ratio.
 *
 * Font coordinate system: Y increases upward (ascender > 0, descender < 0).
 * Grid coordinate system: Y increases downward (top = 0).
 */
export function normalizeToGrid(
  pathData: GlyphPathData,
  metrics: FontMetricsData,
  gridSize: number,
): PathSegment[] {
  const scale = gridSize / metrics.unitsPerEm;

  // In font coords, baseline is at Y=0, ascender is positive, descender is negative.
  // Total height in font units: ascender - descender (descender is negative, so this adds).
  // We want the baseline in the grid at a position that preserves the ascender/descender ratio.
  // Grid Y flips: gridY = gridSize - (fontY * scale + baselineGridY)
  const totalHeight = metrics.ascender - metrics.descender;
  const baselineGridY = gridSize * (metrics.ascender / totalHeight);

  function transformPoint(p: PathPoint): PathPoint {
    return {
      x: p.x * scale,
      y: baselineGridY - (p.y * scale), // flip Y axis
    };
  }

  return pathData.segments.map(seg => {
    switch (seg.type) {
      case 'line':
        return { type: 'line', p0: transformPoint(seg.p0), p1: transformPoint(seg.p1) };
      case 'quadratic':
        return {
          type: 'quadratic',
          p0: transformPoint(seg.p0),
          p1: transformPoint(seg.p1),
          p2: transformPoint(seg.p2),
        };
      case 'cubic':
        return {
          type: 'cubic',
          p0: transformPoint(seg.p0),
          p1: transformPoint(seg.p1),
          p2: transformPoint(seg.p2),
          p3: transformPoint(seg.p3),
        };
    }
  });
}

/**
 * Compute the grid row of the baseline for a given font and grid size.
 * Used by SDF to validate baseline alignment between comparisons.
 */
export function getBaselineRow(metrics: FontMetricsData, gridSize: number): number {
  const totalHeight = metrics.ascender - metrics.descender;
  return Math.round(gridSize * (metrics.ascender / totalHeight));
}
