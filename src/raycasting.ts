/**
 * raycasting.ts
 *
 * Ray intersection engine for topological glyph comparison.
 * Projects Bezier curves onto a ray's perpendicular axis and solves
 * for intersection parameters. Builds multi-angle intersection count
 * signatures that capture the structural topology of glyph outlines.
 *
 * Core math: for a ray with origin O and direction D, define normal
 * n = perpendicular to D. Solve n . (B(s) - O) = 0 for parameter s,
 * then check that the ray parameter t >= 0 (forward direction).
 */

import type {
  PathPoint,
  PathSegment,
  RayResult,
  AngleSignature,
  TopologicalSignature,
} from './types.js';

const EPSILON = 1e-10;

/**
 * Solve ax^2 + bx + c = 0. Returns real roots in [0, 1].
 */
export function solveQuadratic(a: number, b: number, c: number): number[] {
  const roots: number[] = [];

  if (Math.abs(a) < EPSILON) {
    // Linear: bx + c = 0
    if (Math.abs(b) < EPSILON) return roots;
    const t = -c / b;
    if (t >= -EPSILON && t <= 1 + EPSILON) {
      roots.push(Math.max(0, Math.min(1, t)));
    }
    return roots;
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < -EPSILON) return roots;

  const sqrtD = Math.sqrt(Math.max(0, discriminant));
  const t1 = (-b - sqrtD) / (2 * a);
  const t2 = (-b + sqrtD) / (2 * a);

  if (t1 >= -EPSILON && t1 <= 1 + EPSILON) {
    roots.push(Math.max(0, Math.min(1, t1)));
  }
  if (t2 >= -EPSILON && t2 <= 1 + EPSILON && Math.abs(t2 - t1) > EPSILON) {
    roots.push(Math.max(0, Math.min(1, t2)));
  }

  return roots;
}

/**
 * Solve ax^3 + bx^2 + cx + d = 0 using Cardano's formula.
 * Returns real roots in [0, 1].
 */
export function solveCubic(a: number, b: number, c: number, d: number): number[] {
  if (Math.abs(a) < EPSILON) {
    return solveQuadratic(b, c, d);
  }

  // Normalise: x^3 + px^2 + qx + r = 0
  const p = b / a;
  const q = c / a;
  const r = d / a;

  // Depressed cubic: t^3 + pt2 * t + q2 = 0, where x = t - p/3
  const p2 = (3 * q - p * p) / 3;
  const q2 = (2 * p * p * p - 9 * p * q + 27 * r) / 27;

  const discriminant = q2 * q2 / 4 + p2 * p2 * p2 / 27;
  const offset = -p / 3;

  const roots: number[] = [];

  if (Math.abs(discriminant) < EPSILON) {
    // Repeated roots
    if (Math.abs(q2) < EPSILON) {
      // Triple root
      addRoot(roots, offset);
    } else {
      const u = Math.cbrt(-q2 / 2);
      addRoot(roots, 2 * u + offset);
      addRoot(roots, -u + offset);
    }
  } else if (discriminant > 0) {
    // One real root
    const sqrtD = Math.sqrt(discriminant);
    const u = Math.cbrt(-q2 / 2 + sqrtD);
    const v = Math.cbrt(-q2 / 2 - sqrtD);
    addRoot(roots, u + v + offset);
  } else {
    // Three real roots (casus irreducibilis)
    const m = 2 * Math.sqrt(-p2 / 3);
    const theta = Math.acos(3 * q2 / (p2 * m)) / 3;
    addRoot(roots, m * Math.cos(theta) + offset);
    addRoot(roots, m * Math.cos(theta - 2 * Math.PI / 3) + offset);
    addRoot(roots, m * Math.cos(theta - 4 * Math.PI / 3) + offset);
  }

  return roots;
}

/** Add a root to the array if it falls within [0, 1] (with tolerance) */
function addRoot(roots: number[], t: number): void {
  if (t >= -EPSILON && t <= 1 + EPSILON) {
    roots.push(Math.max(0, Math.min(1, t)));
  }
}

/**
 * Evaluate a point on a quadratic Bezier at parameter t.
 */
function evalQuadratic(p0: PathPoint, p1: PathPoint, p2: PathPoint, t: number): PathPoint {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

/**
 * Evaluate a point on a cubic Bezier at parameter t.
 */
function evalCubic(p0: PathPoint, p1: PathPoint, p2: PathPoint, p3: PathPoint, t: number): PathPoint {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
  };
}

