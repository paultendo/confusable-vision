//! cv-pairs: every pair of glyphs in one font, compared with release 2's measurement.
//!
//! Input: a signature file written by scripts/score-all.ts (box, advance-centred em and ink-centred em signatures per
//! glyph). A pair is alike when its em distance (the lower of the two centrings) is under EM_ALIKE and its box distance
//! is under ALIKE, exactly as score-exhaustive.ts decides.
//!
//! compare_geometric is a line-for-line port of compareGeometric (src/signature-bank.ts), in f64 with the same order of
//! operations, so distances match the TypeScript exactly. Before it runs, a bound built from the hit counts alone rules
//! pairs out: every term compareGeometric adds beyond |countA - countB| is non-negative, so the count-only score can
//! never exceed the true distance. A pair the bound rules out cannot be alike; the bound only saves time.
//!
//! Input is either signatures (CVS1, computed by the TypeScript) or outlines (CVG1: segments already normalised by the
//! TypeScript for each of the three frames), from which raycast.rs computes the signatures, byte-identical to
//! computeEnrichedSignature, on every core.
//!
//! Input CVG2 holds several fonts (the faces of one font file) with each distinct outline once; each is signed once.
//!
//! Usage: cv-pairs <signatures.bin | outlines.bin> [--sample N] [--dump-sigs out.bin] [--limit N] [--sigs-only]
//!   --limit: only the first N glyphs; --sigs-only: stop after the signatures (with --dump-sigs, for timing and checks)
//!
//! Measured and left out (26 Sep 2026, 1,500 Han glyphs, one thread, interleaved runs): skipping segments every control
//! point of which lies 1 grid unit to one side of the ray (provably rootless for lines and quadratics) avoided 41% of
//! main-ray solves but ran 3% slower; testing all ping boxes in one branch-free pass ran 20% slower. Both gave
//! byte-identical signatures. The root solves are cheap next to the projections either way.
//!   --sample: N pairs' exact distances at full precision, for checking against the TypeScript
//!   --dump-sigs: write the computed signatures as CVS1, for checking against the TypeScript
//! Output (stdout): one line per alike pair, "cpA cpB box em" (hex code points); for CVG2/3, "font cpA cpB box em" with
//! the font's index in the file. With --cross refs.bin (CVG3), also "X font x t ref distance" for each character x of
//! a text font that passes the cross-font test against ASCII target t in reference font ref (score-cross-font.ts), and
//! "O font cp" for each glyph whose contours overlap (measured on their union).

mod jsmath;
mod raycast;

use rayon::prelude::*;
use std::io::{Read, Write};

const NUM_ANGLES: usize = 36;
const RAYS: usize = 50;
const N_RAYS: usize = NUM_ANGLES * RAYS;
const GEOMETRY_WEIGHT: f64 = 3.0;
const ALIKE: f64 = 0.5;
const EM_ALIKE: f64 = 0.2;
// Prune only when the bound clears the threshold by more than rounding could account for
const EPS: f64 = 1e-9;

struct Sig {
    counts: Vec<u8>,
    positions: Vec<u8>,
    angles: Vec<u8>,
    ping_dist: Vec<u8>,
    ping_max: Vec<u8>,
}

struct Glyph {
    cp: u32,
    sigs: [Sig; 3], // box, em (advance), em (ink)
    overlapping: bool,
}

fn read_u32(buf: &[u8], at: &mut usize) -> u32 {
    let v = u32::from_le_bytes(buf[*at..*at + 4].try_into().unwrap());
    *at += 4;
    v
}

fn read_f64(buf: &[u8], at: &mut usize) -> f64 {
    let v = f64::from_le_bytes(buf[*at..*at + 8].try_into().unwrap());
    *at += 8;
    v
}

type Outline = (Option<raycast::Frame>, Vec<raycast::Seg>);

/// One outline: u8 has-frame [4 x f64 frame], u32 segments, per segment u8 kind (0 line, 1 quadratic, 2 cubic) and
/// its points as f64 pairs.
fn read_outline(buf: &[u8], at: &mut usize) -> Outline {
    let frame = if buf[*at] == 1 {
        *at += 1;
        Some(raycast::Frame { min_x: read_f64(buf, at), min_y: read_f64(buf, at), max_x: read_f64(buf, at), max_y: read_f64(buf, at) })
    } else { *at += 1; None };
    let ns = read_u32(buf, at) as usize;
    let mut segs = Vec::with_capacity(ns);
    for _ in 0..ns {
        let kind = buf[*at];
        *at += 1;
        let mut pt = || raycast::P { x: read_f64(buf, at), y: read_f64(buf, at) };
        segs.push(match kind {
            0 => raycast::Seg::Line(pt(), pt()),
            1 => raycast::Seg::Quad(pt(), pt(), pt()),
            _ => raycast::Seg::Cubic(pt(), pt(), pt(), pt()),
        });
    }
    (frame, segs)
}

/// The shared header of CVG1 and CVG2 after the counts: u32 angles, u32 rays, f64 grid, angles x (f64 cos, f64 sin).
fn read_rays(buf: &[u8], at: &mut usize) -> (Vec<(f64, f64)>, usize, f64) {
    let num_angles = read_u32(buf, at) as usize;
    let rays = read_u32(buf, at) as usize;
    let grid = read_f64(buf, at);
    assert!(num_angles == NUM_ANGLES && rays == RAYS, "signature layout differs from the comparison's");
    let dirs = (0..num_angles).map(|_| (read_f64(buf, at), read_f64(buf, at))).collect();
    (dirs, rays, grid)
}

