/**
 * sdf.ts
 *
 * Signed Distance Field computation for glyph outlines.
 * Computes the minimum distance from each grid point to the nearest
 * glyph edge, with sign determined by winding number (negative = inside).
 *
 * Point-to-curve distance:
 * - Line: perpendicular projection + endpoint check
 * - Quadratic Bezier: derivative of squared distance is cubic
 * - Cubic Bezier: recursive subdivision with bounding-box pruning
 */

import type {
  PathPoint,
  PathSegment,
  FontMetricsData,
  SDFGrid,
  SDFComparison,
} from './types.js';

const EPSILON = 1e-10;
const GRID_CELLS = 8;
const BLOCK_SIZE = 4;
const SAFE_MARGIN = 6.0;

/**
 * Compute minimum unsigned distance from a point to a path segment.
 */
export function pointToSegmentDistance(point: PathPoint, segment: PathSegment): number {
  switch (segment.type) {
    case 'line':
      return pointToLineDistance(point, segment.p0, segment.p1);
    case 'quadratic':
      return pointToQuadraticDistance(point, segment.p0, segment.p1, segment.p2);
    case 'cubic':
      return pointToCubicDistance(point, segment.p0, segment.p1, segment.p2, segment.p3);
  }
}

/**
 * Minimum distance from point to line segment [p0, p1].
 * Projects point onto the infinite line, then clamps to the segment.
 */