/**
 * Find intersection parameters where a ray crosses a path segment.
 *
 * Ray: R(t) = origin + t * direction, t >= 0
 * Normal n is perpendicular to direction: n = (-direction.y, direction.x)
 * Solve: n . (B(s) - origin) = 0 for s in [0,1], then verify t >= 0.
 *
 * Returns the ray parameter t values for each valid intersection.
 */
export function raySegmentIntersections(
  origin: PathPoint,
  direction: PathPoint,
  segment: PathSegment,
): number[] {
  const nx = -direction.y;
  const ny = direction.x;

  // Project segment control points onto normal axis, relative to origin
  function project(p: PathPoint): number {
    return nx * (p.x - origin.x) + ny * (p.y - origin.y);
  }

  let sRoots: number[];

  switch (segment.type) {
    case 'line': {
      const d0 = project(segment.p0);
      const d1 = project(segment.p1);
      // Linear: d0 + s * (d1 - d0) = 0
      sRoots = solveQuadratic(0, d1 - d0, d0);
      break;
    }

    case 'quadratic': {
      const d0 = project(segment.p0);
      const d1 = project(segment.p1);
      const d2 = project(segment.p2);
      // Quadratic Bezier projected: (d0 - 2*d1 + d2)*s^2 + 2*(d1-d0)*s + d0 = 0
      const a = d0 - 2 * d1 + d2;
      const b = 2 * (d1 - d0);
      const c = d0;
      sRoots = solveQuadratic(a, b, c);
      break;
    }

    case 'cubic': {
      const d0 = project(segment.p0);
      const d1 = project(segment.p1);
      const d2 = project(segment.p2);
      const d3 = project(segment.p3);
      // Cubic Bezier projected:
      // (-d0 + 3*d1 - 3*d2 + d3)*s^3 + (3*d0 - 6*d1 + 3*d2)*s^2 + (-3*d0 + 3*d1)*s + d0 = 0
      const a = -d0 + 3 * d1 - 3 * d2 + d3;
      const b = 3 * d0 - 6 * d1 + 3 * d2;
      const c = -3 * d0 + 3 * d1;
      sRoots = solveCubic(a, b, c, d0);
      break;
    }
  }

  // For each valid s root, compute the ray parameter t and filter
  const tValues: number[] = [];
  const dirLen2 = direction.x * direction.x + direction.y * direction.y;

  for (const s of sRoots) {
    let point: PathPoint;
    switch (segment.type) {
      case 'line': {
        const mt = 1 - s;
        point = {
          x: mt * segment.p0.x + s * segment.p1.x,
          y: mt * segment.p0.y + s * segment.p1.y,
        };
        break;
      }
      case 'quadratic':
        point = evalQuadratic(segment.p0, segment.p1, segment.p2, s);
        break;
      case 'cubic':
        point = evalCubic(segment.p0, segment.p1, segment.p2, segment.p3, s);
        break;
    }

    // Compute t along ray direction
    // R(t) = origin + t * direction => t = (point - origin) . direction / |direction|^2
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const t = (dx * direction.x + dy * direction.y) / dirLen2;

    if (t >= -EPSILON) {
      tValues.push(Math.max(0, t));
    }
  }

  return tValues;
}

/** Result from enriched ray-segment intersection: ray parameter + crossing angle + geometry. */
export interface EnrichedHit {
  /** Ray parameter t (distance along ray from origin) */
  t: number;
  /** Angle between ray direction and curve tangent at intersection, in [0, pi/2].
   *  0 = grazing (ray parallel to curve), pi/2 = perpendicular. */
  crossingAngle: number;
  /** Intersection point on curve (grid coordinates) */
  hitPoint: PathPoint;
  /** Bezier tangent B'(s) at intersection, unnormalized */
  tangent: PathPoint;
}

/**
 * Find intersection parameters + crossing angles where a ray crosses a segment.
 *
 * Same root-finding as raySegmentIntersections(), but also computes the Bezier
 * tangent B'(s) at each intersection and the angle between it and the ray
 * direction. The crossing angle captures local edge orientation -- circular
 * features (dots) produce near-perpendicular crossings while diagonal strokes
 * (accents) produce grazing crossings.
 */
