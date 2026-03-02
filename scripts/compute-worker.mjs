/**
 * compute-worker.mjs
 *
 * Unified worker thread for build-signature-bank.ts, discover-multichar-sdf.ts,
 * and score-multichar-sdf.ts.
 *
 * Self-contained: inlines both raycasting math (from src/raycasting.ts) and
 * SDF math (from src/sdf.ts) to avoid tsx/TypeScript loader issues with
 * worker_threads. These are the CPU-hot paths that benefit from multi-core
 * parallelism.
 *
 * Handles two message types:
 * - { type: 'sdf', id, segments, width, height, baselineRow }
 *     -> computes SDF grid, returns Float64Array via zero-copy transfer
 * - { id, gridSegments, numAngles, raysPerAngle }  (default, backward compat)
 *     -> computes ray signature, returns counts array
 * - { type: 'exit' }
 *     -> graceful shutdown
 *
 * Changes to the raycasting algorithm must be reflected here (mirrors src/raycasting.ts).
 * Changes to the SDF algorithm must be reflected here (mirrors src/sdf.ts).
 */

import { parentPort } from 'node:worker_threads';

const EPSILON = 1e-10;
const GRID_CELLS = 8;
const BLOCK_SIZE = 4;
const SAFE_MARGIN = 6.0;

// ========================================================================
// Raycasting functions (from src/raycasting.ts)
// ========================================================================

function solveQuadratic(a, b, c) {
  const roots = [];
  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) < EPSILON) return roots;
    const t = -c / b;
    if (t >= -EPSILON && t <= 1 + EPSILON) roots.push(Math.max(0, Math.min(1, t)));
    return roots;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -EPSILON) return roots;
  const sqrtD = Math.sqrt(Math.max(0, discriminant));
  const t1 = (-b - sqrtD) / (2 * a);
  const t2 = (-b + sqrtD) / (2 * a);
  if (t1 >= -EPSILON && t1 <= 1 + EPSILON) roots.push(Math.max(0, Math.min(1, t1)));
  if (t2 >= -EPSILON && t2 <= 1 + EPSILON && Math.abs(t2 - t1) > EPSILON) roots.push(Math.max(0, Math.min(1, t2)));
  return roots;
}

function addRoot(roots, t) {
  if (t >= -EPSILON && t <= 1 + EPSILON) roots.push(Math.max(0, Math.min(1, t)));
}

function solveCubic(a, b, c, d) {
  if (Math.abs(a) < EPSILON) return solveQuadratic(b, c, d);
  const p = b / a, q = c / a, r = d / a;
  const p2 = (3 * q - p * p) / 3;
  const q2 = (2 * p * p * p - 9 * p * q + 27 * r) / 27;
  const discriminant = q2 * q2 / 4 + p2 * p2 * p2 / 27;
  const offset = -p / 3;
  const roots = [];
  if (Math.abs(discriminant) < EPSILON) {
    if (Math.abs(q2) < EPSILON) { addRoot(roots, offset); }
    else { const u = Math.cbrt(-q2 / 2); addRoot(roots, 2 * u + offset); addRoot(roots, -u + offset); }
  } else if (discriminant > 0) {
    const sqrtD = Math.sqrt(discriminant);
    addRoot(roots, Math.cbrt(-q2 / 2 + sqrtD) + Math.cbrt(-q2 / 2 - sqrtD) + offset);
  } else {
    const m = 2 * Math.sqrt(-p2 / 3);
    const theta = Math.acos(3 * q2 / (p2 * m)) / 3;
    addRoot(roots, m * Math.cos(theta) + offset);
    addRoot(roots, m * Math.cos(theta - 2 * Math.PI / 3) + offset);
    addRoot(roots, m * Math.cos(theta - 4 * Math.PI / 3) + offset);
  }
  return roots;
}

function evalQuadratic(p0, p1, p2, t) {
  const mt = 1 - t;
  return { x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x, y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y };
}

function evalCubic(p0, p1, p2, p3, t) {
  const mt = 1 - t, mt2 = mt * mt, t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
  };
}