/// Signatures on every core; each outline's three are independent. Also, per outline, whether its contours overlap (so
/// it was measured on the union: raycast::signature).
fn signatures(outlines: &[[Outline; 3]], dirs: &[(f64, f64)], rays: usize, grid: f64) -> (Vec<[Sig; 3]>, Vec<bool>) {
    outlines.par_iter().map(|o| {
        let sig = |o: &Outline| {
            let s = raycast::signature(&o.1, dirs, rays, grid, o.0.as_ref());
            (Sig { counts: s.counts, positions: s.positions, angles: s.angles, ping_dist: s.ping_dist, ping_max: s.ping_max }, s.overlapping)
        };
        let ((a, oa), (b, ob), (c, oc)) = (sig(&o[0]), sig(&o[1]), sig(&o[2]));
        ([a, b, c], oa || ob || oc)
    }).unzip()
}

/// CVG1: u32 n, the ray header, then per glyph u32 cp and its three outlines.
fn read_outlines(buf: &[u8], limit: usize) -> Vec<Glyph> {
    let mut at = 4;
    let n = (read_u32(buf, &mut at) as usize).min(limit);
    let (dirs, rays, grid) = read_rays(buf, &mut at);
    let mut cps = Vec::with_capacity(n);
    let mut outlines = Vec::with_capacity(n);
    for _ in 0..n {
        cps.push(read_u32(buf, &mut at));
        outlines.push([read_outline(buf, &mut at), read_outline(buf, &mut at), read_outline(buf, &mut at)]);
    }
    let (sigs, ov) = signatures(&outlines, &dirs, rays, grid);
    sigs.into_iter().zip(ov).zip(cps).map(|((sigs, overlapping), cp)| Glyph { cp, sigs, overlapping }).collect()
}

/// CVG2 / CVG3: several fonts (the faces of one font file), each distinct normalised outline stored once. u32 fonts,
/// u32 outlines, the ray header, the outlines (three each, as in CVG1), then per font: u32 name length, the name
/// (UTF-8), [CVG3: u8 cross-font flag], u32 glyphs, and per glyph u32 cp, u32 outline index, [CVG3: the glyph's ink box
/// in em, 4 x f64 xMin yMin xMax yMax]. Identical outlines give identical signatures (the computation is deterministic),
/// so each is computed once.
/// Per glyph: code point, outline index, ink box in em and (CVG4) advance in em (NaN before CVG4).
struct MultiFont { name: String, cross: bool, glyphs: Vec<(u32, usize, [f64; 4], f64)> }

fn read_multi(buf: &[u8]) -> (Vec<[Sig; 3]>, Vec<bool>, Vec<MultiFont>) {
    let v4 = &buf[0..4] == b"CVG4";
    let v3 = v4 || &buf[0..4] == b"CVG3";
    let mut at = 4;
    let n_fonts = read_u32(buf, &mut at) as usize;
    let n_outlines = read_u32(buf, &mut at) as usize;
    let (dirs, rays, grid) = read_rays(buf, &mut at);
    let outlines: Vec<[Outline; 3]> = (0..n_outlines)
        .map(|_| [read_outline(buf, &mut at), read_outline(buf, &mut at), read_outline(buf, &mut at)]).collect();
    let mut fonts = Vec::with_capacity(n_fonts);
    for _ in 0..n_fonts {
        let len = read_u32(buf, &mut at) as usize;
        let name = String::from_utf8(buf[at..at + len].to_vec()).unwrap();
        at += len;
        let cross = if v3 { at += 1; buf[at - 1] == 1 } else { false };
        let n = read_u32(buf, &mut at) as usize;
        let glyphs = (0..n).map(|_| {
            let cp = read_u32(buf, &mut at);
            let k = read_u32(buf, &mut at) as usize;
            let b = if v3 { [read_f64(buf, &mut at), read_f64(buf, &mut at), read_f64(buf, &mut at), read_f64(buf, &mut at)] } else { [0.0; 4] };
            let adv = if v4 { read_f64(buf, &mut at) } else { f64::NAN };
            (cp, k, b, adv)
        }).collect();
        fonts.push(MultiFont { name, cross, glyphs });
    }
    let (sigs, overlapping) = signatures(&outlines, &dirs, rays, grid);
    (sigs, overlapping, fonts)
}

/// Reference (page) fonts for the cross-font test (CVR1): the ray header, u32 fonts, then per font: u32 name length,
/// name, u32 n and n code points it draws (letters and digits), then its 62 ASCII targets, each u32 cp, u8 present,
/// and if present its ink box (4 x f64) and its box-frame outline.
/// A page font's target: its ink box in em and its signatures, box frame and (CVR3) the em frame on the advance and on
/// the ink, for comparing at the size and baseline text has.
struct Target { cp: u32, bx: [f64; 4], adv: f64, sig: Sig, em: Option<[Sig; 2]> }
struct RefFont { name: String, chars: std::collections::HashSet<u32>, targets: Vec<Option<Target>> }

/// Ids above Unicode: two-character ASCII sequences (scripts/score-all.ts SEQ_BASE). Never paired with each other,
/// never tested as a character across fonts, and a separate pool of cross-font targets.
const SEQ_BASE: u32 = 0x200000;

fn encode_sig(s: &Sig, out: &mut Vec<u8>) {
    out.extend_from_slice(&s.counts);
    out.extend_from_slice(&(s.positions.len() as u32).to_le_bytes());
    let arrays = [&s.positions, &s.angles, &s.ping_dist, &s.ping_max];
    out.push(arrays.iter().enumerate().fold(0u8, |f, (i, a)| if a.is_empty() { f } else { f | 1 << i }));
    for a in arrays { out.extend_from_slice(a); }
}