export function raySegmentIntersectionsEnriched(
  origin: PathPoint,
  direction: PathPoint,
  segment: PathSegment,
): EnrichedHit[] {
  const nx = -direction.y;
  const ny = direction.x;

  function project(p: PathPoint): number {
    return nx * (p.x - origin.x) + ny * (p.y - origin.y);
  }

  let sRoots: number[];

  switch (segment.type) {
    case 'line': {
      const d0 = project(segment.p0);
      const d1 = project(segment.p1);
      sRoots = solveQuadratic(0, d1 - d0, d0);
      break;
    }
    case 'quadratic': {
      const d0 = project(segment.p0);
      const d1 = project(segment.p1);
      const d2 = project(segment.p2);
      const a = d0 - 2 * d1 + d2;
      const b = 2 * (d1 - d0);
      const c = d0;
      sRoots = solveQuadratic(a, b, c);
      break;
    }
    case 'cubic': {
      const d0 = project(segment.p0);
      const d1 = project(segment.p1);
      const d2 = project(segment.p2);
      const d3 = project(segment.p3);
      const a = -d0 + 3 * d1 - 3 * d2 + d3;
      const b = 3 * d0 - 6 * d1 + 3 * d2;
      const c = -3 * d0 + 3 * d1;
      sRoots = solveCubic(a, b, c, d0);
      break;
    }
  }

  const dirLen = Math.hypot(direction.x, direction.y);
  const dirLen2 = direction.x * direction.x + direction.y * direction.y;
  const results: EnrichedHit[] = [];

  for (const s of sRoots) {
    // Evaluate point on curve
    let point: PathPoint;
    switch (segment.type) {
      case 'line': {
        const mt = 1 - s;
        point = {
          x: mt * segment.p0.x + s * segment.p1.x,
          y: mt * segment.p0.y + s * segment.p1.y,
        };
        break;
      }
      case 'quadratic':
        point = evalQuadratic(segment.p0, segment.p1, segment.p2, s);
        break;
      case 'cubic':
        point = evalCubic(segment.p0, segment.p1, segment.p2, segment.p3, s);
        break;
    }

    // Compute ray parameter t
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const t = (dx * direction.x + dy * direction.y) / dirLen2;

    if (t >= -EPSILON) {
      // Compute tangent B'(s) at intersection point
      let tx: number, ty: number;
      switch (segment.type) {
        case 'line':
          tx = segment.p1.x - segment.p0.x;
          ty = segment.p1.y - segment.p0.y;
          break;
        case 'quadratic': {
          const ms = 1 - s;
          tx = 2 * ms * (segment.p1.x - segment.p0.x) + 2 * s * (segment.p2.x - segment.p1.x);
          ty = 2 * ms * (segment.p1.y - segment.p0.y) + 2 * s * (segment.p2.y - segment.p1.y);
          break;
        }
        case 'cubic': {
          const ms = 1 - s;
          const ms2 = ms * ms;
          const s2 = s * s;
          tx = 3 * ms2 * (segment.p1.x - segment.p0.x) + 6 * ms * s * (segment.p2.x - segment.p1.x) + 3 * s2 * (segment.p3.x - segment.p2.x);
          ty = 3 * ms2 * (segment.p1.y - segment.p0.y) + 6 * ms * s * (segment.p2.y - segment.p1.y) + 3 * s2 * (segment.p3.y - segment.p2.y);
          break;
        }
      }

      // Crossing angle: acos(|D . T| / (|D| * |T|)), result in [0, pi/2]
      const tangentLen = Math.hypot(tx, ty);
      let crossingAngle: number;
      if (tangentLen < EPSILON || dirLen < EPSILON) {
        // Degenerate tangent (cusp, zero-length segment) -- treat as perpendicular
        crossingAngle = Math.PI / 2;
      } else {
        const cosAngle = Math.abs(direction.x * tx + direction.y * ty) / (dirLen * tangentLen);
        crossingAngle = Math.acos(Math.min(1, cosAngle));
      }

      results.push({ t: Math.max(0, t), crossingAngle, hitPoint: point, tangent: { x: tx, y: ty } });
    }
  }

  return results;
}

const PING_EPSILON = 1e-4;

/**
 * Fire a ping ray from a hit point along a given direction.
 * Returns the Euclidean distance to the first intersection, or null if no hit.
 *
 * Used for interior geometry probing: fire along inward normal to measure
 * stroke width, counter depth, or detect open counters (miss = escape).
 *
 * @param hitPoint - Origin point on the glyph outline
 * @param direction - Direction to fire (unit-length inward normal)
 * @param segments - All glyph outline segments
 * @returns Distance to nearest hit, or null if no hit (escaped)
 */
