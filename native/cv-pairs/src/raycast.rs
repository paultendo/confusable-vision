//! computeEnrichedSignature (src/raycasting.ts), ported line for line, with one deliberate difference: rays are cast
//! through the glyph's filled shape, the union of its contours under the nonzero rule, as a renderer fills it. The
//! TypeScript counts every contour edge a ray meets, including edges inside overlapping strokes (variable fonts keep
//! strokes as overlapping pieces) and a vertex twice (once for each segment that meets there). Here a hit counts only
//! where the ray enters or leaves the filled shape (classify), and pings measure to the next such boundary. Checked on
//! Noto Sans 2.015, variable (overlapping) against static (overlaps removed), all 2,246 letters and digits: median
//! distance 0.003, max 0.12; counting every edge instead, 313 letters differ by more than 0.1 and up to 1.8. With
//! CV_LEGACY=1 the TypeScript's measurement is reproduced byte for byte.
//!
//! Every expression keeps the TypeScript's operand order (JavaScript evaluates left to right and never fuses a multiply
//! with an add), and Math.* calls go through jsmath, which reproduces Node's results bit for bit. Segments arrive
//! already normalised by the TypeScript (normalizeToGrid / normalizeToEmFrame), as f64.

use crate::jsmath as m;

const EPSILON: f64 = 1e-10;
const PING_EPSILON: f64 = 1e-4;

#[derive(Clone, Copy)]
pub struct P { pub x: f64, pub y: f64 }

#[derive(Clone, Copy)]
pub enum Seg { Line(P, P), Quad(P, P, P), Cubic(P, P, P, P) }

impl Seg {
    fn p0(&self) -> P { match *self { Seg::Line(a, _) | Seg::Quad(a, _, _) | Seg::Cubic(a, _, _, _) => a } }
}

pub struct Frame { pub min_x: f64, pub min_y: f64, pub max_x: f64, pub max_y: f64 }

pub struct Signature { pub counts: Vec<u8>, pub positions: Vec<u8>, pub angles: Vec<u8>, pub ping_dist: Vec<u8>, pub ping_max: Vec<u8>, pub overlapping: bool }

/// Up to 3 roots, in the order the TypeScript pushes them.
struct Roots { v: [f64; 3], n: usize }
impl Roots {
    fn new() -> Self { Roots { v: [0.0; 3], n: 0 } }
    fn push(&mut self, t: f64) { self.v[self.n] = t; self.n += 1; }
    fn as_slice(&self) -> &[f64] { &self.v[..self.n] }
}

fn solve_quadratic(a: f64, b: f64, c: f64) -> Roots {
    let mut roots = Roots::new();
    if a.abs() < EPSILON {
        if b.abs() < EPSILON { return roots; }
        let t = -c / b;
        if t >= -EPSILON && t <= 1.0 + EPSILON { roots.push(m::max(0.0, m::min(1.0, t))); }
        return roots;
    }
    let discriminant = b * b - 4.0 * a * c;
    if discriminant < -EPSILON { return roots; }
    let sqrt_d = m::max(0.0, discriminant).sqrt();
    let t1 = (-b - sqrt_d) / (2.0 * a);
    let t2 = (-b + sqrt_d) / (2.0 * a);
    if t1 >= -EPSILON && t1 <= 1.0 + EPSILON { roots.push(m::max(0.0, m::min(1.0, t1))); }
    if t2 >= -EPSILON && t2 <= 1.0 + EPSILON && (t2 - t1).abs() > EPSILON { roots.push(m::max(0.0, m::min(1.0, t2))); }
    roots
}

#[inline] fn add_root(roots: &mut Roots, t: f64) {
    if t >= -EPSILON && t <= 1.0 + EPSILON { roots.push(m::max(0.0, m::min(1.0, t))); }
}

fn solve_cubic(a: f64, b: f64, c: f64, d: f64) -> Roots {
    if a.abs() < EPSILON { return solve_quadratic(b, c, d); }
    let p = b / a;
    let q = c / a;
    let r = d / a;
    let p2 = (3.0 * q - p * p) / 3.0;
    let q2 = (2.0 * p * p * p - 9.0 * p * q + 27.0 * r) / 27.0;
    let discriminant = q2 * q2 / 4.0 + p2 * p2 * p2 / 27.0;
    let offset = -p / 3.0;
    let mut roots = Roots::new();
    if discriminant.abs() < EPSILON {
        if q2.abs() < EPSILON {
            add_root(&mut roots, offset);
        } else {
            let u = m::cbrt(-q2 / 2.0);
            add_root(&mut roots, 2.0 * u + offset);
            add_root(&mut roots, -u + offset);
        }
    } else if discriminant > 0.0 {
        let sqrt_d = discriminant.sqrt();
        let u = m::cbrt(-q2 / 2.0 + sqrt_d);
        let v = m::cbrt(-q2 / 2.0 - sqrt_d);
        add_root(&mut roots, u + v + offset);
    } else {
        let mm = 2.0 * (-p2 / 3.0).sqrt();
        let theta = m::acos(3.0 * q2 / (p2 * mm)) / 3.0;
        add_root(&mut roots, mm * m::cos(theta) + offset);
        add_root(&mut roots, mm * m::cos(theta - 2.0 * std::f64::consts::PI / 3.0) + offset);
        add_root(&mut roots, mm * m::cos(theta - 4.0 * std::f64::consts::PI / 3.0) + offset);
    }
    roots
}