/// The reference file's identity for its caches: size, modification time and measurement mode.
fn refs_stamp(path: &str) -> u64 {
    let meta = std::fs::metadata(path).unwrap();
    let nanos = meta.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64;
    nanos ^ meta.len().rotate_left(17) ^ ((std::env::var("CV_LEGACY").is_ok() as u64) << 63)
}

/// CVR1 (62 targets per page font, box frame only), CVR2 (a target count per font: the 62, then two-character
/// sequences) or CVR3 (as CVR2, each target with its em-frame outlines too). Signatures are computed on every core and
/// cached in <file>.sigs, keyed by the file's stamp, so the ~250 cv-pairs runs of one score-all run sign them once.
fn read_refs(path: &str) -> Vec<RefFont> {
    let stamp = refs_stamp(path);
    let cache = format!("{}.sigs", path);
    if let Ok(c) = std::fs::read(&cache) {
        if c.len() >= 12 && &c[0..4] == b"CVS4" && u64::from_le_bytes(c[4..12].try_into().unwrap()) == stamp {
            let mut at = 12;
            let n = read_u32(&c, &mut at) as usize;
            return (0..n).map(|_| {
                let len = read_u32(&c, &mut at) as usize;
                let name = String::from_utf8(c[at..at + len].to_vec()).unwrap();
                at += len;
                let nc = read_u32(&c, &mut at) as usize;
                let chars = (0..nc).map(|_| read_u32(&c, &mut at)).collect();
                let nt = read_u32(&c, &mut at) as usize;
                let targets = (0..nt).map(|_| {
                    let cp = read_u32(&c, &mut at);
                    let present = c[at] == 1;
                    at += 1;
                    if !present { return None; }
                    let bx = [read_f64(&c, &mut at), read_f64(&c, &mut at), read_f64(&c, &mut at), read_f64(&c, &mut at)];
                    let adv = read_f64(&c, &mut at);
                    let sig = read_sig(&c, &mut at);
                    let has_em = c[at] == 1;
                    at += 1;
                    let em = if has_em { Some([read_sig(&c, &mut at), read_sig(&c, &mut at)]) } else { None };
                    Some(Target { cp, bx, adv, sig, em })
                }).collect();
                RefFont { name, chars, targets }
            }).collect();
        }
    }
    let buf = std::fs::read(path).unwrap();
    let version = match &buf[0..4] { b"CVR1" => 1, b"CVR2" => 2, b"CVR3" => 3, b"CVR4" => 4, _ => panic!("not a reference-font file") };
    let per = if version >= 3 { 3 } else { 1 };
    let mut at = 4;
    let (dirs, rays, grid) = read_rays(&buf, &mut at);
    let n = read_u32(&buf, &mut at) as usize;
    let mut heads = Vec::with_capacity(n);
    let mut outlines: Vec<Outline> = Vec::new();
    let mut lists: Vec<Vec<Option<(u32, [f64; 4], f64)>>> = Vec::with_capacity(n);
    for _ in 0..n {
        let len = read_u32(&buf, &mut at) as usize;
        let name = String::from_utf8(buf[at..at + len].to_vec()).unwrap();
        at += len;
        let nc = read_u32(&buf, &mut at) as usize;
        let chars: std::collections::HashSet<u32> = (0..nc).map(|_| read_u32(&buf, &mut at)).collect();
        let nt = if version >= 2 { read_u32(&buf, &mut at) as usize } else { 62 };
        let mut list = Vec::with_capacity(nt);
        for _ in 0..nt {
            let cp = read_u32(&buf, &mut at);
            let present = buf[at] == 1;
            at += 1;
            if !present { list.push(None); continue; }
            let bx = [read_f64(&buf, &mut at), read_f64(&buf, &mut at), read_f64(&buf, &mut at), read_f64(&buf, &mut at)];
            let adv = if version >= 4 { read_f64(&buf, &mut at) } else { f64::NAN };
            for _ in 0..per { outlines.push(read_outline(&buf, &mut at)); }
            list.push(Some((cp, bx, adv)));
        }
        heads.push((name, chars));
        lists.push(list);
    }
    let sigs: Vec<Sig> = outlines.par_iter().map(|o| {
        let s = raycast::signature(&o.1, &dirs, rays, grid, o.0.as_ref());
        Sig { counts: s.counts, positions: s.positions, angles: s.angles, ping_dist: s.ping_dist, ping_max: s.ping_max }
    }).collect();
    drop(outlines);
    let mut signed = sigs.into_iter();
    let refs: Vec<RefFont> = heads.into_iter().zip(lists).map(|((name, chars), list)| {
        let targets = list.into_iter().map(|t| t.map(|(cp, bx, adv)| {
            let sig = signed.next().unwrap();
            let em = if per == 3 { Some([signed.next().unwrap(), signed.next().unwrap()]) } else { None };
            Target { cp, bx, adv, sig, em }
        })).collect();
        RefFont { name, chars, targets }
    }).collect();
    let mut out = Vec::new();
    out.extend_from_slice(b"CVS4");
    out.extend_from_slice(&stamp.to_le_bytes());
    out.extend_from_slice(&(refs.len() as u32).to_le_bytes());
    for r in &refs {
        out.extend_from_slice(&(r.name.len() as u32).to_le_bytes());
        out.extend_from_slice(r.name.as_bytes());
        out.extend_from_slice(&(r.chars.len() as u32).to_le_bytes());
        for c in &r.chars { out.extend_from_slice(&c.to_le_bytes()); }
        out.extend_from_slice(&(r.targets.len() as u32).to_le_bytes());
        for t in &r.targets {
            match t {
                None => { out.extend_from_slice(&0u32.to_le_bytes()); out.push(0); }
                Some(t) => {
                    out.extend_from_slice(&t.cp.to_le_bytes());
                    out.push(1);
                    for v in t.bx { out.extend_from_slice(&v.to_le_bytes()); }
                    out.extend_from_slice(&t.adv.to_le_bytes());
                    encode_sig(&t.sig, &mut out);
                    match &t.em { None => out.push(0), Some([a, b]) => { out.push(1); encode_sig(a, &mut out); encode_sig(b, &mut out); } }
                }
            }
        }
    }
    let tmp = format!("{}.{}", cache, std::process::id());
    if std::fs::write(&tmp, &out).is_ok() { let _ = std::fs::rename(&tmp, &cache); }
    refs
}