export function computePingRay(
  hitPoint: PathPoint,
  direction: PathPoint,
  segments: PathSegment[],
): number | null {
  // Offset origin slightly to avoid self-intersection at the source point
  const origin: PathPoint = {
    x: hitPoint.x + direction.x * PING_EPSILON,
    y: hitPoint.y + direction.y * PING_EPSILON,
  };

  let bestT = Infinity;

  for (const seg of segments) {
    const tValues = raySegmentIntersections(origin, direction, seg);
    for (const t of tValues) {
      if (t > PING_EPSILON && t < bestT) {
        bestT = t;
      }
    }
  }

  if (bestT === Infinity) return null;

  // Convert ray parameter t to Euclidean distance
  // Since direction should be unit-length, t is already the distance.
  // But be safe: multiply by |direction| in case caller doesn't normalise.
  const dirLen = Math.hypot(direction.x, direction.y);
  return bestT * dirLen;
}

/**
 * Ray-AABB intersection test (slab method).
 * Returns true if ray from (ox,oy) in direction (dx,dy) might hit the bbox
 * within [0, maxT]. Used as a cheap pre-filter before polynomial root-finding.
 */
function rayHitsBbox(
  ox: number, oy: number, dx: number, dy: number,
  bminX: number, bminY: number, bmaxX: number, bmaxY: number,
  maxT: number,
): boolean {
  let tmin = 0;
  let tmax = maxT;

  if (Math.abs(dx) > EPSILON) {
    const inv = 1 / dx;
    let t1 = (bminX - ox) * inv;
    let t2 = (bmaxX - ox) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  } else {
    if (ox < bminX || ox > bmaxX) return false;
  }

  if (Math.abs(dy) > EPSILON) {
    const inv = 1 / dy;
    let t1 = (bminY - oy) * inv;
    let t2 = (bmaxY - oy) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  } else {
    if (oy < bminY || oy > bmaxY) return false;
  }

  return true;
}

/**
 * Fast ping ray: bbox pre-filtered, early-exit, scalar arguments.
 * Direction must be unit-length (so t = Euclidean distance).
 *
 * Items 1+2+3+6: bbox pre-filter eliminates ~90% of segments,
 * early-exit skips segments beyond current best hit,
 * no Math.hypot (unit direction), scalar args avoid object allocation.
 */
function computePingRayFast(
  hx: number, hy: number,
  dx: number, dy: number,
  segments: PathSegment[],
  segMinX: Float64Array, segMinY: Float64Array,
  segMaxX: Float64Array, segMaxY: Float64Array,
): number | null {
  const ox = hx + dx * PING_EPSILON;
  const oy = hy + dy * PING_EPSILON;
  let bestT = Infinity;

  for (let si = 0; si < segments.length; si++) {
    // Item 1: bbox pre-filter -- skip segments the ray can't reach
    if (!rayHitsBbox(ox, oy, dx, dy, segMinX[si]!, segMinY[si]!, segMaxX[si]!, segMaxY[si]!, bestT)) {
      continue;
    }

    // Full intersection test (only for segments that pass bbox filter)
    const tValues = raySegmentIntersections({ x: ox, y: oy }, { x: dx, y: dy }, segments[si]!);
    for (const t of tValues) {
      // Item 2: early termination -- bestT shrinks, bbox filter gets tighter
      if (t > PING_EPSILON && t < bestT) bestT = t;
    }
  }

  if (bestT === Infinity) return null;
  // Item 3: direction is unit-length, so t IS the Euclidean distance
  return bestT;
}

/**
 * Evaluate a point on a segment at Bezier parameter s.
 */
function evalSegmentPoint(seg: PathSegment, s: number): PathPoint {
  switch (seg.type) {
    case 'line': {
      const mt = 1 - s;
      return { x: mt * seg.p0.x + s * seg.p1.x, y: mt * seg.p0.y + s * seg.p1.y };
    }
    case 'quadratic':
      return evalQuadratic(seg.p0, seg.p1, seg.p2, s);
    case 'cubic':
      return evalCubic(seg.p0, seg.p1, seg.p2, seg.p3, s);
  }
}

/**
 * Compute Bezier tangent B'(s) at parameter s on a segment.
 * Returns [tx, ty] as a tuple to avoid object allocation.
 */