function raySegmentIntersections(origin, direction, segment) {
  const nx = -direction.y, ny = direction.x;
  const project = (p) => nx * (p.x - origin.x) + ny * (p.y - origin.y);
  let sRoots;
  switch (segment.type) {
    case 'line': { const d0 = project(segment.p0), d1 = project(segment.p1); sRoots = solveQuadratic(0, d1 - d0, d0); break; }
    case 'quadratic': { const d0 = project(segment.p0), d1 = project(segment.p1), d2 = project(segment.p2); sRoots = solveQuadratic(d0 - 2 * d1 + d2, 2 * (d1 - d0), d0); break; }
    case 'cubic': { const d0 = project(segment.p0), d1 = project(segment.p1), d2 = project(segment.p2), d3 = project(segment.p3); sRoots = solveCubic(-d0 + 3 * d1 - 3 * d2 + d3, 3 * d0 - 6 * d1 + 3 * d2, -3 * d0 + 3 * d1, d0); break; }
  }
  const tValues = [];
  const dirLen2 = direction.x * direction.x + direction.y * direction.y;
  for (const s of sRoots) {
    let point;
    switch (segment.type) {
      case 'line': { const mt = 1 - s; point = { x: mt * segment.p0.x + s * segment.p1.x, y: mt * segment.p0.y + s * segment.p1.y }; break; }
      case 'quadratic': point = evalQuadratic(segment.p0, segment.p1, segment.p2, s); break;
      case 'cubic': point = evalCubic(segment.p0, segment.p1, segment.p2, segment.p3, s); break;
    }
    const dx = point.x - origin.x, dy = point.y - origin.y;
    const t = (dx * direction.x + dy * direction.y) / dirLen2;
    if (t >= -EPSILON) tValues.push(Math.max(0, t));
  }
  return tValues;
}

/**
 * Enriched ray-segment intersection: returns {t, crossingAngle} per hit.
 * Computes Bezier tangent B'(s) and crossing angle at each intersection.
 */