function pointToLineDistance(point: PathPoint, p0: PathPoint, p1: PathPoint): number {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len2 = dx * dx + dy * dy;

  if (len2 < EPSILON) {
    // Degenerate: zero-length segment
    return Math.hypot(point.x - p0.x, point.y - p0.y);
  }

  // Parameter t of projection onto line
  let t = ((point.x - p0.x) * dx + (point.y - p0.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));

  const projX = p0.x + t * dx;
  const projY = p0.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

/**
 * Minimum distance from point to quadratic Bezier curve.
 * The derivative of squared distance w.r.t. parameter t is a cubic polynomial.
 * We solve for roots and evaluate at roots + endpoints.
 */
function pointToQuadraticDistance(
  point: PathPoint,
  p0: PathPoint,
  p1: PathPoint,
  p2: PathPoint,
): number {
  // B(t) = (1-t)^2 * p0 + 2(1-t)t * p1 + t^2 * p2
  // Rewrite as: B(t) = A*t^2 + B*t + C
  // where A = p0 - 2*p1 + p2, B = 2*(p1 - p0), C = p0
  const ax = p0.x - 2 * p1.x + p2.x;
  const ay = p0.y - 2 * p1.y + p2.y;
  const bx = 2 * (p1.x - p0.x);
  const by = 2 * (p1.y - p0.y);
  const cx = p0.x - point.x;
  const cy = p0.y - point.y;

  // d/dt [dist^2] = d/dt [(ax*t^2 + bx*t + cx)^2 + (ay*t^2 + by*t + cy)^2]
  // = 2 * [curve(t) - point] . curve'(t)
  // curve'(t) = 2*A*t + B
  // This gives a cubic in t: a3*t^3 + a2*t^2 + a1*t + a0 = 0
  const a3 = 2 * (ax * ax + ay * ay);
  const a2 = 3 * (ax * bx + ay * by);
  const a1 = bx * bx + by * by + 2 * (ax * cx + ay * cy);
  const a0 = bx * cx + by * cy;

  const roots = solveCubicRoots(a3, a2, a1, a0);

  // Evaluate distance at all candidate t values (roots + endpoints)
  let minDist = Infinity;
  const candidates = [0, 1, ...roots];

  for (const t of candidates) {
    if (t < -EPSILON || t > 1 + EPSILON) continue;
    const tc = Math.max(0, Math.min(1, t));
    const mt = 1 - tc;
    const px = mt * mt * p0.x + 2 * mt * tc * p1.x + tc * tc * p2.x;
    const py = mt * mt * p0.y + 2 * mt * tc * p1.y + tc * tc * p2.y;
    const dist = Math.hypot(px - point.x, py - point.y);
    if (dist < minDist) minDist = dist;
  }

  return minDist;
}

/**
 * Minimum distance from point to cubic Bezier curve.
 * Uses recursive subdivision with bounding-box pruning.
 * Bisects the curve, prunes halves whose bbox minimum distance exceeds
 * current best, and recurses until dt < 0.001.
 */
function pointToCubicDistance(
  point: PathPoint,
  p0: PathPoint,
  p1: PathPoint,
  p2: PathPoint,
  p3: PathPoint,
): number {
  // Start with endpoint distances as initial best
  let best = Math.min(
    Math.hypot(point.x - p0.x, point.y - p0.y),
    Math.hypot(point.x - p3.x, point.y - p3.y),
  );

  // Recursive subdivision
  best = subdivideCubic(point, p0, p1, p2, p3, 0, 1, best, 0);
  return best;
}

/**
 * Recursively subdivide a cubic Bezier to find minimum distance to a point.
 */
function subdivideCubic(
  point: PathPoint,
  p0: PathPoint,
  p1: PathPoint,
  p2: PathPoint,
  p3: PathPoint,
  tStart: number,
  tEnd: number,
  currentBest: number,
  depth: number,
): number {
  // Bounding box of control points
  const minX = Math.min(p0.x, p1.x, p2.x, p3.x);
  const minY = Math.min(p0.y, p1.y, p2.y, p3.y);
  const maxX = Math.max(p0.x, p1.x, p2.x, p3.x);
  const maxY = Math.max(p0.y, p1.y, p2.y, p3.y);

  // Minimum distance from point to bounding box
  const bboxDist = distToBBox(point, minX, minY, maxX, maxY);
  if (bboxDist >= currentBest) return currentBest; // Prune

  const dt = tEnd - tStart;
  if (dt < 0.001 || depth > 20) {
    // Evaluate at midpoint
    const tMid = (tStart + tEnd) / 2;
    const pt = evalCubicPoint(p0, p1, p2, p3, 0.5); // 0.5 relative to this sub-curve
    const dist = Math.hypot(pt.x - point.x, pt.y - point.y);
    return Math.min(currentBest, dist);
  }

  // De Casteljau split at t=0.5
  const [left, right] = splitCubic(p0, p1, p2, p3);
  const tMid = (tStart + tEnd) / 2;

  // Recurse into closer half first for better pruning
  const leftDist = distToBBox(point,
    Math.min(left[0].x, left[1].x, left[2].x, left[3].x),
    Math.min(left[0].y, left[1].y, left[2].y, left[3].y),
    Math.max(left[0].x, left[1].x, left[2].x, left[3].x),
    Math.max(left[0].y, left[1].y, left[2].y, left[3].y),
  );
  const rightDist = distToBBox(point,
    Math.min(right[0].x, right[1].x, right[2].x, right[3].x),
    Math.min(right[0].y, right[1].y, right[2].y, right[3].y),
    Math.max(right[0].x, right[1].x, right[2].x, right[3].x),
    Math.max(right[0].y, right[1].y, right[2].y, right[3].y),
  );

  let best = currentBest;
  if (leftDist < rightDist) {
    best = subdivideCubic(point, left[0], left[1], left[2], left[3], tStart, tMid, best, depth + 1);
    best = subdivideCubic(point, right[0], right[1], right[2], right[3], tMid, tEnd, best, depth + 1);
  } else {
    best = subdivideCubic(point, right[0], right[1], right[2], right[3], tMid, tEnd, best, depth + 1);
    best = subdivideCubic(point, left[0], left[1], left[2], left[3], tStart, tMid, best, depth + 1);
  }

  return best;
}

/** De Casteljau split of cubic Bezier at t=0.5 */
function splitCubic(
  p0: PathPoint, p1: PathPoint, p2: PathPoint, p3: PathPoint,
): [PathPoint[], PathPoint[]] {
  const m01 = mid(p0, p1);
  const m12 = mid(p1, p2);
  const m23 = mid(p2, p3);
  const m012 = mid(m01, m12);
  const m123 = mid(m12, m23);
  const m0123 = mid(m012, m123);

  return [
    [p0, m01, m012, m0123],
    [m0123, m123, m23, p3],
  ];
}

function mid(a: PathPoint, b: PathPoint): PathPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Evaluate cubic Bezier at parameter t (relative, 0-1) */
function evalCubicPoint(p0: PathPoint, p1: PathPoint, p2: PathPoint, p3: PathPoint, t: number): PathPoint {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
  };
}