/// The em distance as the same-font test takes it: the lower of the advance-centred and ink-centred distances.
fn em_distance(adv: &Sig, ink: &Sig, t: &[Sig; 2]) -> f64 {
    compare_geometric(adv, &t[0]).min(compare_geometric(ink, &t[1]))
}

/// A target's floors in one reference font: shape (box frame), size (ink box gap) and, with CVR3, em (the em-frame
/// distance, at the size and baseline text has).
#[derive(Clone, Copy)]
struct Floor { shape: f64, size: f64, em: f64 }
const NO_FLOOR: Floor = Floor { shape: f64::INFINITY, size: f64::INFINITY, em: f64::INFINITY };

/// Median as score-cross-font.ts computes it: sorted, the middle value or the mean of the two middle ones; infinity
/// when empty.
fn median(mut xs: Vec<f64>) -> f64 {
    if xs.is_empty() { return f64::INFINITY; }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = xs.len();
    if n % 2 == 1 { xs[(n - 1) / 2] } else { (xs[n / 2 - 1] + xs[n / 2]) / 2.0 }
}

/// boxGap (src/glyph-box.ts): the largest gap between tops, bottoms or ink widths. Boxes are [xMin, yMin, xMax, yMax].
fn box_gap(a: &[f64; 4], b: &[f64; 4]) -> f64 {
    let (top, bottom, width) = ((a[3] - b[3]).abs(), (a[1] - b[1]).abs(), ((a[2] - a[0]) - (b[2] - b[0])).abs());
    top.max(bottom).max(width)
}

/// CV_DEBUG_CROSS=<hex code point>: report that character's nearest targets in every reference font.
fn debug_cross() -> Option<u32> {
    static D: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    *D.get_or_init(|| std::env::var("CV_DEBUG_CROSS").ok().and_then(|h| u32::from_str_radix(&h, 16).ok()))
}

/// CV_CROSS_DUMP=<file>: append, for every character and reference font the cross-font test visits, its two nearest
/// targets and the box gap to the nearest (for calibrating the rule); CV_FLOOR_DUMP=<file>: write the same-letter
/// distances and box gaps each floor is the median of.
fn dump_file(var: &str, append: bool) -> Option<std::fs::File> {
    let path = std::env::var(var).ok()?;
    std::fs::OpenOptions::new().create(true).append(append).write(true).truncate(!append).open(path).ok()
}

/// Median distance of GLOBAL_CAP between the same letter in two common text fonts (docs/metric-calibration.md).
const GLOBAL_CAP: f64 = 0.98;

/// Where the floors sit in the spread of same-letter distances between the reference fonts. Release 2 took the median,
/// which by construction rejects half the real letters (another common font's own L fails against Helvetica's) and
/// moves in steps as one reference font crosses the middle. The 75th percentile asks whether the character is, on
/// balance, within the range common fonts draw the letter in: calibrated 26 Sep 2026 (scratchpad calibrate-cross.mjs)
/// on 606 characters confusables.txt maps to an ASCII letter or digit, 7 of 8 of Paul's visual judgements, and the
/// February pairs rejected by eye. The floors depend only on the fixed reference list, never on the fonts surveyed.
const FLOOR_QUANTILE: f64 = 0.75;

/// floors(), cached in <refs file>.floors keyed by the file's stamp and the quantile.
fn floors_cached(path: &str, refs: &[RefFont], q: f64) -> Vec<Vec<Floor>> {
    let key = refs_stamp(path) ^ q.to_bits().rotate_left(29) ^ 0x3;
    let cache = format!("{}.floors", path);
    if let Ok(c) = std::fs::read(&cache) {
        if c.len() >= 8 && u64::from_le_bytes(c[0..8].try_into().unwrap()) == key {
            let mut at = 8;
            return refs.iter().map(|r| (0..r.targets.len()).map(|_| Floor { shape: read_f64(&c, &mut at), size: read_f64(&c, &mut at), em: read_f64(&c, &mut at) }).collect()).collect();
        }
    }
    let fl = floors(refs, q);
    let mut out = key.to_le_bytes().to_vec();
    for row in &fl { for f in row { for v in [f.shape, f.size, f.em] { out.extend_from_slice(&v.to_le_bytes()); } } }
    let tmp = format!("{}.{}", cache, std::process::id());
    if std::fs::write(&tmp, &out).is_ok() { let _ = std::fs::rename(&tmp, &cache); }
    fl
}

/// Linear interpolation between order statistics; infinity when empty.
fn quantile(mut xs: Vec<f64>, q: f64) -> f64 {
    if xs.is_empty() { return f64::INFINITY; }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let i = (xs.len() - 1) as f64 * q;
    let (lo, hi) = (i.floor() as usize, i.ceil() as usize);
    xs[lo] + (xs[hi] - xs[lo]) * (i - lo as f64)
}

