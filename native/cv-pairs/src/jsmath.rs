//! JavaScript's Math functions as Node computes them on arm64, bit for bit.
//!
//! V8 implements Math.cos and Math.acos with fdlibm, compiled by clang with -ffp-contract=on: an a*b+c written in one
//! C expression becomes a fused multiply-add. The ports below write those FMAs out (mul_add) where clang forms them;
//! each was checked against Node on 2,000,000 inputs from the ranges raycasting.ts uses, with no difference. Math.hypot
//! is V8's own algorithm (scale by the largest argument, Kahan-sum the squares). Math.cbrt matches the libm crate
//! (musl's port of FreeBSD's cbrt) exactly on the same test. JavaScript arithmetic itself is never fused, and Rust does
//! not fuse unless asked, so everything outside these functions is plain f64 in the order the TypeScript writes it.

#[inline] fn hi(x: f64) -> i32 { (x.to_bits() >> 32) as u32 as i32 }

pub fn acos(x: f64) -> f64 {
    const PI: f64 = 3.14159265358979311600e+00;
    const PIO2_HI: f64 = 1.57079632679489655800e+00;
    const PIO2_LO: f64 = 6.12323399573676603587e-17;
    const PS0: f64 = 1.66666666666666657415e-01;
    const PS1: f64 = -3.25565818622400915405e-01;
    const PS2: f64 = 2.01212532134862925881e-01;
    const PS3: f64 = -4.00555345006794114027e-02;
    const PS4: f64 = 7.91534994289814532176e-04;
    const PS5: f64 = 3.47933107596021167570e-05;
    const QS1: f64 = -2.40339491173441421878e+00;
    const QS2: f64 = 2.02094576023350569471e+00;
    const QS3: f64 = -6.88283971605453293030e-01;
    const QS4: f64 = 7.70381505559019352791e-02;
    let hx = hi(x);
    let ix = hx & 0x7fffffff;
    let p_of = |z: f64| z * z.mul_add(z.mul_add(z.mul_add(z.mul_add(z.mul_add(PS5, PS4), PS3), PS2), PS1), PS0);
    let q_of = |z: f64| z.mul_add(z.mul_add(z.mul_add(z.mul_add(QS4, QS3), QS2), QS1), 1.0);
    if ix >= 0x3ff00000 {
        let lx = x.to_bits() as u32;
        if ((ix - 0x3ff00000) as u32 | lx) == 0 { return if hx > 0 { 0.0 } else { PI + 2.0 * PIO2_LO }; }
        return (x - x) / (x - x);
    }
    if ix < 0x3fe00000 {
        if ix <= 0x3c600000 { return PIO2_HI + PIO2_LO; }
        let z = x * x;
        let r = p_of(z) / q_of(z);
        PIO2_HI - (x - (-x).mul_add(r, PIO2_LO))
    } else if hx < 0 {
        let z = (1.0 + x) * 0.5;
        let s = z.sqrt();
        let r = p_of(z) / q_of(z);
        let w = r.mul_add(s, -PIO2_LO);
        PI - 2.0 * (s + w)
    } else {
        let z = (1.0 - x) * 0.5;
        let s = z.sqrt();
        let df = f64::from_bits(s.to_bits() & 0xffffffff00000000);
        let c = (-df).mul_add(df, z) / (s + df);
        let r = p_of(z) / q_of(z);
        let w = r.mul_add(s, c);
        2.0 * (df + w)
    }
}

fn kernel_cos(x: f64, y: f64) -> f64 {
    const C1: f64 = 4.16666666666666019037e-02; const C2: f64 = -1.38888888888741095749e-03;
    const C3: f64 = 2.48015872894767294178e-05; const C4: f64 = -2.75573143513906633035e-07;
    const C5: f64 = 2.08757232129817482790e-09; const C6: f64 = -1.13596475577881948265e-11;
    let ix = hi(x) & 0x7fffffff;
    if ix < 0x3e400000 && (x as i32) == 0 { return 1.0; }
    let z = x * x;
    let r = z * z.mul_add(z.mul_add(z.mul_add(z.mul_add(z.mul_add(C6, C5), C4), C3), C2), C1);
    let inner = z.mul_add(r, -(x * y));
    if ix < 0x3fd33333 {
        1.0 - (0.5f64).mul_add(z, -inner)
    } else {
        let qx = if ix > 0x3fe90000 { 0.28125 } else { f64::from_bits(((ix - 0x00200000) as u32 as u64) << 32) };
        let hz = (0.5f64).mul_add(z, -qx);
        let a = 1.0 - qx;
        a - (hz - inner)
    }
}