/** Minimum distance from a point to an axis-aligned bounding box */
function distToBBox(p: PathPoint, minX: number, minY: number, maxX: number, maxY: number): number {
  const dx = Math.max(minX - p.x, 0, p.x - maxX);
  const dy = Math.max(minY - p.y, 0, p.y - maxY);
  return Math.hypot(dx, dy);
}

/**
 * Solve cubic equation a*t^3 + b*t^2 + c*t + d = 0.
 * Returns real roots (not filtered to [0,1]).
 */
function solveCubicRoots(a: number, b: number, c: number, d: number): number[] {
  if (Math.abs(a) < EPSILON) {
    return solveQuadraticRoots(b, c, d);
  }

  const p = b / a;
  const q = c / a;
  const r = d / a;

  const p2 = (3 * q - p * p) / 3;
  const q2 = (2 * p * p * p - 9 * p * q + 27 * r) / 27;
  const discriminant = q2 * q2 / 4 + p2 * p2 * p2 / 27;
  const offset = -p / 3;

  const roots: number[] = [];

  if (Math.abs(discriminant) < EPSILON) {
    if (Math.abs(q2) < EPSILON) {
      roots.push(offset);
    } else {
      const u = Math.cbrt(-q2 / 2);
      roots.push(2 * u + offset);
      roots.push(-u + offset);
    }
  } else if (discriminant > 0) {
    const sqrtD = Math.sqrt(discriminant);
    const u = Math.cbrt(-q2 / 2 + sqrtD);
    const v = Math.cbrt(-q2 / 2 - sqrtD);
    roots.push(u + v + offset);
  } else {
    const m = 2 * Math.sqrt(-p2 / 3);
    const theta = Math.acos(3 * q2 / (p2 * m)) / 3;
    roots.push(m * Math.cos(theta) + offset);
    roots.push(m * Math.cos(theta - 2 * Math.PI / 3) + offset);
    roots.push(m * Math.cos(theta - 4 * Math.PI / 3) + offset);
  }

  return roots;
}

function solveQuadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) < EPSILON) return [];
    return [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const sqrtD = Math.sqrt(disc);
  return [(-b - sqrtD) / (2 * a), (-b + sqrtD) / (2 * a)];
}

/**
 * Compute the winding number of a point relative to glyph outline segments.
 * Uses horizontal ray casting: count signed crossings of a rightward ray.
 *
 * Positive winding number = inside glyph.
 */
export function windingNumber(point: PathPoint, segments: PathSegment[]): number {
  let winding = 0;

  for (const seg of segments) {
    winding += segmentWinding(point, seg);
  }

  return winding;
}

/**
 * Winding contribution from a single segment using horizontal ray.
 * Counts upward crossings as +1, downward crossings as -1.
 */
function segmentWinding(point: PathPoint, seg: PathSegment): number {
  switch (seg.type) {
    case 'line':
      return lineWinding(point, seg.p0, seg.p1);
    case 'quadratic':
      return curveWindingSubdivide(point, seg, 0, 1, 8);
    case 'cubic':
      return curveWindingSubdivide(point, seg, 0, 1, 8);
  }
}

/**
 * Winding contribution from a line segment using horizontal ray.
 */
function lineWinding(point: PathPoint, p0: PathPoint, p1: PathPoint): number {
  // Ray goes rightward from point. Only count segments that straddle point.y.
  if (p0.y <= point.y) {
    if (p1.y <= point.y) return 0; // Both below
    // Upward crossing
    const t = (point.y - p0.y) / (p1.y - p0.y);
    const xAt = p0.x + t * (p1.x - p0.x);
    if (xAt > point.x) return 1;
  } else {
    if (p1.y > point.y) return 0; // Both above
    // Downward crossing
    const t = (point.y - p0.y) / (p1.y - p0.y);
    const xAt = p0.x + t * (p1.x - p0.x);
    if (xAt > point.x) return -1;
  }
  return 0;
}

/**
 * Winding contribution from a curve segment via linearisation.
 * Subdivides the curve into small line segments and sums their winding.
 */