function raySegmentIntersectionsEnriched(origin, direction, segment) {
  const nx = -direction.y, ny = direction.x;
  const project = (p) => nx * (p.x - origin.x) + ny * (p.y - origin.y);
  let sRoots;
  switch (segment.type) {
    case 'line': { const d0 = project(segment.p0), d1 = project(segment.p1); sRoots = solveQuadratic(0, d1 - d0, d0); break; }
    case 'quadratic': { const d0 = project(segment.p0), d1 = project(segment.p1), d2 = project(segment.p2); sRoots = solveQuadratic(d0 - 2 * d1 + d2, 2 * (d1 - d0), d0); break; }
    case 'cubic': { const d0 = project(segment.p0), d1 = project(segment.p1), d2 = project(segment.p2), d3 = project(segment.p3); sRoots = solveCubic(-d0 + 3 * d1 - 3 * d2 + d3, 3 * d0 - 6 * d1 + 3 * d2, -3 * d0 + 3 * d1, d0); break; }
  }
  const dirLen = Math.hypot(direction.x, direction.y);
  const dirLen2 = direction.x * direction.x + direction.y * direction.y;
  const results = [];
  for (const s of sRoots) {
    let point;
    switch (segment.type) {
      case 'line': { const mt = 1 - s; point = { x: mt * segment.p0.x + s * segment.p1.x, y: mt * segment.p0.y + s * segment.p1.y }; break; }
      case 'quadratic': point = evalQuadratic(segment.p0, segment.p1, segment.p2, s); break;
      case 'cubic': point = evalCubic(segment.p0, segment.p1, segment.p2, segment.p3, s); break;
    }
    const dx = point.x - origin.x, dy = point.y - origin.y;
    const t = (dx * direction.x + dy * direction.y) / dirLen2;
    if (t >= -EPSILON) {
      // Compute tangent B'(s)
      let tx, ty;
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
          const ms = 1 - s, ms2 = ms * ms, s2 = s * s;
          tx = 3 * ms2 * (segment.p1.x - segment.p0.x) + 6 * ms * s * (segment.p2.x - segment.p1.x) + 3 * s2 * (segment.p3.x - segment.p2.x);
          ty = 3 * ms2 * (segment.p1.y - segment.p0.y) + 6 * ms * s * (segment.p2.y - segment.p1.y) + 3 * s2 * (segment.p3.y - segment.p2.y);
          break;
        }
      }
      const tangentLen = Math.hypot(tx, ty);
      let crossingAngle;
      if (tangentLen < EPSILON || dirLen < EPSILON) {
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
 * Returns distance to nearest hit, or null if no hit (escaped).
 */
function computePingRay(hitPoint, direction, segments) {
  const origin = {
    x: hitPoint.x + direction.x * PING_EPSILON,
    y: hitPoint.y + direction.y * PING_EPSILON,
  };
  let bestT = Infinity;
  for (const seg of segments) {
    const tValues = raySegmentIntersections(origin, direction, seg);
    for (const t of tValues) {
      if (t > PING_EPSILON && t < bestT) bestT = t;
    }
  }
  if (bestT === Infinity) return null;
  const dirLen = Math.hypot(direction.x, direction.y);
  return bestT * dirLen;
}

/** Ray-AABB intersection test (slab method). */
function rayHitsBbox(ox, oy, dx, dy, bminX, bminY, bmaxX, bmaxY, maxT) {
  let tmin = 0, tmax = maxT;
  if (Math.abs(dx) > EPSILON) {
    const inv = 1 / dx;
    let t1 = (bminX - ox) * inv, t2 = (bmaxX - ox) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  } else {
    if (ox < bminX || ox > bmaxX) return false;
  }
  if (Math.abs(dy) > EPSILON) {
    const inv = 1 / dy;
    let t1 = (bminY - oy) * inv, t2 = (bmaxY - oy) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  } else {
    if (oy < bminY || oy > bmaxY) return false;
  }
  return true;
}

/** Bbox-filtered, early-exit, scalar ping ray. Direction must be unit-length. */
function computePingRayFast(hx, hy, dx, dy, segments, segMinX, segMinY, segMaxX, segMaxY) {
  const ox = hx + dx * PING_EPSILON, oy = hy + dy * PING_EPSILON;
  let bestT = Infinity;
  for (let si = 0; si < segments.length; si++) {
    if (!rayHitsBbox(ox, oy, dx, dy, segMinX[si], segMinY[si], segMaxX[si], segMaxY[si], bestT)) continue;
    const tValues = raySegmentIntersections({ x: ox, y: oy }, { x: dx, y: dy }, segments[si]);
    for (const t of tValues) {
      if (t > PING_EPSILON && t < bestT) bestT = t;
    }
  }
  return bestT === Infinity ? null : bestT;
}

/** Evaluate point on segment at Bezier parameter s. */
function evalSegmentPoint(seg, s) {
  switch (seg.type) {
    case 'line': { const mt = 1 - s; return { x: mt * seg.p0.x + s * seg.p1.x, y: mt * seg.p0.y + s * seg.p1.y }; }
    case 'quadratic': return evalQuadratic(seg.p0, seg.p1, seg.p2, s);
    case 'cubic': return evalCubic(seg.p0, seg.p1, seg.p2, seg.p3, s);
  }
}

/** Compute Bezier tangent at parameter s. Returns [tx, ty]. */
function evalSegmentTangent(seg, s) {
  switch (seg.type) {
    case 'line': return [seg.p1.x - seg.p0.x, seg.p1.y - seg.p0.y];
    case 'quadratic': { const ms = 1 - s; return [2*ms*(seg.p1.x-seg.p0.x)+2*s*(seg.p2.x-seg.p1.x), 2*ms*(seg.p1.y-seg.p0.y)+2*s*(seg.p2.y-seg.p1.y)]; }
    case 'cubic': { const ms = 1-s, ms2 = ms*ms, s2 = s*s; return [3*ms2*(seg.p1.x-seg.p0.x)+6*ms*s*(seg.p2.x-seg.p1.x)+3*s2*(seg.p3.x-seg.p2.x), 3*ms2*(seg.p1.y-seg.p0.y)+6*ms*s*(seg.p2.y-seg.p1.y)+3*s2*(seg.p3.y-seg.p2.y)]; }
  }
}

/** Solve for Bezier s-roots where ray crosses segment. */
function solveForSRoots(nx, ny, ox, oy, segment) {
  const project = (p) => nx * (p.x - ox) + ny * (p.y - oy);
  switch (segment.type) {
    case 'line': { const d0 = project(segment.p0), d1 = project(segment.p1); return solveQuadratic(0, d1 - d0, d0); }
    case 'quadratic': { const d0 = project(segment.p0), d1 = project(segment.p1), d2 = project(segment.p2); return solveQuadratic(d0-2*d1+d2, 2*(d1-d0), d0); }
    case 'cubic': { const d0 = project(segment.p0), d1 = project(segment.p1), d2 = project(segment.p2), d3 = project(segment.p3); return solveCubic(-d0+3*d1-3*d2+d3, 3*d0-6*d1+3*d2, -3*d0+3*d1, d0); }
  }
}

/** Insertion sort for parallel arrays (t, s, segIdx). */
function insertionSortParallel(ts, ss, idxs, n) {
  for (let i = 1; i < n; i++) {
    const keyT = ts[i], keyS = ss[i], keyIdx = idxs[i];
    let j = i - 1;
    while (j >= 0 && ts[j] > keyT) { ts[j+1] = ts[j]; ss[j+1] = ss[j]; idxs[j+1] = idxs[j]; j--; }
    ts[j+1] = keyT; ss[j+1] = keyS; idxs[j+1] = keyIdx;
  }
}

function computeBBox(segments) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const update = (p) => { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; };
  for (const seg of segments) {
    update(seg.p0);
    if (seg.type === 'line') { update(seg.p1); }
    else if (seg.type === 'quadratic') { update(seg.p1); update(seg.p2); }
    else { update(seg.p1); update(seg.p2); update(seg.p3); }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * Compute enriched signature: counts + sorted intersection positions per ray.
 * Positions normalised to [0,1] relative to bbox direction span, quantised uint8.
 * Only stored for rays with count > 0. Capped at 10 positions per ray.
 */
function computeEnrichedSignature(segments, numAngles, raysPerAngle, gridSize) {
  if (gridSize === undefined) gridSize = 128;
  const bbox = computeBBox(segments);
  const counts = [];
  const positions = [];
  const angles = [];
  const pingDistances = [];
  const pingMax = [];
  const HALF_PI = Math.PI / 2;
  const numSegs = segments.length;

  // Pre-compute per-segment bounding boxes for ping ray acceleration
  const segMinX = new Float64Array(numSegs);
  const segMinY = new Float64Array(numSegs);
  const segMaxX = new Float64Array(numSegs);
  const segMaxY = new Float64Array(numSegs);
  for (let si = 0; si < numSegs; si++) {
    const seg = segments[si];
    let sxMin = seg.p0.x, syMin = seg.p0.y, sxMax = seg.p0.x, syMax = seg.p0.y;
    const u = (p) => { if (p.x < sxMin) sxMin = p.x; if (p.y < syMin) syMin = p.y; if (p.x > sxMax) sxMax = p.x; if (p.y > syMax) syMax = p.y; };
    if (seg.type === 'line') { u(seg.p1); }
    else if (seg.type === 'quadratic') { u(seg.p1); u(seg.p2); }
    else { u(seg.p1); u(seg.p2); u(seg.p3); }
    segMinX[si] = sxMin; segMinY[si] = syMin; segMaxX[si] = sxMax; segMaxY[si] = syMax;
  }

  // Pre-allocate arrays for raw hit collection (reused per ray)
  const maxRawHits = numSegs * 3;
  const rawTs = new Float64Array(maxRawHits);
  const rawSs = new Float64Array(maxRawHits);
  const rawSegIdxs = new Uint16Array(maxRawHits);

  // Hoist bbox corners
  const cx0 = bbox.minX, cy0 = bbox.minY;
  const cx1 = bbox.maxX, cy1 = bbox.minY;
  const cx2 = bbox.minX, cy2 = bbox.maxY;
  const cx3 = bbox.maxX, cy3 = bbox.maxY;

  for (let i = 0; i < numAngles; i++) {
    const angle = (i * Math.PI) / numAngles;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const nx = -dy, ny = dx;

    let minProj = Infinity, maxProj = -Infinity, minDirProj = Infinity, maxDirProj = -Infinity;
    const p0n = nx*cx0+ny*cy0, p0d = dx*cx0+dy*cy0;
    const p1n = nx*cx1+ny*cy1, p1d = dx*cx1+dy*cy1;
    const p2n = nx*cx2+ny*cy2, p2d = dx*cx2+dy*cy2;
    const p3n = nx*cx3+ny*cy3, p3d = dx*cx3+dy*cy3;
    if (p0n < minProj) minProj = p0n; if (p0n > maxProj) maxProj = p0n;
    if (p1n < minProj) minProj = p1n; if (p1n > maxProj) maxProj = p1n;
    if (p2n < minProj) minProj = p2n; if (p2n > maxProj) maxProj = p2n;
    if (p3n < minProj) minProj = p3n; if (p3n > maxProj) maxProj = p3n;
    if (p0d < minDirProj) minDirProj = p0d; if (p0d > maxDirProj) maxDirProj = p0d;
    if (p1d < minDirProj) minDirProj = p1d; if (p1d > maxDirProj) maxDirProj = p1d;
    if (p2d < minDirProj) minDirProj = p2d; if (p2d > maxDirProj) maxDirProj = p2d;
    if (p3d < minDirProj) minDirProj = p3d; if (p3d > maxDirProj) maxDirProj = p3d;

    const margin = (maxProj - minProj) * 0.05;
    const rangeStart = minProj - margin, rangeEnd = maxProj + margin;
    const step = raysPerAngle > 1 ? (rangeEnd - rangeStart) / (raysPerAngle - 1) : 0;
    const dirSpan = maxDirProj - minDirProj;

    for (let j = 0; j < raysPerAngle; j++) {
      const offset = raysPerAngle > 1 ? rangeStart + j * step : (rangeStart + rangeEnd) / 2;
      const originX = nx * offset + dx * (minDirProj - 1);
      const originY = ny * offset + dy * (minDirProj - 1);

      // First pass: collect raw (t, s, segIdx) tuples
      let rawCount = 0;
      for (let si = 0; si < numSegs; si++) {
        const sRoots = solveForSRoots(nx, ny, originX, originY, segments[si]);
        for (const s of sRoots) {
          const pt = evalSegmentPoint(segments[si], s);
          const t = (pt.x - originX) * dx + (pt.y - originY) * dy;
          if (t >= -EPSILON) {
            rawTs[rawCount] = Math.max(0, t);
            rawSs[rawCount] = s;
            rawSegIdxs[rawCount] = si;
            rawCount++;
          }
        }
      }

      insertionSortParallel(rawTs, rawSs, rawSegIdxs, rawCount);
      const cappedCount = Math.min(rawCount, 10);
      counts.push(Math.min(255, cappedCount));

      // Second pass: compute enriched data for retained hits only
      for (let hi = 0; hi < cappedCount; hi++) {
        const hitT = rawTs[hi], hitS = rawSs[hi], seg = segments[rawSegIdxs[hi]];

        const normPos = dirSpan > 0 ? (hitT - 1) / dirSpan : 0;
        positions.push(Math.round(Math.max(0, Math.min(1, normPos)) * 255));

        const [tx, ty] = evalSegmentTangent(seg, hitS);
        const tangentLen = Math.hypot(tx, ty);
        let crossingAngle;
        if (tangentLen < EPSILON) {
          crossingAngle = HALF_PI;
        } else {
          const cosAngle = Math.abs(dx * tx + dy * ty) / tangentLen;
          crossingAngle = Math.acos(Math.min(1, cosAngle));
        }
        angles.push(Math.round(Math.max(0, Math.min(1, crossingAngle / HALF_PI)) * 255));

        if (tangentLen < EPSILON) {
          pingDistances.push(0); pingMax.push(0);
        } else {
          const pnx = -ty / tangentLen, pny = tx / tangentLen;
          const hp = evalSegmentPoint(seg, hitS);
          const d1 = computePingRayFast(hp.x, hp.y, pnx, pny, segments, segMinX, segMinY, segMaxX, segMaxY);
          const d2 = computePingRayFast(hp.x, hp.y, -pnx, -pny, segments, segMinX, segMinY, segMaxX, segMaxY);
          const v1 = (d1 != null && d1 > 0 && isFinite(d1)) ? d1 : null;
          const v2 = (d2 != null && d2 > 0 && isFinite(d2)) ? d2 : null;
          if (v1 != null && v2 != null) {
            const minD = Math.min(v1, v2), maxD = Math.max(v1, v2);
            pingDistances.push(Math.round(Math.max(0, Math.min(1, minD / gridSize)) * 254));
            pingMax.push(Math.round(Math.max(0, Math.min(1, maxD / gridSize)) * 254));
          } else if (v1 != null) {
            pingDistances.push(Math.round(Math.max(0, Math.min(1, v1 / gridSize)) * 254));
            pingMax.push(255);
          } else if (v2 != null) {
            pingDistances.push(Math.round(Math.max(0, Math.min(1, v2 / gridSize)) * 254));
            pingMax.push(255);
          } else {
            pingDistances.push(255); pingMax.push(255);
          }
        }
      }
    }
  }

  return { counts, positions, angles, pingDistances, pingMax };
}

// ========================================================================
// SDF functions (from src/sdf.ts)
// ========================================================================

function pointToSegmentDistance(point, segment) {
  switch (segment.type) {
    case 'line':
      return pointToLineDistance(point, segment.p0, segment.p1);
    case 'quadratic':
      return pointToQuadraticDistance(point, segment.p0, segment.p1, segment.p2);
    case 'cubic':
      return pointToCubicDistance(point, segment.p0, segment.p1, segment.p2, segment.p3);
  }
}

function pointToLineDistance(point, p0, p1) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len2 = dx * dx + dy * dy;

  if (len2 < EPSILON) {
    return Math.hypot(point.x - p0.x, point.y - p0.y);
  }

  let t = ((point.x - p0.x) * dx + (point.y - p0.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));

  const projX = p0.x + t * dx;
  const projY = p0.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

function pointToQuadraticDistance(point, p0, p1, p2) {
  const ax = p0.x - 2 * p1.x + p2.x;
  const ay = p0.y - 2 * p1.y + p2.y;
  const bx = 2 * (p1.x - p0.x);
  const by = 2 * (p1.y - p0.y);
  const cx = p0.x - point.x;
  const cy = p0.y - point.y;

  const a3 = 2 * (ax * ax + ay * ay);
  const a2 = 3 * (ax * bx + ay * by);
  const a1 = bx * bx + by * by + 2 * (ax * cx + ay * cy);
  const a0 = bx * cx + by * cy;

  const roots = solveCubicRoots(a3, a2, a1, a0);

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

function pointToCubicDistance(point, p0, p1, p2, p3) {
  let best = Math.min(
    Math.hypot(point.x - p0.x, point.y - p0.y),
    Math.hypot(point.x - p3.x, point.y - p3.y),
  );

  best = subdivideCubicSdf(point, p0, p1, p2, p3, 0, 1, best, 0);
  return best;
}

function subdivideCubicSdf(point, p0, p1, p2, p3, tStart, tEnd, currentBest, depth) {
  const minX = Math.min(p0.x, p1.x, p2.x, p3.x);
  const minY = Math.min(p0.y, p1.y, p2.y, p3.y);
  const maxX = Math.max(p0.x, p1.x, p2.x, p3.x);
  const maxY = Math.max(p0.y, p1.y, p2.y, p3.y);

  const bboxDist = distToBBox(point, minX, minY, maxX, maxY);
  if (bboxDist >= currentBest) return currentBest;

  const dt = tEnd - tStart;
  if (dt < 0.001 || depth > 20) {
    const pt = evalCubicPoint(p0, p1, p2, p3, 0.5);
    const dist = Math.hypot(pt.x - point.x, pt.y - point.y);
    return Math.min(currentBest, dist);
  }

  const [left, right] = splitCubicSdf(p0, p1, p2, p3);
  const tMid = (tStart + tEnd) / 2;

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
    best = subdivideCubicSdf(point, left[0], left[1], left[2], left[3], tStart, tMid, best, depth + 1);
    best = subdivideCubicSdf(point, right[0], right[1], right[2], right[3], tMid, tEnd, best, depth + 1);
  } else {
    best = subdivideCubicSdf(point, right[0], right[1], right[2], right[3], tMid, tEnd, best, depth + 1);
    best = subdivideCubicSdf(point, left[0], left[1], left[2], left[3], tStart, tMid, best, depth + 1);
  }

  return best;
}

function splitCubicSdf(p0, p1, p2, p3) {
  const m01 = midPt(p0, p1);
  const m12 = midPt(p1, p2);
  const m23 = midPt(p2, p3);
  const m012 = midPt(m01, m12);
  const m123 = midPt(m12, m23);
  const m0123 = midPt(m012, m123);

  return [
    [p0, m01, m012, m0123],
    [m0123, m123, m23, p3],
  ];
}

function midPt(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function evalCubicPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
  };
}

function distToBBox(p, minX, minY, maxX, maxY) {
  const dx = Math.max(minX - p.x, 0, p.x - maxX);
  const dy = Math.max(minY - p.y, 0, p.y - maxY);
  return Math.hypot(dx, dy);
}

function solveCubicRoots(a, b, c, d) {
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

  const roots = [];

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

function solveQuadraticRoots(a, b, c) {
  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) < EPSILON) return [];
    return [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const sqrtD = Math.sqrt(disc);
  return [(-b - sqrtD) / (2 * a), (-b + sqrtD) / (2 * a)];
}

function segmentWinding(point, seg) {
  switch (seg.type) {
    case 'line':
      return lineWinding(point, seg.p0, seg.p1);
    case 'quadratic':
      return curveWindingSubdivide(point, seg, 0, 1, 8);
    case 'cubic':
      return curveWindingSubdivide(point, seg, 0, 1, 8);
  }
}

function lineWinding(point, p0, p1) {
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

function curveWindingSubdivide(point, seg, tStart, tEnd, steps) {
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

function evalSegmentAt(seg, t) {
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

function buildSegmentCache(segments) {
  return segments.map(seg => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const update = (p) => {
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

function windingNumberFiltered(px, py, cache) {
  let winding = 0;
  const point = { x: px, y: py };

  for (let i = 0; i < cache.length; i++) {
    const c = cache[i];
    if (c.minY > py || c.maxY <= py) continue;
    winding += segmentWinding(point, c.seg);
  }

  return winding;
}

function buildSpatialGrid(cache, width, height) {
  const cellsX = GRID_CELLS;
  const cellsY = GRID_CELLS;
  const cellW = width / cellsX;
  const cellH = height / cellsY;

  const buckets = [];
  for (let i = 0; i < cellsX * cellsY; i++) buckets.push([]);

  for (let i = 0; i < cache.length; i++) {
    const c = cache[i];
    const colMin = Math.max(0, Math.floor(c.minX / cellW));
    const colMax = Math.min(cellsX - 1, Math.floor(c.maxX / cellW));
    const rowMin = Math.max(0, Math.floor(c.minY / cellH));
    const rowMax = Math.min(cellsY - 1, Math.floor(c.maxY / cellH));

    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        buckets[row * cellsX + col].push(i);
      }
    }
  }

  return {
    cellsX, cellsY, cellW, cellH,
    cells: buckets.map(b => new Int32Array(b)),
  };
}

function buildWindingIndex(cache) {
  const n = cache.length;
  const idxArray = [];
  for (let i = 0; i < n; i++) idxArray.push(i);
  idxArray.sort((a, b) => cache[a].minY - cache[b].minY);

  const sortedByMinY = new Int32Array(idxArray);
  const minYs = new Float64Array(n);
  for (let i = 0; i < n; i++) minYs[i] = cache[sortedByMinY[i]].minY;

  return { sortedByMinY, minYs };
}

function upperBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function lineWindingXY(px, py, x0, y0, x1, y1) {
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

function segmentWindingXY(px, py, seg) {
  if (seg.type === 'line') {
    return lineWindingXY(px, py, seg.p0.x, seg.p0.y, seg.p1.x, seg.p1.y);
  }
  let winding = 0;
  let prevX = seg.p0.x, prevY = seg.p0.y;
  for (let i = 1; i <= 8; i++) {
    const t = i * 0.125;
    let nextX, nextY;
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

function windingNumberSorted(px, py, cache, windIdx) {
  const hiIdx = upperBound(windIdx.minYs, py);
  let winding = 0;
  const sorted = windIdx.sortedByMinY;
  for (let i = 0; i < hiIdx; i++) {
    const c = cache[sorted[i]];
    if (c.maxY <= py) continue;
    winding += segmentWindingXY(px, py, c.seg);
  }
  return winding;
}

function searchGridCell(cellIdx, point, cache, grid, minDist) {
  const indices = grid.cells[cellIdx];
  const px = point.x, py = point.y;
  for (let j = 0; j < indices.length; j++) {
    const c = cache[indices[j]];
    const dx = px < c.minX ? c.minX - px : px > c.maxX ? px - c.maxX : 0;
    const dy = py < c.minY ? c.minY - py : py > c.maxY ? py - c.maxY : 0;
    if (dx * dx + dy * dy >= minDist * minDist) continue;
    const d = pointToSegmentDistance(point, c.seg);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

function findMinDistanceSpatial(point, cache, grid, initialBound) {
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

    if (rMin >= 0) {
      for (let col = Math.max(0, cMin); col <= Math.min(grid.cellsX - 1, cMax); col++) {
        minDist = searchGridCell(rMin * grid.cellsX + col, point, cache, grid, minDist);
      }
    }
    if (rMax < grid.cellsY && rMax !== rMin) {
      for (let col = Math.max(0, cMin); col <= Math.min(grid.cellsX - 1, cMax); col++) {
        minDist = searchGridCell(rMax * grid.cellsX + col, point, cache, grid, minDist);
      }
    }
    if (cMin >= 0) {
      for (let row = Math.max(0, rMin + 1); row <= Math.min(grid.cellsY - 1, rMax - 1); row++) {
        minDist = searchGridCell(row * grid.cellsX + cMin, point, cache, grid, minDist);
      }
    }
    if (cMax < grid.cellsX && cMax !== cMin) {
      for (let row = Math.max(0, rMin + 1); row <= Math.min(grid.cellsY - 1, rMax - 1); row++) {
        minDist = searchGridCell(row * grid.cellsX + cMax, point, cache, grid, minDist);
      }
    }
  }

  return minDist;
}

function bilinearInterpolate(coarseData, coarseW, coarseH, fineX, fineY, blockSize) {
  const halfBlock = blockSize * 0.5;
  const u = (fineX + 0.5 - halfBlock) / blockSize;
  const v = (fineY + 0.5 - halfBlock) / blockSize;

  const i0 = Math.max(0, Math.min(coarseW - 1, Math.floor(u)));
  const j0 = Math.max(0, Math.min(coarseH - 1, Math.floor(v)));
  const i1 = Math.min(coarseW - 1, i0 + 1);
  const j1 = Math.min(coarseH - 1, j0 + 1);

  const fx = Math.max(0, Math.min(1, u - i0));
  const fy = Math.max(0, Math.min(1, v - j0));

  const v00 = coarseData[j0 * coarseW + i0];
  const v10 = coarseData[j0 * coarseW + i1];
  const v01 = coarseData[j1 * coarseW + i0];
  const v11 = coarseData[j1 * coarseW + i1];

  return (1 - fx) * (1 - fy) * v00 + fx * (1 - fy) * v10
       + (1 - fx) * fy * v01 + fx * fy * v11;
}

function computeSDF(segments, width, height, baselineRow) {
  const cache = buildSegmentCache(segments);
  if (cache.length < 25) {
    return computeSDFSimple(cache, width, height, baselineRow);
  }
  return computeSDFAccelerated(cache, width, height, baselineRow);
}

function computeSDFSimple(cache, width, height, baselineRow) {
  const data = new Float64Array(width * height);
  const n = cache.length;
  const point = { x: 0, y: 0 };

  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    let prevDist = Infinity;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      point.x = px; point.y = py;
      let minDist = prevDist + 1;
      for (let i = 0; i < n; i++) {
        const c = cache[i];
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

function computeSDFAccelerated(cache, width, height, baselineRow) {
  const data = new Float64Array(width * height);
  const grid = buildSpatialGrid(cache, width, height);
  const windIdx = buildWindingIndex(cache);
  const point = { x: 0, y: 0 };

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

  // Phase 2: Classify blocks
  const exactBlock = new Uint8Array(coarseW * coarseH);
  for (let i = 0; i < coarseData.length; i++) {
    if (Math.abs(coarseData[i]) <= SAFE_MARGIN) exactBlock[i] = 1;
  }

  // Phase 3: Fine pass, row by row
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    let prevDist = Infinity;

    for (let x = 0; x < width; x++) {
      const blockIdx = Math.floor(y / BLOCK_SIZE) * coarseW + Math.floor(x / BLOCK_SIZE);

      if (exactBlock[blockIdx]) {
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

// ========================================================================
// Message handler
// ========================================================================

parentPort.on('message', (msg) => {
  if (msg.type === 'exit') process.exit(0);

  if (msg.type === 'sdf') {
    const sdf = computeSDF(msg.segments, msg.width, msg.height, msg.baselineRow);
    // Transfer Float64Array (zero-copy, 131KB per SDF).
    // This detaches sdf.data.buffer in this thread -- do NOT reference it after posting.
    // Safe here because computeSDF() creates a fresh Float64Array each call.
    parentPort.postMessage({ id: msg.id, type: 'sdf', data: sdf.data }, [sdf.data.buffer]);
  } else {
    // Raycasting: enriched signature with counts + positions + crossing angles + pings (min + max)
    const { counts, positions, angles, pingDistances, pingMax } = computeEnrichedSignature(msg.gridSegments, msg.numAngles, msg.raysPerAngle, msg.gridSize);
    parentPort.postMessage({ id: msg.id, type: 'signature', counts, positions, angles, pingDistances, pingMax });
  }
});