/// The floors (score-cross-font.ts floorFor): for letter or digit t in reference font R, the q-quantile (release 2: the
/// median) of the shape distances, box gaps and (CVR3) em distances from t in R to t in each other reference font.
/// Sequences have none of their own: they are held to their letters' (cross_font).
fn floors(refs: &[RefFont], q: f64) -> Vec<Vec<Floor>> {
    let lists = |ri: usize, ti: usize| -> Option<(Vec<f64>, Vec<f64>, Vec<f64>)> {
        let tr = refs[ri].targets[ti].as_ref()?;
        let (mut shapes, mut sizes, mut ems) = (Vec::new(), Vec::new(), Vec::new());
        for (r2i, r2) in refs.iter().enumerate() {
            if r2i == ri { continue; }
            let Some(t2) = &r2.targets[ti] else { continue };
            shapes.push(compare_geometric(&t2.sig, &tr.sig));
            sizes.push(box_gap(&t2.bx, &tr.bx));
            if let (Some(a), Some(b)) = (&t2.em, &tr.em) { ems.push(em_distance(&a[0], &a[1], b)); }
        }
        Some((shapes, sizes, ems))
    };
    if let Some(mut f) = dump_file("CV_FLOOR_DUMP", false) {
        for (ri, r) in refs.iter().enumerate() {
            for ti in 0..62.min(r.targets.len()) {
                let Some((shapes, sizes, ems)) = lists(ri, ti) else { continue };
                let join = |v: &Vec<f64>| v.iter().map(|d| format!("{:.4}", d)).collect::<Vec<_>>().join(",");
                writeln!(f, "F\t{}\t{:X}\t{}\t{}\t{}", r.name, r.targets[ti].as_ref().unwrap().cp, join(&shapes), join(&sizes), join(&ems)).unwrap();
            }
        }
    }
    refs.iter().enumerate().map(|(ri, r)| (0..r.targets.len()).into_par_iter().map(|ti| {
        if ti >= 62 { return NO_FLOOR; }
        let Some((shapes, sizes, ems)) = lists(ri, ti) else { return NO_FLOOR };
        if std::env::var("CV_DEBUG_FLOOR").ok().and_then(|h| u32::from_str_radix(&h, 16).ok()) == Some(r.targets[ti].as_ref().unwrap().cp) {
            eprintln!("floor {:X} in {}: shape median {:.3}, q{} {:.3}; em q{} {:.3}", r.targets[ti].as_ref().unwrap().cp, r.name,
                median(shapes.clone()), q, quantile(shapes.clone(), q), q, quantile(ems.clone(), q));
        }
        Floor { shape: quantile(shapes, q), size: quantile(sizes, q), em: quantile(ems, q) }
    }).collect()).collect()
}

/// score-cross-font.ts's test for one font F: each of its glyphs x against each reference font R that lacks x (or,
/// with release2_rule, only glyphs no reference font draws), R other than F. x looks like target t in R when t is the
/// nearest of R's 62 letters and digits to x (no other within a smaller distance), the distance is within the floor and
/// under GLOBAL_CAP, and the box gap is within the floor; with cross_em, also when x and t are within the em floor in
/// the em frame, where x sits in its own font at the same size and on the same baseline as R's letters, as a browser
/// draws a fallback character. The count bound skips targets that cannot be under GLOBAL_CAP; any target nearer than a
/// passing one is under it too, so the nearest test stays exact. Returns (x, t, R, distance, em distance).
type CrossRow = (u32, u32, usize, f64, f64, f64, f64); // x, t, R, shape distance, em distance, extra space left, right