/// A NaN from acos can reach add_root only as NaN, which fails both comparisons, as in JavaScript.
fn solve_for_s_roots(nx: f64, ny: f64, ox: f64, oy: f64, seg: &Seg) -> Roots {
    let project = |p: P| nx * (p.x - ox) + ny * (p.y - oy);
    match *seg {
        Seg::Line(p0, p1) => { let d0 = project(p0); let d1 = project(p1); solve_quadratic(0.0, d1 - d0, d0) }
        Seg::Quad(p0, p1, p2) => {
            let d0 = project(p0); let d1 = project(p1); let d2 = project(p2);
            solve_quadratic(d0 - 2.0 * d1 + d2, 2.0 * (d1 - d0), d0)
        }
        Seg::Cubic(p0, p1, p2, p3) => {
            let d0 = project(p0); let d1 = project(p1); let d2 = project(p2); let d3 = project(p3);
            solve_cubic(-d0 + 3.0 * d1 - 3.0 * d2 + d3, 3.0 * d0 - 6.0 * d1 + 3.0 * d2, -3.0 * d0 + 3.0 * d1, d0)
        }
    }
}

fn eval_point(seg: &Seg, s: f64) -> P {
    match *seg {
        Seg::Line(p0, p1) => { let mt = 1.0 - s; P { x: mt * p0.x + s * p1.x, y: mt * p0.y + s * p1.y } }
        Seg::Quad(p0, p1, p2) => {
            let mt = 1.0 - s;
            P { x: mt * mt * p0.x + 2.0 * mt * s * p1.x + s * s * p2.x, y: mt * mt * p0.y + 2.0 * mt * s * p1.y + s * s * p2.y }
        }
        Seg::Cubic(p0, p1, p2, p3) => {
            let mt = 1.0 - s; let mt2 = mt * mt; let t2 = s * s;
            P {
                x: mt2 * mt * p0.x + 3.0 * mt2 * s * p1.x + 3.0 * mt * t2 * p2.x + t2 * s * p3.x,
                y: mt2 * mt * p0.y + 3.0 * mt2 * s * p1.y + 3.0 * mt * t2 * p2.y + t2 * s * p3.y,
            }
        }
    }
}

fn eval_tangent(seg: &Seg, s: f64) -> (f64, f64) {
    match *seg {
        Seg::Line(p0, p1) => (p1.x - p0.x, p1.y - p0.y),
        Seg::Quad(p0, p1, p2) => {
            let ms = 1.0 - s;
            (2.0 * ms * (p1.x - p0.x) + 2.0 * s * (p2.x - p1.x), 2.0 * ms * (p1.y - p0.y) + 2.0 * s * (p2.y - p1.y))
        }
        Seg::Cubic(p0, p1, p2, p3) => {
            let ms = 1.0 - s; let ms2 = ms * ms; let s2 = s * s;
            (3.0 * ms2 * (p1.x - p0.x) + 6.0 * ms * s * (p2.x - p1.x) + 3.0 * s2 * (p3.x - p2.x),
             3.0 * ms2 * (p1.y - p0.y) + 6.0 * ms * s * (p2.y - p1.y) + 3.0 * s2 * (p3.y - p2.y))
        }
    }
}

/// raySegmentIntersections: the ray parameters t >= 0 where the ray crosses the segment (as max(0, t)).
fn ray_segment_intersections(ox: f64, oy: f64, dirx: f64, diry: f64, seg: &Seg, out: &mut impl FnMut(f64)) {
    let nx = -diry;
    let ny = dirx;
    let s_roots = solve_for_s_roots(nx, ny, ox, oy, seg);
    let dir_len2 = dirx * dirx + diry * diry;
    for &s in s_roots.as_slice() {
        let point = eval_point(seg, s);
        let dx = point.x - ox;
        let dy = point.y - oy;
        let t = (dx * dirx + dy * diry) / dir_len2;
        if t >= -EPSILON { out(m::max(0.0, t)); }
    }
}

fn ray_hits_bbox(ox: f64, oy: f64, dx: f64, dy: f64, bmin_x: f64, bmin_y: f64, bmax_x: f64, bmax_y: f64, max_t: f64) -> bool {
    let mut tmin = 0.0f64;
    let mut tmax = max_t;
    if dx.abs() > EPSILON {
        let inv = 1.0 / dx;
        let mut t1 = (bmin_x - ox) * inv;
        let mut t2 = (bmax_x - ox) * inv;
        if t1 > t2 { std::mem::swap(&mut t1, &mut t2); }
        if t1 > tmin { tmin = t1; }
        if t2 < tmax { tmax = t2; }
        if tmin > tmax { return false; }
    } else if ox < bmin_x || ox > bmax_x { return false; }
    if dy.abs() > EPSILON {
        let inv = 1.0 / dy;
        let mut t1 = (bmin_y - oy) * inv;
        let mut t2 = (bmax_y - oy) * inv;
        if t1 > t2 { std::mem::swap(&mut t1, &mut t2); }
        if t1 > tmin { tmin = t1; }
        if t2 < tmax { tmax = t2; }
        if tmin > tmax { return false; }
    } else if oy < bmin_y || oy > bmax_y { return false; }
    true
}