function evalSegmentTangent(seg: PathSegment, s: number): [number, number] {
  switch (seg.type) {
    case 'line':
      return [seg.p1.x - seg.p0.x, seg.p1.y - seg.p0.y];
    case 'quadratic': {
      const ms = 1 - s;
      return [
        2 * ms * (seg.p1.x - seg.p0.x) + 2 * s * (seg.p2.x - seg.p1.x),
        2 * ms * (seg.p1.y - seg.p0.y) + 2 * s * (seg.p2.y - seg.p1.y),
      ];
    }
    case 'cubic': {
      const ms = 1 - s;
      const ms2 = ms * ms;
      const s2 = s * s;
      return [
        3 * ms2 * (seg.p1.x - seg.p0.x) + 6 * ms * s * (seg.p2.x - seg.p1.x) + 3 * s2 * (seg.p3.x - seg.p2.x),
        3 * ms2 * (seg.p1.y - seg.p0.y) + 6 * ms * s * (seg.p2.y - seg.p1.y) + 3 * s2 * (seg.p3.y - seg.p2.y),
      ];
    }
  }
}

/**
 * Solve for Bezier parameter s-roots where a ray crosses a segment.
 * Same polynomial projection as raySegmentIntersections but returns only s-roots,
 * not evaluated points or ray t-values. Used for lightweight first-pass hit collection.
 */
function solveForSRoots(
  nx: number, ny: number, ox: number, oy: number,
  segment: PathSegment,
): number[] {
  const project = (p: PathPoint): number => nx * (p.x - ox) + ny * (p.y - oy);

  switch (segment.type) {
    case 'line': {
      const d0 = project(segment.p0);
      const d1 = project(segment.p1);
      return solveQuadratic(0, d1 - d0, d0);
    }
    case 'quadratic': {
      const d0 = project(segment.p0);
      const d1 = project(segment.p1);
      const d2 = project(segment.p2);
      return solveQuadratic(d0 - 2 * d1 + d2, 2 * (d1 - d0), d0);
    }
    case 'cubic': {
      const d0 = project(segment.p0);
      const d1 = project(segment.p1);
      const d2 = project(segment.p2);
      const d3 = project(segment.p3);
      return solveCubic(-d0 + 3 * d1 - 3 * d2 + d3, 3 * d0 - 6 * d1 + 3 * d2, -3 * d0 + 3 * d1, d0);
    }
  }
}

/**
 * Insertion sort for parallel arrays (t, s, segIdx).
 * Faster than Array.sort for small arrays (typically 2-8 hits per ray).
 */
function insertionSortParallel(
  ts: Float64Array, ss: Float64Array, idxs: Uint16Array, n: number,
): void {
  for (let i = 1; i < n; i++) {
    const keyT = ts[i]!;
    const keyS = ss[i]!;
    const keyIdx = idxs[i]!;
    let j = i - 1;
    while (j >= 0 && ts[j]! > keyT) {
      ts[j + 1] = ts[j]!;
      ss[j + 1] = ss[j]!;
      idxs[j + 1] = idxs[j]!;
      j--;
    }
    ts[j + 1] = keyT;
    ss[j + 1] = keyS;
    idxs[j + 1] = keyIdx;
  }
}

/**
 * Cast parallel rays at a given angle across the glyph.
 * Rays are evenly spaced across the bounding box perpendicular to the direction.
 *
 * @param angle - Angle in radians (0 = horizontal rays going right)
 * @param numRays - Number of parallel rays to cast
 * @param segments - Glyph outline segments (in grid coordinates)
 * @param bbox - Bounding box of the segments
 */
export function castRaysAtAngle(
  angle: number,
  numRays: number,
  segments: PathSegment[],
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
): AngleSignature {
  const direction: PathPoint = { x: Math.cos(angle), y: Math.sin(angle) };
  // Normal perpendicular to direction (rays spread along this axis)
  const normal: PathPoint = { x: -direction.y, y: direction.x };

  // Project bbox corners onto normal axis to find spread range
  const corners = [
    { x: bbox.minX, y: bbox.minY },
    { x: bbox.maxX, y: bbox.minY },
    { x: bbox.minX, y: bbox.maxY },
    { x: bbox.maxX, y: bbox.maxY },
  ];

  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const c of corners) {
    const proj = normal.x * c.x + normal.y * c.y;
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
  }

  // Also project along direction to find the start position (behind the bbox)
  let minDirProj = Infinity;
  for (const c of corners) {
    const proj = direction.x * c.x + direction.y * c.y;
    if (proj < minDirProj) minDirProj = proj;
  }

  const rays: RayResult[] = [];
  const margin = (maxProj - minProj) * 0.05; // 5% margin outside bbox
  const rangeStart = minProj - margin;
  const rangeEnd = maxProj + margin;
  const step = numRays > 1 ? (rangeEnd - rangeStart) / (numRays - 1) : 0;

  for (let i = 0; i < numRays; i++) {
    const offset = numRays > 1 ? rangeStart + i * step : (rangeStart + rangeEnd) / 2;

    // Ray origin: positioned along normal at `offset`, behind bbox along direction
    const origin: PathPoint = {
      x: normal.x * offset + direction.x * (minDirProj - 1),
      y: normal.y * offset + direction.y * (minDirProj - 1),
    };

    let intersectionCount = 0;
    for (const seg of segments) {
      intersectionCount += raySegmentIntersections(origin, direction, seg).length;
    }

    rays.push({ offset, intersectionCount });
  }

  return { angle, rays };
}