function curveWindingSubdivide(
  point: PathPoint,
  seg: PathSegment,
  tStart: number,
  tEnd: number,
  steps: number,
): number {
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

/** Evaluate a path segment at parameter t */
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

/** Precomputed segment metadata for fast SDF queries */
interface SegmentCache {
  seg: PathSegment;
  minX: number; minY: number; maxX: number; maxY: number;
}

/** Spatial grid for accelerated nearest-segment queries */
interface SpatialGrid {
  cellsX: number;
  cellsY: number;
  cellW: number;
  cellH: number;
  cells: Int32Array[];
}

/** Y-sorted segment index for fast winding-number queries */
interface WindingIndex {
  sortedByMinY: Int32Array;
  minYs: Float64Array;
}

/**
 * Build segment cache: precompute bounding boxes once for all segments.
 * Used by computeSDF to avoid recomputing per-pixel.
 */
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
    return { seg, minX, minY, maxX, maxY };
  });
}

/**
 * Build a spatial grid that bins segment indices by bounding-box overlap.
 * Each cell stores an Int32Array of indices into the SegmentCache array.
 */
function buildSpatialGrid(cache: SegmentCache[], width: number, height: number): SpatialGrid {
  const cellsX = GRID_CELLS;
  const cellsY = GRID_CELLS;
  const cellW = width / cellsX;
  const cellH = height / cellsY;

  const buckets: number[][] = [];
  for (let i = 0; i < cellsX * cellsY; i++) buckets.push([]);

  for (let i = 0; i < cache.length; i++) {
    const c = cache[i]!;
    const colMin = Math.max(0, Math.floor(c.minX / cellW));
    const colMax = Math.min(cellsX - 1, Math.floor(c.maxX / cellW));
    const rowMin = Math.max(0, Math.floor(c.minY / cellH));
    const rowMax = Math.min(cellsY - 1, Math.floor(c.maxY / cellH));

    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        buckets[row * cellsX + col]!.push(i);
      }
    }
  }

  return {
    cellsX, cellsY, cellW, cellH,
    cells: buckets.map(b => new Int32Array(b)),
  };
}

/**
 * Build a Y-sorted index for fast winding-number queries.
 * Segments sorted by minY enable binary search to skip segments above py.
 */
function buildWindingIndex(cache: SegmentCache[]): WindingIndex {
  const n = cache.length;
  const idxArray: number[] = [];
  for (let i = 0; i < n; i++) idxArray.push(i);
  idxArray.sort((a, b) => cache[a]!.minY - cache[b]!.minY);

  const sortedByMinY = new Int32Array(idxArray);
  const minYs = new Float64Array(n);
  for (let i = 0; i < n; i++) minYs[i] = cache[sortedByMinY[i]!]!.minY;

  return { sortedByMinY, minYs };
}