struct SegBoxes { min_x: Vec<f64>, min_y: Vec<f64>, max_x: Vec<f64>, max_y: Vec<f64> }

fn ping(hx: f64, hy: f64, dx: f64, dy: f64, segs: &[Seg], b: &SegBoxes) -> Option<f64> {
    let ox = hx + dx * PING_EPSILON;
    let oy = hy + dy * PING_EPSILON;
    let mut best_t = f64::INFINITY;
    for (si, seg) in segs.iter().enumerate() {
        if !ray_hits_bbox(ox, oy, dx, dy, b.min_x[si], b.min_y[si], b.max_x[si], b.max_y[si], best_t) { continue; }
        ray_segment_intersections(ox, oy, dx, dy, seg, &mut |t| { if t > PING_EPSILON && t < best_t { best_t = t; } });
    }
    if best_t == f64::INFINITY { None } else { Some(best_t) }
}

/// The outline as short straight chords (at most CHORD grid units), for winding numbers. Straight-line crossings with
/// the half-open rule cannot be lost or doubled the way curve roots can be at vertices, extremes and shared edges.
const CHORD: f64 = 0.25;
fn flatten(segs: &[Seg]) -> Vec<[f64; 4]> {
    let mut out = Vec::new();
    for seg in segs {
        let (n, len) = match *seg {
            Seg::Line(..) => (1, 0.0),
            Seg::Quad(a, b, c) => (0, (b.x - a.x).hypot(b.y - a.y) + (c.x - b.x).hypot(c.y - b.y)),
            Seg::Cubic(a, b, c, d) => (0, (b.x - a.x).hypot(b.y - a.y) + (c.x - b.x).hypot(c.y - b.y) + (d.x - c.x).hypot(d.y - c.y)),
        };
        let n = if n == 1 { 1 } else { ((len / CHORD).ceil() as usize).clamp(2, 256) };
        let mut a = eval_point(seg, 0.0);
        for k in 1..=n {
            let b = eval_point(seg, k as f64 / n as f64);
            out.push([a.x, a.y, b.x, b.y]);
            a = b;
        }
    }
    out
}

/// The winding number at distance t along the line (crossings sorted by distance).
fn winding_at(crossings: &[(f64, i32)], t: f64) -> i32 {
    crossings.iter().take_while(|c| c.0 < t).map(|c| c.1).sum()
}

/// The contour structure: each segment's neighbours, and the parameter step that moves STEP grid units along it.
/// Segments come in path order; a contour closes where a segment returns to the contour's own first point (so two
/// contours that merely share a point stay separate), and otherwise continues while each segment starts where the
/// last ended.
const STEP: f64 = 1e-4;
struct Contours { prev: Vec<usize>, next: Vec<usize>, step: Vec<f64> }

fn contours(segs: &[Seg]) -> Contours {
    let n = segs.len();
    let (mut prev, mut next) = (vec![0; n], vec![0; n]);
    let (mut start, mut first) = (0, segs.first().map(|s| s.p0()).unwrap_or(P { x: 0.0, y: 0.0 }));
    for i in 0..n {
        let e = end_point(&segs[i]);
        let closes = e.x == first.x && e.y == first.y;
        let continues = i + 1 < n && { let p = segs[i + 1].p0(); p.x == e.x && p.y == e.y };
        if closes || !continues {
            next[i] = start; prev[start] = i; start = i + 1;
            if start < n { first = segs[start].p0(); }
        } else { next[i] = i + 1; prev[i + 1] = i; }
    }
    let step = segs.iter().map(|seg| {
        let pts: Vec<P> = match *seg { Seg::Line(a, b) => vec![a, b], Seg::Quad(a, b, c) => vec![a, b, c], Seg::Cubic(a, b, c, d) => vec![a, b, c, d] };
        let len: f64 = pts.windows(2).map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y)).sum();
        if len > 0.0 { (STEP / len).clamp(1e-12, 0.25) } else { 0.25 }
    }).collect();
    Contours { prev, next, step }
}

fn end_point(seg: &Seg) -> P { match *seg { Seg::Line(_, b) | Seg::Quad(_, _, b) | Seg::Cubic(_, _, _, b) => b } }

/// Whether an exact hit is a crossing, which way, and its label. The side of the line the outline is on STEP before and
/// after the hit: on the hit's own segment, or at a vertex on the neighbouring segments, walking past any run of the
/// contour that lies along the line (as far as the whole contour). Direction +1 from the negative to the positive side
/// of the line's normal, -1 the other way, 0 where the outline only touches the line (a graze). A crossing is labelled
/// by the segments that gave its two sides, so a vertex reported by both of its segments, or both ends of a run along
/// the line, is one crossing.
const ON_LINE: f64 = 1e-11;
#[derive(Clone, Copy, PartialEq)]
enum Event { Interior(usize, u64), Vertex(usize, usize) }

