/**
 * bench-sdf.ts -- Compare brute-force vs optimized computeSDF timing.
 *
 * Inlines the old brute-force implementation and imports the new optimized
 * version from src/sdf.ts. Runs both on the same glyphs and reports speedup.
 *
 * Usage: npx tsx scripts/bench-sdf.ts
 */

import {
  loadFont,
  extractGlyphPath,
  getFontMetrics,
  normalizeToGrid,
  getBaselineRow,
} from '../src/glyph-path.js';
import {
  pointToSegmentDistance,
  computeSDF as computeSDFOptimized,
  compareSDF,
} from '../src/sdf.js';
import type { PathPoint, PathSegment, SDFGrid } from '../src/types.js';

const GRID_SIZE = 128;
const ARIAL_PATH = '/System/Library/Fonts/Supplemental/Arial.ttf';

// ========================================================================
// Brute-force computeSDF (the old version, pre-optimization)
// ========================================================================

interface SegmentCache {
  seg: PathSegment;
  minX: number; minY: number; maxX: number; maxY: number;
}

function buildSegmentCache(segments: PathSegment[]): SegmentCache[] {
  return segments.map(seg => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const update = (p: PathPoint) => {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    };
    update(seg.p0);
    if (seg.type === 'line') { update(seg.p1); }
    else if (seg.type === 'quadratic') { update(seg.p1); update(seg.p2); }
    else { update(seg.p1); update(seg.p2); update(seg.p3); }
    return { seg, minX, minY, maxX, maxY };
  });
}

function lineWinding(point: PathPoint, p0: PathPoint, p1: PathPoint): number {
  if (p0.y <= point.y) {
    if (p1.y <= point.y) return 0;
    const t = (point.y - p0.y) / (p1.y - p0.y);
    const xAt = p0.x + t * (p1.x - p0.x);
    if (xAt > point.x) return 1;
  } else {
    if (p1.y > point.y) return 0;
    const t = (point.y - p0.y) / (p1.y - p0.y);
    const xAt = p0.x + t * (p1.x - p0.x);
    if (xAt > point.x) return -1;
  }
  return 0;
}

function evalSegmentAt(seg: PathSegment, t: number): PathPoint {
  switch (seg.type) {
    case 'line': {
      const mt = 1 - t;
      return { x: mt * seg.p0.x + t * seg.p1.x, y: mt * seg.p0.y + t * seg.p1.y };
    }
    case 'quadratic': {
      const mt = 1 - t;
      return {
        x: mt * mt * seg.p0.x + 2 * mt * t * seg.p1.x + t * t * seg.p2.x,
        y: mt * mt * seg.p0.y + 2 * mt * t * seg.p1.y + t * t * seg.p2.y,
      };
    }
    case 'cubic': {
      const mt = 1 - t;
      const mt2 = mt * mt;
      const t2 = t * t;
      return {
        x: mt2 * mt * seg.p0.x + 3 * mt2 * t * seg.p1.x + 3 * mt * t2 * seg.p2.x + t2 * t * seg.p3.x,
        y: mt2 * mt * seg.p0.y + 3 * mt2 * t * seg.p1.y + 3 * mt * t2 * seg.p2.y + t2 * t * seg.p3.y,
      };
    }
  }
}

function curveWindingSubdivide(point: PathPoint, seg: PathSegment, tStart: number, tEnd: number, steps: number): number {
  let winding = 0;
  let prevPt = evalSegmentAt(seg, tStart);
  for (let i = 1; i <= steps; i++) {
    const t = tStart + (tEnd - tStart) * (i / steps);
    const nextPt = evalSegmentAt(seg, t);
    winding += lineWinding(point, prevPt, nextPt);
    prevPt = nextPt;
  }
  return winding;
}

function segmentWinding(point: PathPoint, seg: PathSegment): number {
  switch (seg.type) {
    case 'line': return lineWinding(point, seg.p0, seg.p1);
    case 'quadratic': return curveWindingSubdivide(point, seg, 0, 1, 8);
    case 'cubic': return curveWindingSubdivide(point, seg, 0, 1, 8);
  }
}