fn cross_font(font: &MultiFont, sigs: &[[Sig; 3]], refs: &[RefFont], fl: &[Vec<Floor>], release2_rule: bool, cross_em: bool) -> Vec<CrossRow> {
    let dumping = std::env::var("CV_CROSS_DUMP").is_ok();
    let per: Vec<(Vec<CrossRow>, Vec<String>)> = font.glyphs.par_iter().map(|&(x, k, bx, adv)| {
        let sx = &sigs[k][0];
        // The white space x brings each side (in its own font) less the target's (in R), in em: how x fits the line
        let space = |t: &Target| (bx[0] - t.bx[0], (adv - bx[2]) - (t.adv - t.bx[2]));
        let emx = |t: &Target| t.em.as_ref().map(|e| em_distance(&sigs[k][1], &sigs[k][2], e)).unwrap_or(f64::NAN);
        let mut rows = Vec::new();
        let mut dumps: Vec<String> = Vec::new();
        if sx.positions.is_empty() || x >= SEQ_BASE { return (rows, dumps); }
        if release2_rule && refs.iter().any(|r| r.chars.contains(&x)) { return (rows, dumps); }
        for (ri, r) in refs.iter().enumerate() {
            if r.name == font.name || r.chars.contains(&x) { continue; }
            let mut d = [f64::INFINITY; 62];
            for (ti, t) in r.targets.iter().take(62).enumerate() {
                let Some(t) = t else { continue };
                if bound_rules_out(&sx.counts, &t.sig.counts, GLOBAL_CAP) { continue; }
                d[ti] = compare_geometric(sx, &t.sig);
            }
            let best = d.iter().cloned().fold(f64::INFINITY, f64::min);
            if dumping {
                let mut order: Vec<usize> = (0..62).filter(|&ti| d[ti].is_finite()).collect();
                order.sort_by(|&a, &b| d[a].partial_cmp(&d[b]).unwrap());
                if let Some(&t1) = order.first() {
                    let tt = r.targets[t1].as_ref().unwrap();
                    let (t2cp, d2) = order.get(1).map(|&t2| (r.targets[t2].as_ref().unwrap().cp, d[t2])).unwrap_or((0, f64::INFINITY));
                    dumps.push(format!("D\t{}\t{:X}\t{}\t{:X}\t{:.4}\t{:.4}\t{:X}\t{:.4}\t{:.4}", font.name, x, r.name, tt.cp, d[t1], box_gap(&bx, &tt.bx), t2cp, d2, emx(tt)));
                }
            }
            if debug_cross() == Some(x) {
                // CV_DEBUG_CROSS=<hex>: the three nearest targets in each reference font, with the floors they must meet
                let mut order: Vec<usize> = (0..62).filter(|&ti| d[ti].is_finite()).collect();
                order.sort_by(|&a, &b| d[a].partial_cmp(&d[b]).unwrap());
                let near: Vec<String> = order.iter().take(3).map(|&ti| {
                    let t = r.targets[ti].as_ref().unwrap();
                    let f = fl[ri][ti];
                    format!("{} {:.3}/{:.3} gap {:.2}/{:.2} em {:.3}/{:.3}", char::from_u32(t.cp).unwrap_or('?'), d[ti], f.shape, box_gap(&bx, &t.bx), f.size, emx(t), f.em)
                }).collect();
                eprintln!("cross {:X} in {}: {}", x, r.name, near.join(" | "));
            }
            // Two-character sequences (CVR2/3): their own pool, so a sequence never displaces a letter as x's nearest.
            // A sequence is held to its letters' floors in R (the stricter of the two, in shape, size and em), not to
            // how much the sequence varies between fonts: that spread includes the spacing between the letters, and how
            // the letters sit together in this font is the point (Paul, 26 Sep 2026). Only sequences x's size could
            // pass for compete for nearest.
            if r.targets.len() > 62 {
                let (mut best_s, mut near) = (GLOBAL_CAP, Vec::new());
                let seq_floor = |t: &Target| {
                    let k = (t.cp - SEQ_BASE) as usize;
                    let (a, b) = (fl[ri][k / 62], fl[ri][k % 62]);
                    Floor { shape: a.shape.min(b.shape), size: a.size.min(b.size), em: a.em.min(b.em) }
                };
                for ti in 62..r.targets.len() {
                    let Some(t) = &r.targets[ti] else { continue };
                    if box_gap(&bx, &t.bx) > seq_floor(t).size || bound_rules_out(&sx.counts, &t.sig.counts, best_s) { continue; }
                    let dd = compare_geometric(sx, &t.sig);
                    if dd < best_s { best_s = dd; near.clear(); }
                    if dd == best_s { near.push(ti); }
                }
                for ti in near {
                    let t = r.targets[ti].as_ref().unwrap();
                    let f = seq_floor(t);
                    let e = emx(t);
                    if best_s <= f.shape && (!cross_em || e <= f.em) { let (l, r) = space(t); rows.push((x, t.cp, ri, best_s, e, l, r)); }
                }
            }
            if best > GLOBAL_CAP { continue; }
            for ti in 0..62 {
                if d[ti] != best { continue; }
                let t = r.targets[ti].as_ref().unwrap();
                let f = fl[ri][ti];
                if box_gap(&bx, &t.bx) <= f.size && d[ti] <= f.shape && d[ti] <= GLOBAL_CAP {
                    let e = emx(t);
                    if !cross_em || release2_rule || e <= f.em { let (l, r) = space(t); rows.push((x, t.cp, ri, d[ti], e, l, r)); }
                }
            }
        }
        (rows, dumps)
    }).collect();
    if dumping {
        if let Some(mut f) = dump_file("CV_CROSS_DUMP", true) { for (_, ds) in &per { for d in ds { writeln!(f, "{}", d).unwrap(); } } }
    }
    per.into_iter().flat_map(|(rows, _)| rows).collect()
}

fn write_sigs(path: &str, glyphs: &[Glyph]) {
    let mut out = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    out.write_all(b"CVS1").unwrap();
    out.write_all(&(glyphs.len() as u32).to_le_bytes()).unwrap();
    for g in glyphs {
        out.write_all(&g.cp.to_le_bytes()).unwrap();
        for s in &g.sigs {
            out.write_all(&s.counts).unwrap();
            out.write_all(&(s.positions.len() as u32).to_le_bytes()).unwrap();
            let arrays = [&s.positions, &s.angles, &s.ping_dist, &s.ping_max];
            let flags = arrays.iter().enumerate().fold(0u8, |f, (i, a)| if a.is_empty() { f } else { f | 1 << i });
            out.write_all(&[flags]).unwrap();
            for a in arrays { if !a.is_empty() { out.write_all(a).unwrap(); } }
        }
    }
}

fn read_sig(buf: &[u8], at: &mut usize) -> Sig {
    let counts = buf[*at..*at + N_RAYS].to_vec();
    *at += N_RAYS;
    let total = read_u32(buf, at) as usize;
    let flags = buf[*at];
    *at += 1;
    let mut take = |bit: u8| {
        if flags & bit == 0 {
            return Vec::new();
        }
        let v = buf[*at..*at + total].to_vec();
        *at += total;
        v
    };
    let positions = take(1);
    let angles = take(2);
    let ping_dist = take(4);
    let ping_max = take(8);
    Sig { counts, positions, angles, ping_dist, ping_max }
}