fn crossing(segs: &[Seg], c: &Contours, nx: f64, ny: f64, ox: f64, oy: f64, si: usize, s: f64) -> (i32, Event) {
    let side = |p: P| nx * (p.x - ox) + ny * (p.y - oy);
    let sign = |v: f64| if v > ON_LINE { 1 } else if v < -ON_LINE { -1 } else { 0 };
    let n = segs.len();
    let forward = |mut k: usize| -> (i32, usize) {
        for _ in 0..n { let v = sign(side(eval_point(&segs[k], c.step[k]))); if v != 0 { return (v, k); } k = c.next[k]; }
        (0, k)
    };
    let backward = |mut k: usize| -> (i32, usize) {
        for _ in 0..n { let v = sign(side(eval_point(&segs[k], 1.0 - c.step[k]))); if v != 0 { return (v, k); } k = c.prev[k]; }
        (0, k)
    };
    let dir = |b: i32, a: i32| if b < 0 && a > 0 { 1 } else if b > 0 && a < 0 { -1 } else { 0 };
    let ds = c.step[si];
    if s > ds && s < 1.0 - ds {
        let (b, a) = (sign(side(eval_point(&segs[si], s - ds))), sign(side(eval_point(&segs[si], s + ds))));
        return (dir(b, a), Event::Interior(si, s.to_bits()));
    }
    let ((b, bk), (a, ak)) = if s >= 1.0 - ds { (backward(si), forward(c.next[si])) } else { (backward(c.prev[si]), forward(si)) };
    (dir(b, a), Event::Vertex(bk, ak))
}

/// Of exact hits along a line (sorted by distance), the crossings where the line enters or leaves the filled shape (the
/// union of the contours under the nonzero rule), from the winding number summed along the line from its start: grazes
/// dropped, each crossing once, coincident crossings (a stroke drawn twice, pieces that abut edge to edge) taken
/// together. Also: whether the winding returned to zero at the end (if not, a root was lost or doubled: the caller
/// falls back to chords), whether it reached 2 (overlap), and whether coincident crossings cancelled (abutting pieces).
struct Winding { kept: Vec<(f64, f64, usize)>, closed: bool, overlap: bool, abut: bool }
fn exact_winding(hits: &[(f64, f64, usize)], segs: &[Seg], c: &Contours, nx: f64, ny: f64, ox: f64, oy: f64) -> Winding {
    let mut seen: Vec<Event> = Vec::new();
    let mut cr: Vec<(f64, f64, usize, i32)> = Vec::new();
    for &(t, s, si) in hits {
        let (d, ev) = crossing(segs, c, nx, ny, ox, oy, si, s);
        if d == 0 || seen.contains(&ev) { continue; }
        seen.push(ev);
        cr.push((t, s, si, d));
    }
    let (mut w, mut i) = (0, 0);
    let mut out = Winding { kept: Vec::new(), closed: true, overlap: false, abut: false };
    while i < cr.len() {
        let (t0, mut j, mut sum, mut mag) = (cr[i].0, i, 0, 0);
        while j < cr.len() && cr[j].0 - t0 <= 1e-7 { sum += cr[j].3; mag += 1; j += 1; }
        if mag > 1 && sum.abs() < mag { out.abut = true; }
        let before = w;
        w += sum;
        if w.abs() >= 2 { out.overlap = true; }
        if (before == 0) != (w == 0) { out.kept.push((cr[i].0, cr[i].1, cr[i].2)); }
        i = j;
    }
    out.closed = w == 0;
    out
}

/// The ping for a glyph with no overlaps or abutting pieces: the nearest crossing (not graze) beyond PING_EPSILON.
/// With the winding only ever 0 or +-1, every crossing is on the filled shape's boundary, so the minimum over crossings
/// is found as before, pruning segments whose box lies beyond the best so far; a graze does not lower it.
fn ping_crossing(hx: f64, hy: f64, dx: f64, dy: f64, segs: &[Seg], b: &SegBoxes, c: &Contours) -> Option<f64> {
    let ox = hx + dx * PING_EPSILON;
    let oy = hy + dy * PING_EPSILON;
    let (nx, ny) = (-dy, dx);
    let dir_len2 = dx * dx + dy * dy;
    let mut best_t = f64::INFINITY;
    for (si, seg) in segs.iter().enumerate() {
        if !ray_hits_bbox(ox, oy, dx, dy, b.min_x[si], b.min_y[si], b.max_x[si], b.max_y[si], best_t) { continue; }
        for &s in solve_for_s_roots(nx, ny, ox, oy, seg).as_slice() {
            let p = eval_point(seg, s);
            let t = m::max(0.0, ((p.x - ox) * dx + (p.y - oy) * dy) / dir_len2);
            if t > PING_EPSILON && t < best_t && crossing(segs, c, nx, ny, ox, oy, si, s).0 != 0 { best_t = t; }
        }
    }
    if best_t == f64::INFINITY { None } else { Some(best_t) }
}

/// A uniform grid over a glyph (about 24 cells across) listing the chords and segments near each cell, so a line only
/// examines what lies along it. Every chord a line crosses has its crossing point inside a cell the line passes
/// through, and that cell lists the chord (cells take chords by bounding box, slightly enlarged), so the results are
/// the same as testing everything.
pub struct Grid { x0: f64, y0: f64, cell: f64, nx: usize, ny: usize, chords: Vec<Vec<u32>>, segs: Vec<Vec<u32>> }
pub struct Scratch { stamp_c: Vec<u32>, stamp_s: Vec<u32>, tick: u32 }