function windingNumberFiltered(px: number, py: number, cache: SegmentCache[]): number {
  let winding = 0;
  const point: PathPoint = { x: px, y: py };
  for (let i = 0; i < cache.length; i++) {
    const c = cache[i]!;
    if (c.minY > py || c.maxY <= py) continue;
    winding += segmentWinding(point, c.seg);
  }
  return winding;
}

function computeSDFBrute(
  segments: PathSegment[],
  width = 128,
  height = 128,
  baselineRow = 0,
): SDFGrid {
  const data = new Float64Array(width * height);
  const cache = buildSegmentCache(segments);
  const n = cache.length;

  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    let prevDist = Infinity;

    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      let minDist = prevDist + 1;

      for (let i = 0; i < n; i++) {
        const c = cache[i]!;
        const dx = px < c.minX ? c.minX - px : px > c.maxX ? px - c.maxX : 0;
        const dy = py < c.minY ? c.minY - py : py > c.maxY ? py - c.maxY : 0;
        if (dx * dx + dy * dy >= minDist * minDist) continue;
        const d = pointToSegmentDistance({ x: px, y: py }, c.seg);
        if (d < minDist) minDist = d;
      }

      const wn = windingNumberFiltered(px, py, cache);
      data[y * width + x] = (wn !== 0 ? -1 : 1) * minDist;
      prevDist = minDist;
    }
  }

  return { width, height, data, baselineRow };
}

// ========================================================================
// Benchmark
// ========================================================================

interface TestGlyph {
  label: string;
  char: string;
  code: number;
}

const TEST_GLYPHS: TestGlyph[] = [
  { label: 'a (37 segs)', char: 'a', code: 0x0061 },
  { label: 'z (13 segs)', char: 'z', code: 0x007A },
  { label: 'i (8 segs)',  char: 'i', code: 0x0069 },
  { label: 'O (20 segs)', char: 'O', code: 0x004F },
  { label: 'l (4 segs)',  char: 'l', code: 0x006C },
  { label: 'W (16 segs)', char: 'W', code: 0x0057 },
  { label: '@ (complex)', char: '@', code: 0x0040 },
];

const WARMUP = 5;
const ITERS = 10;

// Distance-only brute-force (winding replaced with no-op)
function computeSDFBruteDistOnly(
  segments: PathSegment[], width = 128, height = 128, baselineRow = 0,
): SDFGrid {
  const data = new Float64Array(width * height);
  const cache = buildSegmentCache(segments);
  const n = cache.length;
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    let prevDist = Infinity;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      let minDist = prevDist + 1;
      for (let i = 0; i < n; i++) {
        const c = cache[i]!;
        const dx = px < c.minX ? c.minX - px : px > c.maxX ? px - c.maxX : 0;
        const dy = py < c.minY ? c.minY - py : py > c.maxY ? py - c.maxY : 0;
        if (dx * dx + dy * dy >= minDist * minDist) continue;
        const d = pointToSegmentDistance({ x: px, y: py }, c.seg);
        if (d < minDist) minDist = d;
      }
      data[y * width + x] = minDist; // no winding
      prevDist = minDist;
    }
  }
  return { width, height, data, baselineRow };
}

// Winding-only brute-force (distance replaced with no-op)
function computeSDFBruteWindOnly(
  segments: PathSegment[], width = 128, height = 128, baselineRow = 0,
): SDFGrid {
  const data = new Float64Array(width * height);
  const cache = buildSegmentCache(segments);
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const wn = windingNumberFiltered(px, py, cache);
      data[y * width + x] = wn;
    }
  }
  return { width, height, data, baselineRow };
}

function timeAvg(fn: () => void, warmup: number, iters: number): number {
  for (let w = 0; w < warmup; w++) fn();
  let total = 0;
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    total += performance.now() - t0;
  }
  return total / iters;
}

