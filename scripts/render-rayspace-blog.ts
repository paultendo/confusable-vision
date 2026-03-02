/**
 * render-rayspace-blog.ts -- Visualizations for the RaySpace blog post.
 *
 * Generates PNG images showing rays passing through glyph outlines,
 * intersection points, ping rays, and side-by-side comparisons.
 *
 * Usage: npx tsx scripts/render-rayspace-blog.ts
 */
import fs from 'node:fs';
import { createCanvas, type CanvasRenderingContext2D } from 'canvas';
import {
  loadFont,
  extractGlyphPath,
  concatGlyphPaths,
  normalizeToGrid,
  getFontMetrics,
} from '../src/glyph-path.js';
import {
  raySegmentIntersectionsEnriched,
  computePingRay,
  type EnrichedHit,
} from '../src/raycasting.js';
import type { PathSegment, PathPoint, GlyphPathData, FontMetricsData } from '../src/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FONT_PATH = '/System/Library/Fonts/Helvetica.ttc';
const GRID_SIZE = 128;
const OUTPUT_DIR = 'data/output/rayspace-blog';

// Colors
const COL_GLYPH_FILL = '#EDEDED';
const COL_GLYPH_STROKE = '#444444';
const COL_RAY_BG = 'rgba(51, 102, 204, 0.12)';
const COL_RAY_HIT = 'rgba(51, 102, 204, 0.50)';
const COL_DOT = '#CC4444';
const COL_PING_HIT = '#22AA44';
const COL_PING_MISS = '#CC2222';
const COL_BG = '#FFFFFF';
const COL_LABEL = '#333333';
const COL_SUBLABEL = '#888888';

// ---------------------------------------------------------------------------
// Coordinate transform
// ---------------------------------------------------------------------------
interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

function tx(p: PathPoint, t: Transform): { x: number; y: number } {
  return { x: t.offsetX + p.x * t.scale, y: t.offsetY + p.y * t.scale };
}