/** Binary search: index of first element in sorted array where value > target */
function upperBound(arr: Float64Array, target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** No-alloc line winding: scalar args instead of PathPoint objects */
function lineWindingXY(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  if (y0 <= py) {
    if (y1 <= py) return 0;
    const t = (py - y0) / (y1 - y0);
    if (x0 + t * (x1 - x0) > px) return 1;
  } else {
    if (y1 > py) return 0;
    const t = (py - y0) / (y1 - y0);
    if (x0 + t * (x1 - x0) > px) return -1;
  }
  return 0;
}

/** No-alloc winding for a single segment (inlines curve evaluation) */
function segmentWindingXY(px: number, py: number, seg: PathSegment): number {
  if (seg.type === 'line') {
    return lineWindingXY(px, py, seg.p0.x, seg.p0.y, seg.p1.x, seg.p1.y);
  }
  let winding = 0;
  let prevX = seg.p0.x, prevY = seg.p0.y;
  for (let i = 1; i <= 8; i++) {
    const t = i * 0.125;
    let nextX: number, nextY: number;
    if (seg.type === 'quadratic') {
      const mt = 1 - t;
      nextX = mt * mt * seg.p0.x + 2 * mt * t * seg.p1.x + t * t * seg.p2.x;
      nextY = mt * mt * seg.p0.y + 2 * mt * t * seg.p1.y + t * t * seg.p2.y;
    } else {
      const mt = 1 - t;
      const mt2 = mt * mt;
      const t2 = t * t;
      nextX = mt2 * mt * seg.p0.x + 3 * mt2 * t * seg.p1.x + 3 * mt * t2 * seg.p2.x + t2 * t * seg.p3.x;
      nextY = mt2 * mt * seg.p0.y + 3 * mt2 * t * seg.p1.y + 3 * mt * t2 * seg.p2.y + t2 * t * seg.p3.y;
    }
    winding += lineWindingXY(px, py, prevX, prevY, nextX, nextY);
    prevX = nextX;
    prevY = nextY;
  }
  return winding;
}

/**
 * Winding number using Y-sorted binary search + no-alloc evaluation.
 * Binary search skips all segments with minY > py.
 */
function windingNumberSorted(
  px: number,
  py: number,
  cache: SegmentCache[],
  windIdx: WindingIndex,
): number {
  const hiIdx = upperBound(windIdx.minYs, py);
  let winding = 0;
  const sorted = windIdx.sortedByMinY;
  for (let i = 0; i < hiIdx; i++) {
    const c = cache[sorted[i]!]!;
    if (c.maxY <= py) continue;
    winding += segmentWindingXY(px, py, c.seg);
  }
  return winding;
}

/**
 * Search one spatial grid cell for a closer segment.
 * Returns updated minDist (may be unchanged if nothing closer found).
 */
function searchGridCell(
  cellIdx: number,
  point: PathPoint,
  cache: SegmentCache[],
  grid: SpatialGrid,
  minDist: number,
): number {
  const indices = grid.cells[cellIdx]!;
  const px = point.x, py = point.y;
  for (let j = 0; j < indices.length; j++) {
    const c = cache[indices[j]!]!;
    const dx = px < c.minX ? c.minX - px : px > c.maxX ? px - c.maxX : 0;
    const dy = py < c.minY ? c.minY - py : py > c.maxY ? py - c.maxY : 0;
    if (dx * dx + dy * dy >= minDist * minDist) continue;
    const d = pointToSegmentDistance(point, c.seg);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Find minimum distance from a point to any segment using the spatial grid.
 * Searches outward from the pixel's cell in concentric rings (Chebyshev distance).
 * Stops early when ring distance exceeds current best.
 */
function findMinDistanceSpatial(
  point: PathPoint,
  cache: SegmentCache[],
  grid: SpatialGrid,
  initialBound: number,
): number {
  let minDist = initialBound;
  const px = point.x, py = point.y;
  const centerCol = Math.max(0, Math.min(grid.cellsX - 1, Math.floor(px / grid.cellW)));
  const centerRow = Math.max(0, Math.min(grid.cellsY - 1, Math.floor(py / grid.cellH)));
  const minCellDim = Math.min(grid.cellW, grid.cellH);
  const maxRing = Math.max(
    centerCol, centerRow,
    grid.cellsX - 1 - centerCol, grid.cellsY - 1 - centerRow,
  );

  for (let ring = 0; ring <= maxRing; ring++) {
    if (ring >= 2 && (ring - 1) * minCellDim >= minDist) break;

    if (ring === 0) {
      minDist = searchGridCell(centerRow * grid.cellsX + centerCol, point, cache, grid, minDist);
      continue;
    }

    const rMin = centerRow - ring;
    const rMax = centerRow + ring;
    const cMin = centerCol - ring;
    const cMax = centerCol + ring;

    // Top row
    if (rMin >= 0) {
      for (let col = Math.max(0, cMin); col <= Math.min(grid.cellsX - 1, cMax); col++) {
        minDist = searchGridCell(rMin * grid.cellsX + col, point, cache, grid, minDist);
      }
    }
    // Bottom row
    if (rMax < grid.cellsY && rMax !== rMin) {
      for (let col = Math.max(0, cMin); col <= Math.min(grid.cellsX - 1, cMax); col++) {
        minDist = searchGridCell(rMax * grid.cellsX + col, point, cache, grid, minDist);
      }
    }
    // Left column (excluding corners already covered by top/bottom)
    if (cMin >= 0) {
      for (let row = Math.max(0, rMin + 1); row <= Math.min(grid.cellsY - 1, rMax - 1); row++) {
        minDist = searchGridCell(row * grid.cellsX + cMin, point, cache, grid, minDist);
      }
    }
    // Right column (excluding corners)
    if (cMax < grid.cellsX && cMax !== cMin) {
      for (let row = Math.max(0, rMin + 1); row <= Math.min(grid.cellsY - 1, rMax - 1); row++) {
        minDist = searchGridCell(row * grid.cellsX + cMax, point, cache, grid, minDist);
      }
    }
  }

  return minDist;
}

/**
 * Bilinear interpolation from coarse SDF grid to fine pixel position.
 */
function bilinearInterpolate(
  coarseData: Float64Array,
  coarseW: number,
  coarseH: number,
  fineX: number,
  fineY: number,
  blockSize: number,
): number {
  const halfBlock = blockSize * 0.5;
  const u = (fineX + 0.5 - halfBlock) / blockSize;
  const v = (fineY + 0.5 - halfBlock) / blockSize;

  const i0 = Math.max(0, Math.min(coarseW - 1, Math.floor(u)));
  const j0 = Math.max(0, Math.min(coarseH - 1, Math.floor(v)));
  const i1 = Math.min(coarseW - 1, i0 + 1);
  const j1 = Math.min(coarseH - 1, j0 + 1);

  const fx = Math.max(0, Math.min(1, u - i0));
  const fy = Math.max(0, Math.min(1, v - j0));

  const v00 = coarseData[j0 * coarseW + i0]!;
  const v10 = coarseData[j0 * coarseW + i1]!;
  const v01 = coarseData[j1 * coarseW + i0]!;
  const v11 = coarseData[j1 * coarseW + i1]!;

  return (1 - fx) * (1 - fy) * v00 + fx * (1 - fy) * v10
       + (1 - fx) * fy * v01 + fx * fy * v11;
}

/**
 * Compute a signed distance field for glyph outline segments.
 *
 * For each grid point, finds the minimum unsigned distance to any segment,
 * then applies sign via winding number (negative = inside glyph).
 *
 * The grid is anchored to font metrics so that the baseline sits at a
 * consistent row across different glyphs, enabling direct comparison.
 *
 * Performance optimizations:
 * - Precomputed segment bounding boxes: skip segments whose bbox min
 *   distance >= current best (avoids expensive curve distance calls)
 * - Row coherence: triangle inequality gives |d(x) - d(x-1)| <= 1,
 *   so previous pixel's distance + 1 is a tight initial upper bound
 * - Winding Y-range filter: skip segments whose Y range cannot contribute
 *   a horizontal ray crossing at the query point's Y coordinate
 *
 * @param segments - Glyph outline in grid coordinates (already normalised)
 * @param width - Grid width (default 128)
 * @param height - Grid height (default 128)
 * @param baselineRow - Grid row corresponding to the baseline
 */
export function computeSDF(
  segments: PathSegment[],
  width = 128,
  height = 128,
  baselineRow = 0,
): SDFGrid {
  const cache = buildSegmentCache(segments);
  if (cache.length < 25) {
    return computeSDFSimple(cache, width, height, baselineRow);
  }
  return computeSDFAccelerated(cache, width, height, baselineRow);
}

/** Brute-force SDF for simple glyphs (< 25 segments). Separate function
 *  so V8 can optimise each path independently. */
function computeSDFSimple(
  cache: SegmentCache[],
  width: number,
  height: number,
  baselineRow: number,
): SDFGrid {
  const data = new Float64Array(width * height);
  const n = cache.length;
  const point: PathPoint = { x: 0, y: 0 };

  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    let prevDist = Infinity;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      point.x = px; point.y = py;
      let minDist = prevDist + 1;
      for (let i = 0; i < n; i++) {
        const c = cache[i]!;
        const dx = px < c.minX ? c.minX - px : px > c.maxX ? px - c.maxX : 0;
        const dy = py < c.minY ? c.minY - py : py > c.maxY ? py - c.maxY : 0;
        if (dx * dx + dy * dy >= minDist * minDist) continue;
        const d = pointToSegmentDistance(point, c.seg);
        if (d < minDist) minDist = d;
      }
      const wn = windingNumberFiltered(px, py, cache);
      data[y * width + x] = (wn !== 0 ? -1 : 1) * minDist;
      prevDist = minDist;
    }
  }
  return { width, height, data, baselineRow };
}

/** Spatial grid + coarse-to-fine SDF for complex glyphs (>= 25 segments). */
function computeSDFAccelerated(
  cache: SegmentCache[],
  width: number,
  height: number,
  baselineRow: number,
): SDFGrid {
  const data = new Float64Array(width * height);
  const grid = buildSpatialGrid(cache, width, height);
  const windIdx = buildWindingIndex(cache);
  const point: PathPoint = { x: 0, y: 0 };

  // Phase 1: Coarse pass at 1/BLOCK_SIZE resolution
  const coarseW = Math.ceil(width / BLOCK_SIZE);
  const coarseH = Math.ceil(height / BLOCK_SIZE);
  const coarseData = new Float64Array(coarseW * coarseH);
  const halfBlock = BLOCK_SIZE * 0.5;

  for (let cy = 0; cy < coarseH; cy++) {
    const py = cy * BLOCK_SIZE + halfBlock;
    let prevDist = Infinity;

    for (let cx = 0; cx < coarseW; cx++) {
      const px = cx * BLOCK_SIZE + halfBlock;
      point.x = px; point.y = py;
      const minDist = findMinDistanceSpatial(point, cache, grid, prevDist + BLOCK_SIZE);
      const wn = windingNumberSorted(px, py, cache, windIdx);
      coarseData[cy * coarseW + cx] = (wn !== 0 ? -1 : 1) * minDist;
      prevDist = minDist;
    }
  }

  // Phase 2: Classify blocks -- exact near boundary, interpolate far away
  const exactBlock = new Uint8Array(coarseW * coarseH);
  for (let i = 0; i < coarseData.length; i++) {
    if (Math.abs(coarseData[i]!) <= SAFE_MARGIN) exactBlock[i] = 1;
  }

  // Phase 3: Fine pass (full resolution), row by row
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    let prevDist = Infinity;

    for (let x = 0; x < width; x++) {
      const blockIdx = Math.floor(y / BLOCK_SIZE) * coarseW + Math.floor(x / BLOCK_SIZE);

      if (exactBlock[blockIdx]!) {
        const px = x + 0.5;
        point.x = px; point.y = py;
        const minDist = findMinDistanceSpatial(point, cache, grid, prevDist + 1);
        const wn = windingNumberSorted(px, py, cache, windIdx);
        data[y * width + x] = (wn !== 0 ? -1 : 1) * minDist;
        prevDist = minDist;
      } else {
        const value = bilinearInterpolate(coarseData, coarseW, coarseH, x, y, BLOCK_SIZE);
        data[y * width + x] = value;
        prevDist = Math.abs(value);
      }
    }
  }

  return { width, height, data, baselineRow };
}