impl Grid {
    fn new(lines: &[[f64; 4]], boxes: &SegBoxes) -> Grid {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for l in lines { x0 = x0.min(l[0]).min(l[2]); x1 = x1.max(l[0]).max(l[2]); y0 = y0.min(l[1]).min(l[3]); y1 = y1.max(l[1]).max(l[3]); }
        for i in 0..boxes.min_x.len() { x0 = x0.min(boxes.min_x[i]); x1 = x1.max(boxes.max_x[i]); y0 = y0.min(boxes.min_y[i]); y1 = y1.max(boxes.max_y[i]); }
        if !x0.is_finite() { return Grid { x0: 0.0, y0: 0.0, cell: 1.0, nx: 1, ny: 1, chords: vec![Vec::new()], segs: vec![Vec::new()] }; }
        let (x0, y0) = (x0 - 1.0, y0 - 1.0);
        let cell = ((x1 + 1.0 - x0).max(y1 + 1.0 - y0) / 24.0).max(1e-6);
        let (nx, ny) = ((((x1 + 1.0 - x0) / cell).ceil() as usize).max(1), (((y1 + 1.0 - y0) / cell).ceil() as usize).max(1));
        let mut g = Grid { x0, y0, cell, nx, ny, chords: vec![Vec::new(); nx * ny], segs: vec![Vec::new(); nx * ny] };
        const PAD: f64 = 1e-6;
        let range = |g: &Grid, a: f64, b: f64, lo: f64, n: usize| -> (usize, usize) {
            let i0 = (((a.min(b) - PAD - lo) / g.cell).floor().max(0.0) as usize).min(n - 1);
            let i1 = (((a.max(b) + PAD - lo) / g.cell).floor().max(0.0) as usize).min(n - 1);
            (i0, i1)
        };
        for (k, l) in lines.iter().enumerate() {
            let (ix0, ix1) = range(&g, l[0], l[2], g.x0, g.nx);
            let (iy0, iy1) = range(&g, l[1], l[3], g.y0, g.ny);
            for iy in iy0..=iy1 { for ix in ix0..=ix1 { g.chords[iy * g.nx + ix].push(k as u32); } }
        }
        for k in 0..boxes.min_x.len() {
            let (ix0, ix1) = range(&g, boxes.min_x[k], boxes.max_x[k], g.x0, g.nx);
            let (iy0, iy1) = range(&g, boxes.min_y[k], boxes.max_y[k], g.y0, g.ny);
            for iy in iy0..=iy1 { for ix in ix0..=ix1 { g.segs[iy * g.nx + ix].push(k as u32); } }
        }
        g
    }

    /// The cells the infinite line through (ox, oy) along (dx, dy) passes through, with each of their neighbours (so a
    /// line through a cell corner cannot slip between cells).
    fn cells(&self, ox: f64, oy: f64, dx: f64, dy: f64, mut f: impl FnMut(usize)) {
        if brute() { for c in 0..self.nx * self.ny { f(c); } return; }
        let (w, h) = (self.nx as f64 * self.cell, self.ny as f64 * self.cell);
        let (mut t0, mut t1) = (f64::NEG_INFINITY, f64::INFINITY);
        for (o, d, lo, size) in [(ox, dx, self.x0, w), (oy, dy, self.y0, h)] {
            if d.abs() < 1e-15 { if o < lo || o > lo + size { return; } continue; }
            let (a, b) = ((lo - o) / d, (lo + size - o) / d);
            t0 = t0.max(a.min(b)); t1 = t1.min(a.max(b));
        }
        if t0 > t1 { return; }
        // Amanatides-Woo: each cell the line passes through, once. A line exactly through a cell corner steps
        // diagonally, but chords are filed with a margin (PAD) in every cell their box touches, so a crossing at a
        // corner is in the cell the walk enters.
        let (px, py) = (ox + dx * t0, oy + dy * t0);
        let mut ix = (((px - self.x0) / self.cell).floor().max(0.0) as usize).min(self.nx - 1) as isize;
        let mut iy = (((py - self.y0) / self.cell).floor().max(0.0) as usize).min(self.ny - 1) as isize;
        let (sx, sy) = (if dx > 0.0 { 1 } else { -1 }, if dy > 0.0 { 1 } else { -1 });
        let next = |i: isize, s: isize, lo: f64, o: f64, d: f64| -> f64 {
            if d.abs() < 1e-15 { return f64::INFINITY; }
            let edge = lo + (i + if s > 0 { 1 } else { 0 }) as f64 * self.cell;
            (edge - o) / d
        };
        let (mut tx, mut ty) = (next(ix, sx, self.x0, ox, dx), next(iy, sy, self.y0, oy, dy));
        let (ddx, ddy) = (if dx.abs() < 1e-15 { f64::INFINITY } else { self.cell / dx.abs() }, if dy.abs() < 1e-15 { f64::INFINITY } else { self.cell / dy.abs() });
        loop {
            f(iy as usize * self.nx + ix as usize);
            if tx < ty {
                if tx > t1 { break; }
                ix += sx; tx += ddx;
                if ix < 0 || ix >= self.nx as isize { break; }
            } else {
                if ty > t1 { break; }
                iy += sy; ty += ddy;
                if iy < 0 || iy >= self.ny as isize { break; }
            }
        }
    }
}