/**
 * Compute an enriched signature: counts + sorted intersection positions per ray.
 * Returns flat arrays suitable for direct serialisation into the signature bank.
 *
 * Positions are normalised to [0, 1] relative to the ray's bbox span along its
 * direction, then quantised to uint8 (0-255). Only stored for rays with count > 0.
 * Capped at 10 positions per ray.
 *
 * Layout:
 * - counts[angleIdx * raysPerAngle + rayIdx] = intersection count
 * - positions[] = concatenated sorted uint8 positions for all rays with count > 0,
 *   in the same angle-major, ray-minor order as counts
 */
export function computeEnrichedSignature(
  segments: PathSegment[],
  numAngles = 36,
  raysPerAngle = 50,
  gridSize = 128,
): { counts: number[]; positions: number[]; angles: number[]; pingDistances: number[]; pingMax: number[] } {
  const bbox = computeBBoxFromSegments(segments);
  const counts: number[] = [];
  const positions: number[] = [];
  const angles: number[] = [];
  const pingDistances: number[] = [];
  const pingMax: number[] = [];

  const HALF_PI = Math.PI / 2;
  const numSegs = segments.length;

  // Item 1: pre-compute per-segment bounding boxes for ping ray acceleration
  const segMinX = new Float64Array(numSegs);
  const segMinY = new Float64Array(numSegs);
  const segMaxX = new Float64Array(numSegs);
  const segMaxY = new Float64Array(numSegs);
  for (let si = 0; si < numSegs; si++) {
    const seg = segments[si]!;
    let sxMin = seg.p0.x, syMin = seg.p0.y, sxMax = seg.p0.x, syMax = seg.p0.y;
    const updateBB = (p: PathPoint): void => {
      if (p.x < sxMin) sxMin = p.x; if (p.y < syMin) syMin = p.y;
      if (p.x > sxMax) sxMax = p.x; if (p.y > syMax) syMax = p.y;
    };
    if (seg.type === 'line') { updateBB(seg.p1); }
    else if (seg.type === 'quadratic') { updateBB(seg.p1); updateBB(seg.p2); }
    else { updateBB(seg.p1); updateBB(seg.p2); updateBB(seg.p3); }
    segMinX[si] = sxMin; segMinY[si] = syMin;
    segMaxX[si] = sxMax; segMaxY[si] = syMax;
  }

  // Item 4: pre-allocate arrays for raw hit collection (reused per ray)
  // Max possible hits: numSegs * 3 (cubic has at most 3 roots)
  const maxRawHits = numSegs * 3;
  const rawTs = new Float64Array(maxRawHits);
  const rawSs = new Float64Array(maxRawHits);
  const rawSegIdxs = new Uint16Array(maxRawHits);

  // Hoist bbox corners (angle-independent)
  const cx0 = bbox.minX, cy0 = bbox.minY;
  const cx1 = bbox.maxX, cy1 = bbox.minY;
  const cx2 = bbox.minX, cy2 = bbox.maxY;
  const cx3 = bbox.maxX, cy3 = bbox.maxY;

  for (let i = 0; i < numAngles; i++) {
    const angle = (i * Math.PI) / numAngles;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const nx = -dy;
    const ny = dx;

    // Project bbox corners onto normal and direction axes
    let minProj = Infinity, maxProj = -Infinity;
    let minDirProj = Infinity, maxDirProj = -Infinity;
    const p0n = nx * cx0 + ny * cy0; const p0d = dx * cx0 + dy * cy0;
    const p1n = nx * cx1 + ny * cy1; const p1d = dx * cx1 + dy * cy1;
    const p2n = nx * cx2 + ny * cy2; const p2d = dx * cx2 + dy * cy2;
    const p3n = nx * cx3 + ny * cy3; const p3d = dx * cx3 + dy * cy3;
    if (p0n < minProj) minProj = p0n; if (p0n > maxProj) maxProj = p0n;
    if (p1n < minProj) minProj = p1n; if (p1n > maxProj) maxProj = p1n;
    if (p2n < minProj) minProj = p2n; if (p2n > maxProj) maxProj = p2n;
    if (p3n < minProj) minProj = p3n; if (p3n > maxProj) maxProj = p3n;
    if (p0d < minDirProj) minDirProj = p0d; if (p0d > maxDirProj) maxDirProj = p0d;
    if (p1d < minDirProj) minDirProj = p1d; if (p1d > maxDirProj) maxDirProj = p1d;
    if (p2d < minDirProj) minDirProj = p2d; if (p2d > maxDirProj) maxDirProj = p2d;
    if (p3d < minDirProj) minDirProj = p3d; if (p3d > maxDirProj) maxDirProj = p3d;

    const margin = (maxProj - minProj) * 0.05;
    const rangeStart = minProj - margin;
    const rangeEnd = maxProj + margin;
    const step = raysPerAngle > 1 ? (rangeEnd - rangeStart) / (raysPerAngle - 1) : 0;
    const dirSpan = maxDirProj - minDirProj;

    for (let r = 0; r < raysPerAngle; r++) {
      const offset = raysPerAngle > 1 ? rangeStart + r * step : (rangeStart + rangeEnd) / 2;
      const originX = nx * offset + dx * (minDirProj - 1);
      const originY = ny * offset + dy * (minDirProj - 1);

      // === Item 4: First pass -- collect raw (t, s, segIdx) tuples ===
      // Uses lightweight root-finding, skips tangent/angle computation
      let rawCount = 0;
      for (let si = 0; si < numSegs; si++) {
        const sRoots = solveForSRoots(nx, ny, originX, originY, segments[si]!);
        for (const s of sRoots) {
          const pt = evalSegmentPoint(segments[si]!, s);
          // Item 3: direction is unit-length, dirLen2 = 1.0
          const t = (pt.x - originX) * dx + (pt.y - originY) * dy;
          if (t >= -EPSILON) {
            rawTs[rawCount] = Math.max(0, t);
            rawSs[rawCount] = s;
            rawSegIdxs[rawCount] = si;
            rawCount++;
          }
        }
      }

      // Sort by t and cap at 10
      insertionSortParallel(rawTs, rawSs, rawSegIdxs, rawCount);
      const cappedCount = Math.min(rawCount, 10);
      counts.push(Math.min(255, cappedCount));

      // === Second pass: compute enriched data for retained hits only ===
      for (let hi = 0; hi < cappedCount; hi++) {
        const hitT = rawTs[hi]!;
        const hitS = rawSs[hi]!;
        const seg = segments[rawSegIdxs[hi]!]!;

        // Position (unified: dirSpan > 0 uses normalised value, else 0)
        const normPos = dirSpan > 0 ? (hitT - 1) / dirSpan : 0;
        positions.push(Math.round(Math.max(0, Math.min(1, normPos)) * 255));

        // Item 4: tangent + crossing angle computed only for retained hits
        const [tx, ty] = evalSegmentTangent(seg, hitS);
        const tangentLen = Math.hypot(tx, ty);
        let crossingAngle: number;
        if (tangentLen < EPSILON) {
          crossingAngle = HALF_PI;
        } else {
          // Item 3: dirLen = 1.0 (direction is unit-length)
          const cosAngle = Math.abs(dx * tx + dy * ty) / tangentLen;
          crossingAngle = Math.acos(Math.min(1, cosAngle));
        }
        angles.push(Math.round(Math.max(0, Math.min(1, crossingAngle / HALF_PI)) * 255));

        // Ping rays with bbox pre-filter + early termination
        if (tangentLen < EPSILON) {
          pingDistances.push(0);
          pingMax.push(0);
        } else {
          const pnx = -ty / tangentLen;
          const pny =  tx / tangentLen;

          // Re-evaluate hit point for ping origin (cheap)
          const hp = evalSegmentPoint(seg, hitS);

          // Items 1+2+3+6: bbox-filtered, early-exit, scalar ping rays
          const d1 = computePingRayFast(hp.x, hp.y, pnx, pny, segments, segMinX, segMinY, segMaxX, segMaxY);
          const d2 = computePingRayFast(hp.x, hp.y, -pnx, -pny, segments, segMinX, segMinY, segMaxX, segMaxY);

          const v1 = (d1 != null && d1 > 0 && isFinite(d1)) ? d1 : null;
          const v2 = (d2 != null && d2 > 0 && isFinite(d2)) ? d2 : null;

          if (v1 != null && v2 != null) {
            const minD = Math.min(v1, v2);
            const maxD = Math.max(v1, v2);
            pingDistances.push(Math.round(Math.max(0, Math.min(1, minD / gridSize)) * 254));
            pingMax.push(Math.round(Math.max(0, Math.min(1, maxD / gridSize)) * 254));
          } else if (v1 != null) {
            pingDistances.push(Math.round(Math.max(0, Math.min(1, v1 / gridSize)) * 254));
            pingMax.push(255);
          } else if (v2 != null) {
            pingDistances.push(Math.round(Math.max(0, Math.min(1, v2 / gridSize)) * 254));
            pingMax.push(255);
          } else {
            pingDistances.push(255);
            pingMax.push(255);
          }
        }
      }
    }
  }

  return { counts, positions, angles, pingDistances, pingMax };
}