// ---------------------------------------------------------------------------
// drawGlyphOutline -- PathSegment[] to canvas path
// ---------------------------------------------------------------------------
function drawGlyphOutline(
  ctx: CanvasRenderingContext2D,
  segments: PathSegment[],
  t: Transform,
  opts: { fill?: string; stroke?: string; lineWidth?: number },
): void {
  ctx.beginPath();

  let lastX = NaN;
  let lastY = NaN;

  for (const seg of segments) {
    const p0 = tx(seg.p0, t);

    // Detect contour boundary: if starting point differs from where we left off
    if (isNaN(lastX) || Math.abs(p0.x - lastX) > 0.5 || Math.abs(p0.y - lastY) > 0.5) {
      ctx.moveTo(p0.x, p0.y);
    }

    if (seg.type === 'line') {
      const p1 = tx(seg.p1, t);
      ctx.lineTo(p1.x, p1.y);
      lastX = p1.x;
      lastY = p1.y;
    } else if (seg.type === 'quadratic') {
      const p1 = tx(seg.p1, t);
      const p2 = tx(seg.p2, t);
      ctx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
      lastX = p2.x;
      lastY = p2.y;
    } else {
      const p1 = tx(seg.p1, t);
      const p2 = tx(seg.p2, t);
      const p3 = tx(seg.p3, t);
      ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
      lastX = p3.x;
      lastY = p3.y;
    }
  }

  if (opts.fill) {
    ctx.fillStyle = opts.fill;
    ctx.fill('evenodd');
  }
  if (opts.stroke) {
    ctx.strokeStyle = opts.stroke;
    ctx.lineWidth = opts.lineWidth ?? 1.5;
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// computeRaysForViz -- ray geometry for a single angle
// ---------------------------------------------------------------------------
interface VizRay {
  origin: PathPoint;
  direction: PathPoint;
  hits: EnrichedHit[];
  /** Far end of the ray for drawing (clipped to bbox span) */
  farT: number;
}

function computeBBox(segments: PathSegment[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const update = (p: PathPoint) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const seg of segments) {
    update(seg.p0);
    if (seg.type === 'line') update(seg.p1);
    else if (seg.type === 'quadratic') { update(seg.p1); update(seg.p2); }
    else { update(seg.p1); update(seg.p2); update(seg.p3); }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 128, maxY: 128 };
  return { minX, minY, maxX, maxY };
}

function computeRaysForViz(
  segments: PathSegment[],
  angle: number,
  numRays: number,
): VizRay[] {
  const bbox = computeBBox(segments);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const nx = -dy;
  const ny = dx;

  // Project bbox corners onto normal and direction axes
  const corners = [
    { x: bbox.minX, y: bbox.minY }, { x: bbox.maxX, y: bbox.minY },
    { x: bbox.minX, y: bbox.maxY }, { x: bbox.maxX, y: bbox.maxY },
  ];

  let minProj = Infinity, maxProj = -Infinity;
  let minDirProj = Infinity, maxDirProj = -Infinity;
  for (const c of corners) {
    const pn = nx * c.x + ny * c.y;
    const pd = dx * c.x + dy * c.y;
    if (pn < minProj) minProj = pn;
    if (pn > maxProj) maxProj = pn;
    if (pd < minDirProj) minDirProj = pd;
    if (pd > maxDirProj) maxDirProj = pd;
  }

  const margin = (maxProj - minProj) * 0.05;
  const rangeStart = minProj - margin;
  const rangeEnd = maxProj + margin;
  const step = numRays > 1 ? (rangeEnd - rangeStart) / (numRays - 1) : 0;
  const dirSpan = maxDirProj - minDirProj;
  const direction: PathPoint = { x: dx, y: dy };

  const rays: VizRay[] = [];
  for (let r = 0; r < numRays; r++) {
    const offset = numRays > 1 ? rangeStart + r * step : (rangeStart + rangeEnd) / 2;
    const origin: PathPoint = {
      x: nx * offset + dx * (minDirProj - 1),
      y: ny * offset + dy * (minDirProj - 1),
    };

    const allHits: EnrichedHit[] = [];
    for (const seg of segments) {
      const hits = raySegmentIntersectionsEnriched(origin, direction, seg);
      allHits.push(...hits);
    }
    allHits.sort((a, b) => a.t - b.t);

    rays.push({
      origin,
      direction,
      hits: allHits.slice(0, 10),
      farT: dirSpan + 2,
    });
  }
  return rays;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------
function drawRayLine(
  ctx: CanvasRenderingContext2D,
  ray: VizRay,
  t: Transform,
  color: string,
  lineWidth = 1,
): void {
  const start = tx({
    x: ray.origin.x + ray.direction.x * 0.5,
    y: ray.origin.y + ray.direction.y * 0.5,
  }, t);
  const end = tx({
    x: ray.origin.x + ray.direction.x * ray.farT,
    y: ray.origin.y + ray.direction.y * ray.farT,
  }, t);

  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
}

function drawDot(
  ctx: CanvasRenderingContext2D,
  point: PathPoint,
  t: Transform,
  color: string,
  radius = 4,
): void {
  const p = tx(point, t);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawPingArrow(
  ctx: CanvasRenderingContext2D,
  hitPoint: PathPoint,
  direction: PathPoint,
  length: number,
  t: Transform,
  color: string,
  dashed: boolean,
): void {
  const start = tx(hitPoint, t);
  const end = tx({
    x: hitPoint.x + direction.x * length,
    y: hitPoint.y + direction.y * length,
  }, t);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dashed ? [4, 4] : []);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Arrowhead
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 4) return;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = 6;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - ux * headLen + uy * headLen * 0.4, end.y - uy * headLen - ux * headLen * 0.4);
  ctx.lineTo(end.x - ux * headLen - uy * headLen * 0.4, end.y - uy * headLen + ux * headLen * 0.4);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Glyph loading helper
// ---------------------------------------------------------------------------
function loadGlyph(font: ReturnType<typeof loadFont>, metrics: FontMetricsData, codepoint: number): PathSegment[] | null {
  const pathData = extractGlyphPath(font!, codepoint);
  if (!pathData) return null;
  return normalizeToGrid(pathData, metrics, GRID_SIZE);
}

function loadBigram(font: ReturnType<typeof loadFont>, metrics: FontMetricsData, text: string): PathSegment[] | null {
  const pathData = concatGlyphPaths(font!, text);
  if (!pathData) return null;
  return normalizeToGrid(pathData, metrics, GRID_SIZE);
}

function makeTransform(segments: PathSegment[], vizSize: number, padding: number): Transform {
  const bbox = computeBBox(segments);
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;
  const maxDim = Math.max(w, h, 1);
  const scale = vizSize / maxDim;
  return {
    scale,
    offsetX: padding + (vizSize - w * scale) / 2 - bbox.minX * scale,
    offsetY: padding + (vizSize - h * scale) / 2 - bbox.minY * scale,
  };
}

function makeTransformShared(
  segments: PathSegment[],
  vizSize: number,
  padding: number,
  maxDim: number,
): Transform {
  const bbox = computeBBox(segments);
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;
  const scale = vizSize / maxDim;
  return {
    scale,
    offsetX: padding + (vizSize - w * scale) / 2 - bbox.minX * scale,
    offsetY: padding + (vizSize - h * scale) / 2 - bbox.minY * scale,
  };
}

// ---------------------------------------------------------------------------
// Shared helper: draw ping rays at each intersection
// ---------------------------------------------------------------------------
function drawPingsForHit(
  ctx: CanvasRenderingContext2D,
  hit: EnrichedHit,
  segs: PathSegment[],
  t: Transform,
  opts: { dotRadius?: number; maxPingLen?: number } = {},
): void {
  const dotR = opts.dotRadius ?? 2.5;
  const maxLen = opts.maxPingLen ?? 15;
  const tLen = Math.hypot(hit.tangent.x, hit.tangent.y);
  if (tLen < 1e-8) return;

  const pnx = -hit.tangent.y / tLen;
  const pny = hit.tangent.x / tLen;
  const n1: PathPoint = { x: pnx, y: pny };
  const n2: PathPoint = { x: -pnx, y: -pny };
  const d1 = computePingRay(hit.hitPoint, n1, segs);
  const d2 = computePingRay(hit.hitPoint, n2, segs);
  const v1 = d1 != null && d1 > 0 && isFinite(d1) ? d1 : null;
  const v2 = d2 != null && d2 > 0 && isFinite(d2) ? d2 : null;

  // Shorter = stroke width (pingDistances), Longer = counter depth (pingMax)
  const shortDir = (v1 != null && v2 != null) ? (v1 <= v2 ? n1 : n2) :
                   (v1 != null) ? n1 : (v2 != null) ? n2 : n1;
  const longDir = (v1 != null && v2 != null) ? (v1 <= v2 ? n2 : n1) :
                  (v1 != null) ? n2 : (v2 != null) ? n1 : n2;
  const shortDist = (v1 != null && v2 != null) ? Math.min(v1, v2) :
                    (v1 ?? v2 ?? null);
  const longDist = (v1 != null && v2 != null) ? Math.max(v1, v2) : null;

  // Draw shorter ping (stroke width) -- green
  if (shortDist != null) {
    drawPingArrow(ctx, hit.hitPoint, shortDir, shortDist, t, COL_PING_HIT, false);
  }

  // Draw longer ping (counter depth)
  if (longDist != null) {
    // Hit far wall -- lighter green
    drawPingArrow(ctx, hit.hitPoint, longDir, longDist, t, '#44BB66', false);
  } else if (shortDist != null) {
    // One direction hit, other escaped -- red dashed
    drawPingArrow(ctx, hit.hitPoint, longDir, maxLen, t, COL_PING_MISS, true);
  } else {
    // Both escaped
    drawPingArrow(ctx, hit.hitPoint, n1, maxLen, t, COL_PING_MISS, true);
    drawPingArrow(ctx, hit.hitPoint, n2, maxLen, t, COL_PING_MISS, true);
  }
}

// ---------------------------------------------------------------------------
// Image 1: Hero -- Rays through "a"
// ---------------------------------------------------------------------------
function renderImage1(font: ReturnType<typeof loadFont>, metrics: FontMetricsData): void {
  console.log('[1/4] Rendering hero: rays through "a"...');

  const segments = loadGlyph(font, metrics, 0x0061)!;
  const W = 800, H = 800, PAD = 80;
  const vizSize = W - PAD * 2;
  const t = makeTransform(segments, vizSize, PAD);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = COL_BG;
  ctx.fillRect(0, 0, W, H);

  // Cast rays at ~15 degrees
  const angle = Math.PI / 12;
  const rays = computeRaysForViz(segments, angle, 15);

  // Draw all rays (light)
  for (const ray of rays) {
    drawRayLine(ctx, ray, t, COL_RAY_BG, 1);
  }

  // Draw glyph on top
  drawGlyphOutline(ctx, segments, t, {
    fill: COL_GLYPH_FILL,
    stroke: COL_GLYPH_STROKE,
    lineWidth: 2,
  });

  // Draw highlighted rays, then pings, then dots on top so the dot
  // visually sits at the junction between main ray and ping ray.
  // 1) Highlighted ray lines
  for (const ray of rays) {
    if (ray.hits.length > 0) {
      drawRayLine(ctx, ray, t, COL_RAY_HIT, 1.5);
    }
  }
  // 2) Ping rays on every 4th ray
  for (let i = 0; i < rays.length; i++) {
    if (rays[i].hits.length > 0 && i % 4 === 0) {
      for (const hit of rays[i].hits) {
        drawPingsForHit(ctx, hit, segments, t, { dotRadius: 2, maxPingLen: 12 });
      }
    }
  }
  // 3) Intersection dots on top of everything
  for (const ray of rays) {
    for (const hit of ray.hits) {
      drawDot(ctx, hit.hitPoint, t, COL_DOT, 4);
    }
  }

  // Label
  ctx.fillStyle = COL_SUBLABEL;
  ctx.font = '16px "Helvetica Neue"';
  ctx.textAlign = 'center';
  ctx.fillText('Parallel rays at 15 degrees through "a" in Helvetica', W / 2, H - 24);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(`${OUTPUT_DIR}/01-rays-through-glyph.png`, buf);
  console.log(`  Written: 01-rays-through-glyph.png (${(buf.length / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------------------
// Image 2: c vs o with ping rays
//
// Shows the key discriminator: at each intersection, a ping ray fires
// perpendicular to the curve tangent (the inward normal). If it hits the
// opposite wall, that measures stroke width (green). If it escapes through
// an opening (like the gap in "c"), the ping misses (red dashed).
// ---------------------------------------------------------------------------
function renderImage2(font: ReturnType<typeof loadFont>, metrics: FontMetricsData): void {
  console.log('[2/4] Rendering c vs o with ping rays...');

  const segsO = loadGlyph(font, metrics, 0x006F)!; // o
  const segsC = loadGlyph(font, metrics, 0x0063)!; // c

  const PANEL_W = 550, PANEL_H = 550, PAD = 60, GAP = 100;
  const W = PANEL_W * 2 + GAP, H = PANEL_H + 130;
  const vizSize = PANEL_W - PAD * 2;

  // Use shared scale for both glyphs
  const bboxO = computeBBox(segsO);
  const bboxC = computeBBox(segsC);
  const maxDim = Math.max(
    bboxO.maxX - bboxO.minX, bboxO.maxY - bboxO.minY,
    bboxC.maxX - bboxC.minX, bboxC.maxY - bboxC.minY,
    1,
  );

  const tO = makeTransformShared(segsO, vizSize, PAD, maxDim);
  const tC: Transform = {
    ...makeTransformShared(segsC, vizSize, PAD, maxDim),
    offsetX: makeTransformShared(segsC, vizSize, PAD, maxDim).offsetX + PANEL_W + GAP,
  };

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = COL_BG;
  ctx.fillRect(0, 0, W, H);

  // Use a slight angle (~10 degrees) so pings are visually distinct from
  // the main ray direction. Horizontal rays produce near-horizontal pings
  // at the left/right sides of "o", which is confusing.
  const angle = Math.PI / 18; // 10 degrees
  const raysO = computeRaysForViz(segsO, angle, 4);
  const raysC = computeRaysForViz(segsC, angle, 4);

  // Helper to render one panel with ping visualization
  function renderPanel(
    segs: PathSegment[],
    rays: VizRay[],
    t: Transform,
    label: string,
  ): void {
    // 1) Background rays
    for (const ray of rays) {
      drawRayLine(ctx, ray, t, COL_RAY_BG, 1);
    }

    // 2) Highlighted main rays (thicker, more visible)
    for (const ray of rays) {
      if (ray.hits.length > 0) {
        drawRayLine(ctx, ray, t, COL_RAY_HIT, 2);
      }
    }

    // 3) Glyph outline
    drawGlyphOutline(ctx, segs, t, {
      fill: COL_GLYPH_FILL,
      stroke: COL_GLYPH_STROKE,
      lineWidth: 2,
    });

    // 4) Ping rays (beneath dots)
    for (const ray of rays) {
      for (const hit of ray.hits) {
        drawPingsForHit(ctx, hit, segs, t, { maxPingLen: 15 });
      }
    }

    // 5) Intersection dots on top -- clearly at the junction
    for (const ray of rays) {
      for (const hit of ray.hits) {
        drawDot(ctx, hit.hitPoint, t, COL_DOT, 4.5);
      }
    }

    // Panel label
    ctx.fillStyle = COL_LABEL;
    ctx.font = 'bold 20px "Helvetica Neue"';
    ctx.textAlign = 'center';
    ctx.fillText(label, t.offsetX + vizSize / 2, PANEL_H + 40);
  }

  renderPanel(segsO, raysO, tO, '"o" -- pings hit opposite wall');
  renderPanel(segsC, raysC, tC, '"c" -- pings escape at opening');

  // Legend
  ctx.font = '14px "Helvetica Neue"';
  ctx.textAlign = 'left';
  ctx.fillStyle = COL_PING_HIT;
  ctx.fillRect(PAD, H - 40, 16, 16);
  ctx.fillStyle = COL_SUBLABEL;
  ctx.fillText('Ping hit opposite wall (stroke width)', PAD + 22, H - 27);

  ctx.fillStyle = COL_PING_MISS;
  ctx.fillRect(PAD + 300, H - 40, 16, 16);
  ctx.fillStyle = COL_SUBLABEL;
  ctx.fillText('Ping escaped (open counter)', PAD + 322, H - 27);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(`${OUTPUT_DIR}/02-c-vs-o-ping-rays.png`, buf);
  console.log(`  Written: 02-c-vs-o-ping-rays.png (${(buf.length / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------------------
// Image 3: Latin o vs Cyrillic o
// ---------------------------------------------------------------------------
function renderImage3(font: ReturnType<typeof loadFont>, metrics: FontMetricsData): void {
  console.log('[3/4] Rendering Latin o vs Cyrillic o...');

  const segsLatin = loadGlyph(font, metrics, 0x006F)!;  // Latin o
  const segsCyrillic = loadGlyph(font, metrics, 0x043E)!; // Cyrillic o

  const PANEL_W = 500, PANEL_H = 500, PAD = 50, GAP = 200;
  const W = PANEL_W * 2 + GAP, H = PANEL_H + 100;
  const vizSize = PANEL_W - PAD * 2;

  const bboxL = computeBBox(segsLatin);
  const bboxC = computeBBox(segsCyrillic);
  const maxDim = Math.max(
    bboxL.maxX - bboxL.minX, bboxL.maxY - bboxL.minY,
    bboxC.maxX - bboxC.minX, bboxC.maxY - bboxC.minY,
    1,
  );

  const tL = makeTransformShared(segsLatin, vizSize, PAD, maxDim);
  const tC: Transform = {
    ...makeTransformShared(segsCyrillic, vizSize, PAD, maxDim),
    offsetX: makeTransformShared(segsCyrillic, vizSize, PAD, maxDim).offsetX + PANEL_W + GAP,
  };

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = COL_BG;
  ctx.fillRect(0, 0, W, H);

  const angle = Math.PI / 6; // 30 degrees
  const raysL = computeRaysForViz(segsLatin, angle, 8);
  const raysC = computeRaysForViz(segsCyrillic, angle, 8);

  function renderPanel(segs: PathSegment[], rays: VizRay[], t: Transform, label: string): void {
    // 1) Background rays
    for (const ray of rays) drawRayLine(ctx, ray, t, COL_RAY_BG, 1);
    // 2) Highlighted rays
    for (const ray of rays) {
      if (ray.hits.length > 0) drawRayLine(ctx, ray, t, COL_RAY_HIT, 1.5);
    }
    // 3) Glyph
    drawGlyphOutline(ctx, segs, t, {
      fill: COL_GLYPH_FILL,
      stroke: COL_GLYPH_STROKE,
      lineWidth: 2,
    });
    // 4) Pings on every 3rd ray
    for (let i = 0; i < rays.length; i++) {
      if (rays[i].hits.length > 0 && i % 3 === 0) {
        for (const hit of rays[i].hits) {
          drawPingsForHit(ctx, hit, segs, t, { maxPingLen: 12 });
        }
      }
    }
    // 5) Dots on top
    for (const ray of rays) {
      for (const hit of ray.hits) drawDot(ctx, hit.hitPoint, t, COL_DOT, 3.5);
    }

    ctx.fillStyle = COL_LABEL;
    ctx.font = 'bold 18px "Helvetica Neue"';
    ctx.textAlign = 'center';
    ctx.fillText(label, t.offsetX + vizSize / 2, PANEL_H + 30);
  }

  renderPanel(segsLatin, raysL, tL, 'Latin o (U+006F)');
  renderPanel(segsCyrillic, raysC, tC, 'Cyrillic o (U+043E)');

  // Distance annotation between panels
  ctx.fillStyle = COL_SUBLABEL;
  ctx.font = '16px "Helvetica Neue"';
  ctx.textAlign = 'center';
  ctx.fillText('distance = 0.020', W / 2, PANEL_H / 2 - 10);
  ctx.fillText('(identical in 44/61 fonts)', W / 2, PANEL_H / 2 + 14);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(`${OUTPUT_DIR}/03-latin-o-cyrillic-o.png`, buf);
  console.log(`  Written: 03-latin-o-cyrillic-o.png (${(buf.length / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------------------
// Image 4: rn vs m
// ---------------------------------------------------------------------------
function renderImage4(font: ReturnType<typeof loadFont>, metrics: FontMetricsData): void {
  console.log('[4/4] Rendering rn vs m...');

  const segsRN = loadBigram(font, metrics, 'rn')!;
  const segsM = loadGlyph(font, metrics, 0x006D)!; // m

  const PANEL_W = 550, PANEL_H = 500, PAD = 50, GAP = 100;
  const W = PANEL_W * 2 + GAP, H = PANEL_H + 100;
  const vizSize = PANEL_W - PAD * 2;

  // Shared scale across both -- "rn" is wider than "m"
  const bboxRN = computeBBox(segsRN);
  const bboxM = computeBBox(segsM);
  const maxDim = Math.max(
    bboxRN.maxX - bboxRN.minX, bboxRN.maxY - bboxRN.minY,
    bboxM.maxX - bboxM.minX, bboxM.maxY - bboxM.minY,
    1,
  );

  const tRN = makeTransformShared(segsRN, vizSize, PAD, maxDim);
  const tM: Transform = {
    ...makeTransformShared(segsM, vizSize, PAD, maxDim),
    offsetX: makeTransformShared(segsM, vizSize, PAD, maxDim).offsetX + PANEL_W + GAP,
  };

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = COL_BG;
  ctx.fillRect(0, 0, W, H);

  const angle = Math.PI / 9; // 20 degrees
  const raysRN = computeRaysForViz(segsRN, angle, 12);
  const raysM = computeRaysForViz(segsM, angle, 12);

  function renderPanel(segs: PathSegment[], rays: VizRay[], t: Transform, label: string): void {
    // 1) Background rays
    for (const ray of rays) drawRayLine(ctx, ray, t, COL_RAY_BG, 1);
    // 2) Highlighted rays
    for (const ray of rays) {
      if (ray.hits.length > 0) drawRayLine(ctx, ray, t, COL_RAY_HIT, 1.5);
    }
    // 3) Glyph
    drawGlyphOutline(ctx, segs, t, {
      fill: COL_GLYPH_FILL,
      stroke: COL_GLYPH_STROKE,
      lineWidth: 2,
    });
    // 4) Pings on every 3rd ray
    for (let i = 0; i < rays.length; i++) {
      if (rays[i].hits.length > 0 && i % 3 === 0) {
        for (const hit of rays[i].hits) {
          drawPingsForHit(ctx, hit, segs, t, { maxPingLen: 12 });
        }
      }
    }
    // 5) Dots on top
    for (const ray of rays) {
      for (const hit of ray.hits) drawDot(ctx, hit.hitPoint, t, COL_DOT, 3.5);
    }

    ctx.fillStyle = COL_LABEL;
    ctx.font = 'bold 18px "Helvetica Neue"';
    ctx.textAlign = 'center';
    ctx.fillText(label, t.offsetX + vizSize / 2, PANEL_H + 30);
  }

  renderPanel(segsRN, raysRN, tRN, '"rn" (Latin bigram)');
  renderPanel(segsM, raysM, tM, '"m" (single character)');

  // Distance annotation
  ctx.fillStyle = COL_SUBLABEL;
  ctx.font = '16px "Helvetica Neue"';
  ctx.textAlign = 'center';
  ctx.fillText('distance = 0.531', W / 2, PANEL_H / 2 - 10);
  ctx.fillText('(95 fonts, 33 below 0.40)', W / 2, PANEL_H / 2 + 14);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(`${OUTPUT_DIR}/04-rn-vs-m-multichar.png`, buf);
  console.log(`  Written: 04-rn-vs-m-multichar.png (${(buf.length / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const font = loadFont(FONT_PATH);
  if (!font) {
    console.error('Could not load Helvetica from', FONT_PATH);
    process.exit(1);
  }
  const metrics = getFontMetrics(font);
  console.log(`Font loaded: Helvetica (unitsPerEm=${metrics.unitsPerEm}, ascender=${metrics.ascender})`);

  renderImage1(font, metrics);
  renderImage2(font, metrics);
  renderImage3(font, metrics);
  renderImage4(font, metrics);

  console.log('\nDone. Output in', OUTPUT_DIR);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