/// compareGeometric (src/signature-bank.ts), for two signatures that both have positions.
fn compare_geometric(a: &Sig, b: &Sig) -> f64 {
    let (pa, pb) = (&a.positions, &b.positions);
    let use_ang = !a.angles.is_empty() && !b.angles.is_empty();
    let use_pd = !a.ping_dist.is_empty() && !b.ping_dist.is_empty();
    let use_pm = !a.ping_max.is_empty() && !b.ping_max.is_empty();
    let (mut off_a, mut off_b) = (0usize, 0usize);
    let (mut mean_sum, mut max_angle) = (0f64, 0f64);
    for ai in 0..NUM_ANGLES {
        let mut angle_sum = 0f64;
        for ri in 0..RAYS {
            let i = ai * RAYS + ri;
            let (c_a, c_b) = (a.counts[i] as usize, b.counts[i] as usize);
            let matched = c_a.min(c_b);
            let mut ray = (c_a as f64 - c_b as f64).abs();
            if matched > 0 {
                let (mut pos, mut ang, mut pd, mut pm) = (0f64, 0f64, 0f64, 0f64);
                for p in 0..matched {
                    let (i, j) = (off_a + p, off_b + p);
                    pos += (pa[i] as f64 - pb[j] as f64).abs();
                    if use_ang { ang += (a.angles[i] as f64 - b.angles[j] as f64).abs(); }
                    if use_pd { pd += (a.ping_dist[i] as f64 - b.ping_dist[j] as f64).abs(); }
                    if use_pm { pm += (a.ping_max[i] as f64 - b.ping_max[j] as f64).abs(); }
                }
                let geometry = (pos + 0.3 * (ang + pd + pm)) / (255.0 * matched as f64);
                ray += GEOMETRY_WEIGHT * geometry;
            }
            angle_sum += ray;
            off_a += c_a;
            off_b += c_b;
        }
        let angle_mean = angle_sum / RAYS as f64;
        mean_sum += angle_mean;
        if angle_mean > max_angle { max_angle = angle_mean; }
    }
    0.5 * (mean_sum / NUM_ANGLES as f64) + 0.5 * max_angle
}

/// True when the count-only lower bound already reaches `thr`: the pair cannot be under it.
#[inline]
fn bound_rules_out(a: &[u8], b: &[u8], thr: f64) -> bool {
    // Per angle, S = sum |ca - cb|; angle mean >= S / RAYS. One angle alone gives 0.5 * S / RAYS <= distance.
    let max_s_single = ((thr + EPS) * 2.0 * RAYS as f64).ceil() as u32;
    let mut total = 0u32;
    let mut max_s = 0u32;
    for (ca, cb) in a.chunks_exact(RAYS).zip(b.chunks_exact(RAYS)) {
        let s: u32 = ca.iter().zip(cb).map(|(&x, &y)| x.abs_diff(y) as u32).sum();
        if s >= max_s_single { return true; }
        total += s;
        if s > max_s { max_s = s; }
    }
    let bound = 0.5 * (total as f64 / RAYS as f64 / NUM_ANGLES as f64) + 0.5 * (max_s as f64 / RAYS as f64);
    bound >= thr + EPS
}