/**
 * Compute a full topological signature for a glyph outline.
 * Casts rays at multiple angles and builds an intersection count histogram.
 *
 * @param segments - Glyph outline segments (in grid coordinates)
 * @param numAngles - Number of angles to sample (default 36 = every 5 degrees)
 * @param raysPerAngle - Number of parallel rays per angle (default 50)
 */
export function computeSignature(
  segments: PathSegment[],
  numAngles = 36,
  raysPerAngle = 50,
): TopologicalSignature {
  const bbox = computeBBoxFromSegments(segments);
  const angles: AngleSignature[] = [];
  const histogram = new Map<number, number>();

  for (let i = 0; i < numAngles; i++) {
    const angle = (i * Math.PI) / numAngles; // 0 to PI (half-circle, symmetric)
    const angleSig = castRaysAtAngle(angle, raysPerAngle, segments, bbox);
    angles.push(angleSig);

    // Build histogram of intersection counts
    for (const ray of angleSig.rays) {
      const count = ray.intersectionCount;
      histogram.set(count, (histogram.get(count) ?? 0) + 1);
    }
  }

  return { angles, intersectionHistogram: histogram };
}

/**
 * Compare two topological signatures.
 * Returns a distance score where 0 = identical topology.
 *
 * Combines:
 * 1. Intersection count histogram difference (normalised chi-squared)
 * 2. Per-angle positional alignment (how similarly the intersection counts
 *    vary across the ray sweep at each angle)
 */