fn legacy() -> bool { static L: std::sync::OnceLock<bool> = std::sync::OnceLock::new(); *L.get_or_init(|| std::env::var("CV_LEGACY").is_ok()) }

/// CV_BRUTE=1 skips the grid (every chord and segment tested), to check that the grid changes nothing.
fn brute() -> bool { static B: std::sync::OnceLock<bool> = std::sync::OnceLock::new(); *B.get_or_init(|| std::env::var("CV_BRUTE").is_ok()) }

impl Scratch {
    fn new(n_chords: usize, n_segs: usize) -> Scratch { Scratch { stamp_c: vec![0; n_chords], stamp_s: vec![0; n_segs], tick: 0 } }
}

/// chord_crossings over the chords the grid lists along the line.
fn chord_crossings_grid(lines: &[[f64; 4]], grid: &Grid, sc: &mut Scratch, ox: f64, oy: f64, dx: f64, dy: f64, out: &mut Vec<(f64, i32)>) {
    let (nx, ny) = (-dy, dx);
    out.clear();
    sc.tick += 1;
    let tick = sc.tick;
    let (stamp, chords) = (&mut sc.stamp_c, &grid.chords);
    grid.cells(ox, oy, dx, dy, |c| {
        for &k in &chords[c] {
            let k = k as usize;
            if stamp[k] == tick { continue; }
            stamp[k] = tick;
            let l = &lines[k];
            let p0 = nx * (l[0] - ox) + ny * (l[1] - oy);
            let p1 = nx * (l[2] - ox) + ny * (l[3] - oy);
            if (p0 < 0.0) != (p1 < 0.0) {
                let f = p0 / (p0 - p1);
                let (x, y) = (l[0] + f * (l[2] - l[0]), l[1] + f * (l[3] - l[1]));
                out.push(((x - ox) * dx + (y - oy) * dy, if p0 < 0.0 { 1 } else { -1 }));
            }
        }
    });
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
}


/// For a glyph whose contours overlap: of its crossings along a line (sorted by distance, already confirmed as
/// crossings by the local test, so no grazes and each once), the ones on the filled shape's boundary: the flattened
/// winding number just before and just after the crossing (VISIBLE_STEP along the line either side) differ in being
/// zero. Where the line meets the curve at a very shallow angle, the chord and the curve can sit more than VISIBLE_STEP
/// apart along the line, so the test can misjudge there; it only ever decides between boundary and internal edges.
/// (Probing across the curve instead failed the Noto check: Ꙥ 1.57 from its static twin.)
const VISIBLE_STEP: f64 = 0.05;
fn classify(hits: &[(f64, f64, usize)], crossings: &[(f64, i32)]) -> Vec<(f64, f64, usize)> {
    let mut out: Vec<(f64, f64, usize)> = Vec::new();
    for &h in hits {
        if let Some(last) = out.last() { if h.0 - last.0 <= 1e-7 { continue; } }
        let (before, after) = (winding_at(crossings, h.0 - VISIBLE_STEP), winding_at(crossings, h.0 + VISIBLE_STEP));
        if (before == 0) != (after == 0) { out.push(h); }
    }
    out
}

/// The ping for a glyph with overlapping or abutting pieces: the nearest boundary crossing of the filled shape beyond
/// PING_EPSILON, from the exact winding along the whole line (crossings behind the origin set the winding at the
/// origin). If the winding does not return to zero (a root lost or doubled), the chords decide instead.
fn ping_union(hx: f64, hy: f64, dx: f64, dy: f64, segs: &[Seg], lines: &[[f64; 4]], grid: &Grid, sc: &mut Scratch, c: &Contours, hits: &mut Vec<(f64, f64, usize)>, cross: &mut Vec<(f64, i32)>) -> Option<f64> {
    let ox = hx + dx * PING_EPSILON;
    let oy = hy + dy * PING_EPSILON;
    let (nx, ny) = (-dy, dx);
    let dir_len2 = dx * dx + dy * dy;
    hits.clear();
    sc.tick += 1;
    let tick = sc.tick;
    {
        let (stamp, cells) = (&mut sc.stamp_s, &grid.segs);
        grid.cells(ox, oy, dx, dy, |cell| {
            for &k in &cells[cell] {
                let si = k as usize;
                if stamp[si] == tick { continue; }
                stamp[si] = tick;
                let seg = &segs[si];
                for &s in solve_for_s_roots(nx, ny, ox, oy, seg).as_slice() {
                    let p = eval_point(seg, s);
                    hits.push((((p.x - ox) * dx + (p.y - oy) * dy) / dir_len2, s, si));
                }
            }
        });
    }
    hits.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.2.cmp(&b.2)));
    let w = exact_winding(hits, segs, c, nx, ny, ox, oy);
    if w.closed { return w.kept.iter().map(|h| h.0).find(|&t| t > PING_EPSILON); }
    let ahead: Vec<(f64, f64, usize)> = hits.iter().copied().filter(|h| h.0 > PING_EPSILON && crossing(segs, c, nx, ny, ox, oy, h.2, h.1).0 != 0).collect();
    chord_crossings_grid(lines, grid, sc, ox, oy, dx, dy, cross);
    classify(&ahead, cross).first().map(|h| h.0)
}