fn kernel_sin(x: f64, y: f64, iy: i32) -> f64 {
    const S1: f64 = -1.66666666666666324348e-01; const S2: f64 = 8.33333333332248946124e-03;
    const S3: f64 = -1.98412698298579493134e-04; const S4: f64 = 2.75573137070700676789e-06;
    const S5: f64 = -2.50507602534068634195e-08; const S6: f64 = 1.58969099521155010221e-10;
    let ix = hi(x) & 0x7fffffff;
    if ix < 0x3e400000 && (x as i32) == 0 { return x; }
    let z = x * x;
    let v = z * x;
    let r = z.mul_add(z.mul_add(z.mul_add(z.mul_add(S6, S5), S4), S3), S2);
    if iy == 0 { v.mul_add(z.mul_add(r, S1), x) } else {
        let a = (0.5f64).mul_add(y, -(v * r));
        let b = z.mul_add(a, -y);
        x - (-v).mul_add(S1, b)
    }
}

/// fdlibm __ieee754_rem_pio2 for |x| up to 2^19 * pi/2 (every argument raycasting.ts passes is within 2 pi).
fn rem_pio2(x: f64) -> (i32, f64, f64) {
    const INVPIO2: f64 = 6.36619772367581382433e-01;
    const PIO2_1: f64 = 1.57079632673412561417e+00; const PIO2_1T: f64 = 6.07710050650619224932e-11;
    const PIO2_2: f64 = 6.07710050630396597660e-11; const PIO2_2T: f64 = 2.02226624879595063154e-21;
    const PIO2_3: f64 = 2.02226624871116645580e-21; const PIO2_3T: f64 = 8.47842766036889956997e-32;
    const NPIO2_HW: [i32; 32] = [
        0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB,
        0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB,
        0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
        0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB];
    let hx = hi(x);
    let ix = hx & 0x7fffffff;
    if ix < 0x4002d97c {
        if hx > 0 {
            let mut z = x - PIO2_1;
            if ix != 0x3ff921fb { let y0 = z - PIO2_1T; return (1, y0, (z - y0) - PIO2_1T); }
            z -= PIO2_2; let y0 = z - PIO2_2T; return (1, y0, (z - y0) - PIO2_2T);
        } else {
            let mut z = x + PIO2_1;
            if ix != 0x3ff921fb { let y0 = z + PIO2_1T; return (-1, y0, (z - y0) + PIO2_1T); }
            z += PIO2_2; let y0 = z + PIO2_2T; return (-1, y0, (z - y0) + PIO2_2T);
        }
    }
    assert!(ix <= 0x413921fb, "cos argument outside the medium range");
    let t = x.abs();
    let n = t.mul_add(INVPIO2, 0.5) as i32;
    let fnn = n as f64;
    let mut r = (-fnn).mul_add(PIO2_1, t);
    let mut w = fnn * PIO2_1T;
    let mut y0;
    if n < 32 && ix != NPIO2_HW[(n - 1) as usize] { y0 = r - w; } else {
        let j = ix >> 20;
        y0 = r - w;
        let mut i = j - ((hi(y0) >> 20) & 0x7ff);
        if i > 16 {
            let t = r; w = fnn * PIO2_2; r = t - w; w = fnn.mul_add(PIO2_2T, -((t - r) - w)); y0 = r - w;
            i = j - ((hi(y0) >> 20) & 0x7ff);
            if i > 49 { let t = r; w = fnn * PIO2_3; r = t - w; w = fnn.mul_add(PIO2_3T, -((t - r) - w)); y0 = r - w; }
        }
    }
    let y1 = (r - y0) - w;
    if hx < 0 { (-n, -y0, -y1) } else { (n, y0, y1) }
}

pub fn cos(x: f64) -> f64 {
    let ix = hi(x) & 0x7fffffff;
    if ix <= 0x3fe921fb { return kernel_cos(x, 0.0); }
    if ix >= 0x7ff00000 { return x - x; }
    let (n, y0, y1) = rem_pio2(x);
    match n & 3 { 0 => kernel_cos(y0, y1), 1 => -kernel_sin(y0, y1, 1), 2 => -kernel_cos(y0, y1), _ => kernel_sin(y0, y1, 1) }
}

pub fn cbrt(x: f64) -> f64 { libm::cbrt(x) }

/// V8's Math.hypot for two arguments.
pub fn hypot(x: f64, y: f64) -> f64 {
    if x.is_infinite() || y.is_infinite() { return f64::INFINITY; }
    if x.is_nan() || y.is_nan() { return f64::NAN; }
    let a = [x.abs(), y.abs()];
    let max = if a[1] > a[0] { a[1] } else { a[0] };
    if max == 0.0 { return 0.0; }
    let (mut sum, mut comp) = (0f64, 0f64);
    for v in a { let n = v / max; let s = n * n - comp; let p = sum + s; comp = (p - sum) - s; sum = p; }
    sum.sqrt() * max
}

/// Math.round: the nearest integer, halves toward +infinity.
#[inline] pub fn round(x: f64) -> f64 {
    let c = x.ceil();
    if c - 0.5 > x { c - 1.0 } else { c }
}
/// Math.min / Math.max: NaN if either is NaN (f64::min would return the other).
#[inline] pub fn min(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else if a < b || (a == b && a.is_sign_negative()) { a } else { b } }
#[inline] pub fn max(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else if a > b || (a == b && b.is_sign_negative()) { a } else { b } }