export function compareSignatures(a: TopologicalSignature, b: TopologicalSignature): number {
  // 1. Histogram difference (chi-squared distance)
  const allCounts = new Set([...a.intersectionHistogram.keys(), ...b.intersectionHistogram.keys()]);
  let histogramDistance = 0;
  let totalA = 0;
  let totalB = 0;

  for (const count of allCounts) {
    const va = a.intersectionHistogram.get(count) ?? 0;
    const vb = b.intersectionHistogram.get(count) ?? 0;
    totalA += va;
    totalB += vb;
  }

  if (totalA > 0 && totalB > 0) {
    for (const count of allCounts) {
      const va = (a.intersectionHistogram.get(count) ?? 0) / totalA;
      const vb = (b.intersectionHistogram.get(count) ?? 0) / totalB;
      const sum = va + vb;
      if (sum > 0) {
        histogramDistance += (va - vb) * (va - vb) / sum;
      }
    }
  }

  // 2. Positional alignment: compare intersection count profiles at each angle
  let positionalDistance = 0;
  const numAngles = Math.min(a.angles.length, b.angles.length);

  if (numAngles > 0) {
    for (let i = 0; i < numAngles; i++) {
      const raysA = a.angles[i]!.rays;
      const raysB = b.angles[i]!.rays;
      const numRays = Math.min(raysA.length, raysB.length);

      if (numRays > 0) {
        let angleDiff = 0;
        for (let j = 0; j < numRays; j++) {
          const diff = raysA[j]!.intersectionCount - raysB[j]!.intersectionCount;
          angleDiff += diff * diff;
        }
        positionalDistance += angleDiff / numRays;
      }
    }
    positionalDistance /= numAngles;
  }

  // Weighted combination: histogram captures global topology,
  // positional captures spatial structure
  return 0.4 * histogramDistance + 0.6 * positionalDistance;
}

/**
 * Compute bounding box from path segments (duplicated from glyph-path.ts
 * to keep raycasting self-contained for performance).
 */
function computeBBoxFromSegments(segments: PathSegment[]): { minX: number; minY: number; maxX: number; maxY: number } {
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