fn bbox_of(segs: &[Seg]) -> Frame {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut update = |p: P| {
        if p.x < min_x { min_x = p.x; }
        if p.y < min_y { min_y = p.y; }
        if p.x > max_x { max_x = p.x; }
        if p.y > max_y { max_y = p.y; }
    };
    for seg in segs {
        match *seg {
            Seg::Line(a, b) => { update(a); update(b); }
            Seg::Quad(a, b, c) => { update(a); update(b); update(c); }
            Seg::Cubic(a, b, c, d) => { update(a); update(b); update(c); update(d); }
        }
    }
    if !min_x.is_finite() { return Frame { min_x: 0.0, min_y: 0.0, max_x: 0.0, max_y: 0.0 }; }
    Frame { min_x, min_y, max_x, max_y }
}

#[inline] fn q255(v: f64) -> u8 { m::round(m::max(0.0, m::min(1.0, v)) * 255.0) as u8 }
#[inline] fn q254(v: f64) -> u8 { m::round(m::max(0.0, m::min(1.0, v)) * 254.0) as u8 }

/// computeEnrichedSignature. `dirs` holds (Math.cos(angle), Math.sin(angle)) per angle, computed by the caller in
/// JavaScript, so the ray directions are Node's own.
pub fn signature(segs: &[Seg], dirs: &[(f64, f64)], rays_per_angle: usize, grid_size: f64, frame: Option<&Frame>) -> Signature {
    let own;
    let bbox = match frame { Some(f) => f, None => { own = bbox_of(segs); &own } };
    let half_pi = std::f64::consts::PI / 2.0;
    let n = segs.len();
    let mut sb = SegBoxes { min_x: vec![0.0; n], min_y: vec![0.0; n], max_x: vec![0.0; n], max_y: vec![0.0; n] };
    for (si, seg) in segs.iter().enumerate() {
        let p0 = seg.p0();
        let (mut sx_min, mut sy_min, mut sx_max, mut sy_max) = (p0.x, p0.y, p0.x, p0.y);
        let mut upd = |p: P| {
            if p.x < sx_min { sx_min = p.x; } if p.y < sy_min { sy_min = p.y; }
            if p.x > sx_max { sx_max = p.x; } if p.y > sy_max { sy_max = p.y; }
        };
        match *seg { Seg::Line(_, b) => upd(b), Seg::Quad(_, b, c) => { upd(b); upd(c); } Seg::Cubic(_, b, c, d) => { upd(b); upd(c); upd(d); } }
        sb.min_x[si] = sx_min; sb.min_y[si] = sy_min; sb.max_x[si] = sx_max; sb.max_y[si] = sy_max;
    }
    // First pass: every ray's hits, sorted by distance as the TypeScript sorts them (stable insertion sort), and, for the
    // union measurement, the ones where the ray enters or leaves the filled shape (exact_winding). CV_LEGACY=1 keeps
    // every hit, as the TypeScript does.
    let union = !legacy();
    let lines = flatten(segs);
    let grid = Grid::new(&lines, &sb);
    let contours = contours(segs);
    let mut scratch = Scratch::new(lines.len(), segs.len());
    let mut cross: Vec<(f64, i32)> = Vec::new();
    let (mut overlap, mut abut, mut unclosed) = (false, false, 0usize);
    let mut rays: Vec<(f64, f64, f64, Vec<(f64, f64, usize)>)> = Vec::with_capacity(dirs.len() * rays_per_angle);
    let (cx0, cy0, cx1, cy1, cx2, cy2, cx3, cy3) = (bbox.min_x, bbox.min_y, bbox.max_x, bbox.min_y, bbox.min_x, bbox.max_y, bbox.max_x, bbox.max_y);
    for &(dx, dy) in dirs {
        let nx = -dy;
        let ny = dx;
        let (mut min_proj, mut max_proj, mut min_dir, mut max_dir) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for (cx, cy) in [(cx0, cy0), (cx1, cy1), (cx2, cy2), (cx3, cy3)] {
            let pn = nx * cx + ny * cy;
            let pd = dx * cx + dy * cy;
            if pn < min_proj { min_proj = pn; } if pn > max_proj { max_proj = pn; }
            if pd < min_dir { min_dir = pd; } if pd > max_dir { max_dir = pd; }
        }
        let margin = (max_proj - min_proj) * 0.05;
        let range_start = min_proj - margin;
        let range_end = max_proj + margin;
        let step = if rays_per_angle > 1 { (range_end - range_start) / (rays_per_angle as f64 - 1.0) } else { 0.0 };
        let dir_span = max_dir - min_dir;
        for r in 0..rays_per_angle {
            let offset = if rays_per_angle > 1 { range_start + r as f64 * step } else { (range_start + range_end) / 2.0 };
            let origin_x = nx * offset + dx * (min_dir - 1.0);
            let origin_y = ny * offset + dy * (min_dir - 1.0);
            let mut raw: Vec<(f64, f64, usize)> = Vec::new();
            for (si, seg) in segs.iter().enumerate() {
                let s_roots = solve_for_s_roots(nx, ny, origin_x, origin_y, seg);
                for &s in s_roots.as_slice() {
                    let pt = eval_point(seg, s);
                    let t = (pt.x - origin_x) * dx + (pt.y - origin_y) * dy;
                    if t >= -EPSILON { raw.push((m::max(0.0, t), s, si)); }
                }
            }
            // insertionSortParallel: stable, by t
            for i in 1..raw.len() {
                let key = raw[i];
                let mut j = i as isize - 1;
                while j >= 0 && raw[j as usize].0 > key.0 { raw[(j + 1) as usize] = raw[j as usize]; j -= 1; }
                raw[(j + 1) as usize] = key;
            }
            let kept = if union {
                let w = exact_winding(&raw, segs, &contours, nx, ny, origin_x, origin_y);
                if let Ok(want) = std::env::var("CV_DEBUG_RAY") {
                    if want == format!("{}", rays.len()) {
                        eprintln!("ray {} dir ({:.4},{:.4}) closed {} kept {:?}", rays.len(), dx, dy, w.closed, w.kept.iter().map(|h| format!("{:.4}", h.0)).collect::<Vec<_>>());
                        for &(t, s, si) in &raw { let (d, ev) = crossing(segs, &contours, nx, ny, origin_x, origin_y, si, s);
                            eprintln!("  hit t {:.6} seg {} s {:.6} dir {} ev {}", t, si, s, d, match ev { Event::Interior(a, _) => format!("I{}", a), Event::Vertex(a, b) => format!("V{}-{}", a, b) }); }
                    }
                }
                overlap |= w.overlap; abut |= w.abut;
                if w.closed { w.kept } else {
                    // A root lost or doubled on this ray: the chords decide which crossings are on the boundary
                    unclosed += 1;
                    let crossings: Vec<(f64, f64, usize)> = raw.iter().copied().filter(|h| crossing(segs, &contours, nx, ny, origin_x, origin_y, h.2, h.1).0 != 0).collect();
                    chord_crossings_grid(&lines, &grid, &mut scratch, origin_x, origin_y, dx, dy, &mut cross);
                    classify(&crossings, &cross)
                }
            } else { raw };
            rays.push((dx, dy, dir_span, kept));
        }
    }
    if unclosed > 0 && std::env::var("CV_DEBUG_WINDING").is_ok() { eprintln!("{} rays did not close", unclosed); }
    // Pings: glyphs with overlapping or abutting pieces (or a ray that did not close) need the winding along the whole
    // ping line; for the rest, the nearest crossing is on the boundary
    let complex = overlap || abut || unclosed > 0;
    let mut sig = Signature { counts: Vec::with_capacity(rays.len()), positions: Vec::new(), angles: Vec::new(), ping_dist: Vec::new(), ping_max: Vec::new(), overlapping: false };
    let mut line_hits: Vec<(f64, f64, usize)> = Vec::new();
    let mut line_cross: Vec<(f64, i32)> = Vec::new();
    for (dx, dy, dir_span, kept) in rays.iter() {
        let (dx, dy, dir_span) = (*dx, *dy, *dir_span);
        let capped = kept.len().min(10);
        sig.counts.push(capped.min(255) as u8);
        for &(hit_t, hit_s, si) in &kept[..capped] {
            let seg = &segs[si];
            let norm_pos = if dir_span > 0.0 { (hit_t - 1.0) / dir_span } else { 0.0 };
            sig.positions.push(q255(norm_pos));
            let (tx, ty) = eval_tangent(seg, hit_s);
            let tangent_len = m::hypot(tx, ty);
            let crossing = if tangent_len < EPSILON { half_pi } else {
                let cos_angle = (dx * tx + dy * ty).abs() / tangent_len;
                m::acos(m::min(1.0, cos_angle))
            };
            sig.angles.push(q255(crossing / half_pi));
            if tangent_len < EPSILON { sig.ping_dist.push(0); sig.ping_max.push(0); continue; }
            let pnx = -ty / tangent_len;
            let pny = tx / tangent_len;
            let hp = eval_point(seg, hit_s);
            let (d1, d2) = if union && complex {
                (ping_union(hp.x, hp.y, pnx, pny, segs, &lines, &grid, &mut scratch, &contours, &mut line_hits, &mut line_cross),
                 ping_union(hp.x, hp.y, -pnx, -pny, segs, &lines, &grid, &mut scratch, &contours, &mut line_hits, &mut line_cross))
            } else if union {
                (ping_crossing(hp.x, hp.y, pnx, pny, segs, &sb, &contours), ping_crossing(hp.x, hp.y, -pnx, -pny, segs, &sb, &contours))
            } else {
                (ping(hp.x, hp.y, pnx, pny, segs, &sb), ping(hp.x, hp.y, -pnx, -pny, segs, &sb))
            };
            let v1 = d1.filter(|d| *d > 0.0 && d.is_finite());
            let v2 = d2.filter(|d| *d > 0.0 && d.is_finite());
            match (v1, v2) {
                (Some(a), Some(b)) => {
                    let (min_d, max_d) = (m::min(a, b), m::max(a, b));
                    sig.ping_dist.push(q254(min_d / grid_size));
                    sig.ping_max.push(q254(max_d / grid_size));
                }
                (Some(a), None) | (None, Some(a)) => { sig.ping_dist.push(q254(a / grid_size)); sig.ping_max.push(255); }
                (None, None) => { sig.ping_dist.push(255); sig.ping_max.push(255); }
            }
        }
    }
    sig.overlapping = overlap || abut;
    sig
}