/**
 * Winding number with Y-range pre-filter.
 * Skips segments whose control-point Y range cannot contribute a
 * horizontal ray crossing at the query Y coordinate.
 */
function windingNumberFiltered(px: number, py: number, cache: SegmentCache[]): number {
  let winding = 0;
  const point: PathPoint = { x: px, y: py };

  for (let i = 0; i < cache.length; i++) {
    const c = cache[i]!;
    // Y-range filter: if all control points are above or all below py,
    // no horizontal ray crossing is possible
    if (c.minY > py || c.maxY <= py) continue;

    winding += segmentWinding(point, c.seg);
  }

  return winding;
}

/**
 * Compare two SDF grids.
 * Both grids must have the same dimensions.
 *
 * Returns:
 * - l2: normalised L2 distance (RMS of differences)
 * - ncc: normalised cross-correlation (-1 to 1, 1 = identical)
 */
export function compareSDF(a: SDFGrid, b: SDFGrid): SDFComparison {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`SDF dimension mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }

  const n = a.data.length;

  // L2 distance (RMS)
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const diff = a.data[i]! - b.data[i]!;
    sumSq += diff * diff;
  }
  const l2 = Math.sqrt(sumSq / n);

  // NCC: (sum(a*b) - n*meanA*meanB) / (n * stdA * stdB)
  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (let i = 0; i < n; i++) {
    const va = a.data[i]!;
    const vb = b.data[i]!;
    sumA += va;
    sumB += vb;
    sumAB += va * vb;
    sumA2 += va * va;
    sumB2 += vb * vb;
  }

  const meanA = sumA / n;
  const meanB = sumB / n;
  const varA = sumA2 / n - meanA * meanA;
  const varB = sumB2 / n - meanB * meanB;
  const stdA = Math.sqrt(Math.max(0, varA));
  const stdB = Math.sqrt(Math.max(0, varB));

  let ncc: number;
  if (stdA < EPSILON || stdB < EPSILON) {
    // One or both SDFs are constant -- NCC undefined, use 1 if identical
    ncc = (stdA < EPSILON && stdB < EPSILON && Math.abs(meanA - meanB) < EPSILON) ? 1 : 0;
  } else {
    ncc = (sumAB / n - meanA * meanB) / (stdA * stdB);
    // Clamp to [-1, 1] for floating point safety
    ncc = Math.max(-1, Math.min(1, ncc));
  }

  return { l2, ncc };
}