/// Every pair alike under release 2's measurement: em distance (the lower of the two centrings) under EM_ALIKE, box
/// distance under ALIKE. The count bound only skips pairs that cannot pass.
fn alike_pairs(glyphs: &[(u32, &[Sig; 3])]) -> Vec<(u32, u32, f64, f64)> {
    (0..glyphs.len()).into_par_iter().with_min_len(1).flat_map_iter(|i| {
        let (acp, a) = glyphs[i];
        let mut rows = Vec::new();
        for &(bcp, b) in &glyphs[i + 1..] {
            // The em test first: it fails for most pairs. Alike under either centring.
            let mut e = f64::INFINITY;
            for k in [1, 2] {
                if !bound_rules_out(&a[k].counts, &b[k].counts, EM_ALIKE) {
                    e = e.min(compare_geometric(&a[k], &b[k]));
                    if e < EM_ALIKE { break; }
                }
            }
            if e >= EM_ALIKE { continue; }
            if bound_rules_out(&a[0].counts, &b[0].counts, ALIKE) { continue; }
            let d = compare_geometric(&a[0], &b[0]);
            if d >= ALIKE { continue; }
            rows.push((acp, bcp, d, e));
        }
        rows.into_iter()
    }).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let sample: usize = args.iter().position(|a| a == "--sample").map(|i| args[i + 1].parse().unwrap()).unwrap_or(0);
    let dump = args.iter().position(|a| a == "--dump-sigs").map(|i| args[i + 1].clone());
    let limit: usize = args.iter().position(|a| a == "--limit").map(|i| args[i + 1].parse().unwrap()).unwrap_or(usize::MAX);

    let mut buf = Vec::new();
    std::fs::File::open(path).unwrap().read_to_end(&mut buf).unwrap();
    let started = std::time::Instant::now();
    if &buf[0..4] == b"CVG2" || &buf[0..4] == b"CVG3" || &buf[0..4] == b"CVG4" {
        let (sigs, overlapping, fonts) = read_multi(&buf);
        drop(buf);
        eprintln!("signatures: {} distinct outlines for {} glyphs in {} fonts, {:.1}s", sigs.len(),
            fonts.iter().map(|f| f.glyphs.len()).sum::<usize>(), fonts.len(), started.elapsed().as_secs_f64());
        let cross_path = args.iter().position(|a| a == "--cross").map(|i| args[i + 1].clone());
        let cross = cross_path.as_deref().map(read_refs);
        let release2_rule = args.iter().any(|a| a == "--release2-rule");
        let cross_em = args.iter().any(|a| a == "--cross-em");
        // With a floor dump requested, computed afresh (the dump is written as the floors are)
        let q = if release2_rule { 0.5 } else { FLOOR_QUANTILE };
        let fl = cross.as_ref().map(|r| if std::env::var("CV_FLOOR_DUMP").is_ok() { floors(r, q) } else { floors_cached(cross_path.as_deref().unwrap(), r, q) });
        let out = std::io::stdout();
        let mut out = std::io::BufWriter::new(out.lock());
        for (fi, font) in fonts.iter().enumerate() {
            // Blank glyphs (no hits, so no positions) are left out, as below
            let refs: Vec<(u32, &[Sig; 3])> = font.glyphs.iter().map(|&(cp, k, _, _)| (cp, &sigs[k]))
                .filter(|(_, s)| s.iter().all(|s| !s.positions.is_empty())).collect();
            for (a, b, d, e) in alike_pairs(&refs) {
                if a >= SEQ_BASE && b >= SEQ_BASE { continue; } // two sequences: not a question anyone asks
                writeln!(out, "{} {:X} {:X} {:?} {:?}", fi, a, b, d, e).unwrap();
            }
            for &(cp, k, _, _) in &font.glyphs { if overlapping[k] { writeln!(out, "O {} {:X}", fi, cp).unwrap(); } }
            if let (Some(r), Some(fl), true) = (&cross, &fl, font.cross) {
                for (x, t, ri, d, e, l, r2) in cross_font(font, &sigs, r, fl, release2_rule, cross_em) { writeln!(out, "X {} {:X} {:X} {} {:?} {:?} {:?} {:?}", fi, x, t, ri, d, e, l, r2).unwrap(); }
            }
        }
        return;
    }
    let glyphs = match &buf[0..4] {
        b"CVS1" => {
            let mut at = 4;
            let n = read_u32(&buf, &mut at) as usize;
            let mut glyphs = Vec::with_capacity(n);
            for _ in 0..n {
                let cp = read_u32(&buf, &mut at);
                let sigs = [read_sig(&buf, &mut at), read_sig(&buf, &mut at), read_sig(&buf, &mut at)];
                glyphs.push(Glyph { cp, sigs, overlapping: false });
            }
            glyphs
        }
        b"CVG1" => {
            let g = read_outlines(&buf, limit);
            if std::env::var("CV_REPORT_OVERLAP").is_ok() { for gl in &g { if gl.overlapping { eprintln!("overlap {:X}", gl.cp); } } }
            eprintln!("signatures: {} glyphs in {:.1}s", g.len(), started.elapsed().as_secs_f64());
            if args.iter().any(|a| a == "--sigs-only") { if let Some(p) = &dump { write_sigs(p, &g); } return; }
            g
        }
        _ => panic!("not a signature or outline file"),
    };
    drop(buf);
    if let Some(p) = dump { write_sigs(&p, &glyphs); }
    // A glyph with no hits has no positions; compareGeometric would fall back to a histogram test. None is a letter
    // anyone reads, so they are left out and counted.
    if args.iter().any(|a| a == "--consecutive") {
        // The in-place comparison (scripts/_in-place.ts): glyphs 2i and 2i+1 are a genuine snippet and the same snippet
        // with the lookalike, both in the genuine snippet's window; their distances in the three slots
        let out = std::io::stdout();
        let mut out = std::io::BufWriter::new(out.lock());
        for p in glyphs.chunks(2) {
            if p.len() < 2 { break; }
            let d = |k: usize| if p[0].sigs[k].positions.is_empty() || p[1].sigs[k].positions.is_empty() { f64::NAN } else { compare_geometric(&p[0].sigs[k], &p[1].sigs[k]) };
            writeln!(out, "{:X} {:X} {:?} {:?} {:?}", p[0].cp, p[1].cp, d(0), d(1), d(2)).unwrap();
        }
        return;
    }
    let (glyphs, blank): (Vec<Glyph>, Vec<Glyph>) = glyphs.into_iter().partition(|g| g.sigs.iter().all(|s| !s.positions.is_empty()));
    eprintln!("{} glyphs ({} blank, left out)", glyphs.len(), blank.len());

    let out = std::io::stdout();
    let mut out = std::io::BufWriter::new(out.lock());
    if args.iter().any(|a| a == "--all-distances") {
        // Every pair's three distances (box, em on the advance, em on the ink), for calibration
        for i in 0..glyphs.len() { for j in i + 1..glyphs.len() {
            let (a, b) = (&glyphs[i], &glyphs[j]);
            writeln!(out, "{:X} {:X} {:?} {:?} {:?}", a.cp, b.cp, compare_geometric(&a.sigs[0], &b.sigs[0]),
                compare_geometric(&a.sigs[1], &b.sigs[1]), compare_geometric(&a.sigs[2], &b.sigs[2])).unwrap();
        } }
        return;
    }
    if sample > 0 {
        let mut k = 0;
        'outer: for i in 0..glyphs.len() {
            for j in i + 1..glyphs.len() {
                let (a, b) = (&glyphs[i], &glyphs[j]);
                writeln!(out, "{:X} {:X} {:?} {:?} {:?}", a.cp, b.cp, compare_geometric(&a.sigs[0], &b.sigs[0]),
                    compare_geometric(&a.sigs[1], &b.sigs[1]), compare_geometric(&a.sigs[2], &b.sigs[2])).unwrap();
                k += 1;
                if k >= sample { break 'outer; }
            }
        }
        return;
    }

    let refs: Vec<(u32, &[Sig; 3])> = glyphs.iter().map(|g| (g.cp, &g.sigs)).collect();
    let found = alike_pairs(&refs);
    for (a, b, d, e) in found {
        writeln!(out, "{:X} {:X} {:?} {:?}", a, b, d, e).unwrap();
    }
}