function main(): void {
  console.log('=== SDF Benchmark: Brute-Force vs Optimized ===\n');

  const font = loadFont(ARIAL_PATH);
  if (!font) { console.error('Failed to load Arial'); process.exit(1); }

  const metrics = getFontMetrics(font);
  const baselineRow = getBaselineRow(metrics, GRID_SIZE);

  console.log(`Grid: ${GRID_SIZE}x${GRID_SIZE}, baseline: ${baselineRow}`);
  console.log(`Warmup: ${WARMUP}, Iterations: ${ITERS}\n`);

  // --- Part 1: Overall speedup ---
  console.log('--- Overall ---\n');

  const hdr = [
    'Glyph'.padEnd(20),
    'Segs'.padStart(6),
    'Brute ms'.padStart(10),
    'Opt ms'.padStart(10),
    'Speedup'.padStart(10),
    'Max |diff|'.padStart(12),
  ];
  console.log(hdr.join(' | '));
  console.log('-'.repeat(hdr.join(' | ').length));

  let totalBrute = 0;
  let totalOpt = 0;

  interface GlyphData {
    label: string;
    segCount: number;
    segments: PathSegment[];
    bruteMs: number;
    optMs: number;
  }
  const glyphData: GlyphData[] = [];

  for (const glyph of TEST_GLYPHS) {
    const glyphPath = extractGlyphPath(font, glyph.code);
    if (!glyphPath) {
      console.log(`  ${glyph.label}: SKIP (missing glyph)`);
      continue;
    }

    const segments = normalizeToGrid(glyphPath, metrics, GRID_SIZE);
    const segCount = segments.length;

    const bruteMs = timeAvg(
      () => computeSDFBrute(segments, GRID_SIZE, GRID_SIZE, baselineRow),
      WARMUP, ITERS,
    );
    const optMs = timeAvg(
      () => computeSDFOptimized(segments, GRID_SIZE, GRID_SIZE, baselineRow),
      WARMUP, ITERS,
    );

    // Max absolute difference
    const bruteResult = computeSDFBrute(segments, GRID_SIZE, GRID_SIZE, baselineRow);
    const optResult = computeSDFOptimized(segments, GRID_SIZE, GRID_SIZE, baselineRow);
    let maxDiff = 0;
    for (let i = 0; i < bruteResult.data.length; i++) {
      const diff = Math.abs(bruteResult.data[i]! - optResult.data[i]!);
      if (diff > maxDiff) maxDiff = diff;
    }

    totalBrute += bruteMs;
    totalOpt += optMs;
    glyphData.push({ label: glyph.label, segCount, segments, bruteMs, optMs });

    const row = [
      glyph.label.padEnd(20),
      String(segCount).padStart(6),
      bruteMs.toFixed(1).padStart(10),
      optMs.toFixed(1).padStart(10),
      `${(bruteMs / optMs).toFixed(2)}x`.padStart(10),
      maxDiff.toFixed(4).padStart(12),
    ];
    console.log(row.join(' | '));
  }

  console.log('-'.repeat(hdr.join(' | ').length));
  console.log([
    'TOTAL'.padEnd(20),
    ''.padStart(6),
    totalBrute.toFixed(1).padStart(10),
    totalOpt.toFixed(1).padStart(10),
    `${(totalBrute / totalOpt).toFixed(2)}x`.padStart(10),
    ''.padStart(12),
  ].join(' | '));

  // --- Part 2: Cost breakdown (distance vs winding) ---
  console.log('\n--- Cost Breakdown (brute-force, distance vs winding) ---\n');

  const hdr2 = [
    'Glyph'.padEnd(20),
    'Segs'.padStart(6),
    'Full ms'.padStart(10),
    'Dist ms'.padStart(10),
    'Wind ms'.padStart(10),
    'Dist %'.padStart(8),
    'Wind %'.padStart(8),
  ];
  console.log(hdr2.join(' | '));
  console.log('-'.repeat(hdr2.join(' | ').length));

  for (const g of glyphData) {
    const distMs = timeAvg(
      () => computeSDFBruteDistOnly(g.segments, GRID_SIZE, GRID_SIZE, baselineRow),
      WARMUP, ITERS,
    );
    const windMs = timeAvg(
      () => computeSDFBruteWindOnly(g.segments, GRID_SIZE, GRID_SIZE, baselineRow),
      WARMUP, ITERS,
    );
    const distPct = (distMs / g.bruteMs * 100);
    const windPct = (windMs / g.bruteMs * 100);

    console.log([
      g.label.padEnd(20),
      String(g.segCount).padStart(6),
      g.bruteMs.toFixed(1).padStart(10),
      distMs.toFixed(1).padStart(10),
      windMs.toFixed(1).padStart(10),
      `${distPct.toFixed(0)}%`.padStart(8),
      `${windPct.toFixed(0)}%`.padStart(8),
    ].join(' | '));
  }
}

main();
