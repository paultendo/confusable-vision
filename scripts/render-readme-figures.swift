// render-readme-figures.swift: the README's figures, in the blog's type (Syne, Instrument Sans, Google Sans Code; OFL,
// in docs/fonts) and colours. The specimens are Arial, one of the in-place contexts, with each lookalike in the font
// macOS falls back to for it (the Noto fonts, OFL).
//
// Usage (from the repo root): swiftc -O scripts/render-readme-figures.swift -o /tmp/figs && /tmp/figs docs/images
// then, to keep the README light: pngquant --quality 85-98 --speed 1 --strip -f --ext .png docs/images/*.png
//
//   rays.png      a letter and its lookalike cut by the same rays: where each ray enters and leaves ink, and its path
//                 through ink (the ping)
//   in-place.png  lookalikes Unicode does not list, in words, enlarged and at reading size
import Foundation
import CoreText
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "docs/images"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
for f in ["Syne", "InstrumentSans", "GoogleSansCode"] {
    CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: "docs/fonts/\(f).ttf") as CFURL, .process, nil)
}
let SCALE: CGFloat = 2

func rgba(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: a)
}
// The blog's tokens
let background = rgba(0x090e17), foreground = rgba(0xeef4ff), muted = rgba(0xbcc9df), faint = rgba(0xbcc9df, 0.62)
let hairline = rgba(0xd0e3ff, 0.15), accent = rgba(0x1ed760), accentSoft = rgba(0x1ed760, 0.15), red = rgba(0xff5a5a), amber = rgba(0xffbe3c)

func display(_ s: CGFloat) -> CTFont { CTFontCreateWithName("Syne-SemiBold" as CFString, s, nil) }
func body(_ s: CGFloat, medium: Bool = false) -> CTFont { CTFontCreateWithName((medium ? "InstrumentSans-Medium" : "InstrumentSans-Regular") as CFString, s, nil) }
func mono(_ s: CGFloat) -> CTFont { CTFontCreateWithName("GoogleSansCode-Regular" as CFString, s, nil) }
func arial(_ s: CGFloat) -> CTFont { CTFontCreateWithName("ArialMT" as CFString, s, nil) }

func textLine(_ s: String, _ f: CTFont, _ c: CGColor, kern: CGFloat = 0) -> CTLine {
    CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): f, NSAttributedString.Key(kCTForegroundColorAttributeName as String): c,
        NSAttributedString.Key(kCTKernAttributeName as String): kern]))
}
func width(_ s: String, _ f: CTFont, kern: CGFloat = 0) -> CGFloat { CGFloat(CTLineGetTypographicBounds(textLine(s, f, foreground, kern: kern), nil, nil, nil)) }
func draw(_ ctx: CGContext, _ s: String, _ f: CTFont, _ c: CGColor, _ x: CGFloat, _ y: CGFloat, kern: CGFloat = 0) {
    ctx.textPosition = CGPoint(x: x, y: y); CTLineDraw(textLine(s, f, c, kern: kern), ctx)
}

func canvas(_ w: Int, _ h: Int) -> CGContext {
    let ctx = CGContext(data: nil, width: w * Int(SCALE), height: h * Int(SCALE), bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.scaleBy(x: SCALE, y: SCALE)
    ctx.setFillColor(background); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    return ctx
}
func glow(_ ctx: CGContext, at p: CGPoint, radius: CGFloat, _ c: CGColor) {
    let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [c, c.copy(alpha: 0)!] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(g, startCenter: p, startRadius: 0, endCenter: p, endRadius: radius, options: [])
}
func save(_ ctx: CGContext, _ name: String) {
    let url = URL(fileURLWithPath: outDir).appendingPathComponent(name)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil); CGImageDestinationFinalize(dest)
    print(url.path)
}
/// A rounded card: a faint top-lit fill and a hairline border
func card(_ ctx: CGContext, _ r: CGRect, radius: CGFloat) {
    let path = CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
    ctx.saveGState(); ctx.addPath(path); ctx.clip()
    let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [rgba(0x16223a), rgba(0x0c1320)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(g, start: CGPoint(x: r.midX, y: r.maxY), end: CGPoint(x: r.midX, y: r.minY), options: [])
    ctx.restoreGState()
    ctx.addPath(path); ctx.setStrokeColor(hairline); ctx.setLineWidth(1); ctx.strokePath()
}
/// A pill in the accent: soft fill, a tick, a label. Returns its frame.
@discardableResult
func pill(_ ctx: CGContext, _ label: String, centre: CGPoint, size: CGFloat = 14) -> CGRect {
    let f = body(size, medium: true), h = size + 16, w = width(label, f) + 18 + 32
    let r = CGRect(x: centre.x - w / 2, y: centre.y - h / 2, width: w, height: h)
    ctx.addPath(CGPath(roundedRect: r, cornerWidth: h / 2, cornerHeight: h / 2, transform: nil)); ctx.setFillColor(accentSoft); ctx.fillPath()
    let x = r.minX + 14, u = size / 14
    ctx.setStrokeColor(accent); ctx.setLineWidth(1.8); ctx.setLineCap(.round); ctx.setLineJoin(.round)
    ctx.move(to: CGPoint(x: x, y: centre.y)); ctx.addLine(to: CGPoint(x: x + 3.6 * u, y: centre.y - 3.8 * u))
    ctx.addLine(to: CGPoint(x: x + 10 * u, y: centre.y + 3.8 * u)); ctx.strokePath()
    draw(ctx, label, f, accent, x + 18, centre.y - size * 0.34)
    return r
}

// A glyph's ink as a mask, as Core Text draws it (with fallback), in a square with rows from the top
func mask(_ s: String, size: CGFloat, box: Int, baseline: CGFloat) -> [UInt8] {
    let c = CGContext(data: nil, width: box, height: box, bitsPerComponent: 8, bytesPerRow: box, space: CGColorSpaceCreateDeviceGray(),
                      bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    c.setFillColor(gray: 0, alpha: 1); c.fill(CGRect(x: 0, y: 0, width: box, height: box))
    let f = arial(size)
    c.textPosition = CGPoint(x: (CGFloat(box) - width(s, f)) / 2, y: baseline); CTLineDraw(textLine(s, f, CGColor(gray: 1, alpha: 1)), c)
    let p = c.data!.bindMemory(to: UInt8.self, capacity: box * box)
    var out = [UInt8](repeating: 0, count: box * box)
    for y in 0..<box { for x in 0..<box { out[(box - 1 - y) * box + x] = p[y * box + x] > 127 ? 1 : 0 } }
    return out
}

// ---- rays.png ----
do {
    let W = 1200, H = 730, panel: CGFloat = 420, bottom: CGFloat = 132
    let ctx = canvas(W, H)
    glow(ctx, at: CGPoint(x: 600, y: bottom + panel / 2), radius: 560, rgba(0x1c3a66, 0.32))
    draw(ctx, "The same rays through both", display(34), foreground, 64, CGFloat(H) - 76, kern: -0.3)
    draw(ctx, "Where each ray enters the ink, where it leaves, and how far it travels inside.", body(17), muted, 64, CGFloat(H) - 108)
    // Legend, under the lede
    let ly = CGFloat(H) - 146
    glow(ctx, at: CGPoint(x: 70, y: ly + 5), radius: 8, rgba(0xff5a5a, 0.45))
    ctx.setFillColor(red); ctx.fillEllipse(in: CGRect(x: 66.5, y: ly + 1.5, width: 7, height: 7))
    draw(ctx, "enters or leaves ink", body(14), faint, 84, ly)
    let lx = 84 + width("enters or leaves ink", body(14)) + 28
    ctx.setStrokeColor(amber); ctx.setLineWidth(2.4); ctx.setLineCap(.round)
    ctx.move(to: CGPoint(x: lx, y: ly + 5)); ctx.addLine(to: CGPoint(x: lx + 16, y: ly + 5)); ctx.strokePath()
    draw(ctx, "the ping: its path through ink", body(14), faint, lx + 26, ly)

    let pair: [(String, String, String)] = [("O", "U+004F", "Latin capital letter O"), ("\u{1C5B}", "U+1C5B", "Ol Chiki letter at")]
    let size: CGFloat = 310, box = Int(panel), baseline: CGFloat = 100, angle: CGFloat = 0.52, rays = 31, span: CGFloat = 190
    let lefts: [CGFloat] = [64, CGFloat(W) - 64 - panel]
    for (i, g) in pair.enumerated() {
        let x0 = lefts[i], y0 = bottom, r = CGRect(x: x0, y: y0, width: panel, height: panel)
        card(ctx, r, radius: 28)
        ctx.saveGState(); ctx.addPath(CGPath(roundedRect: r.insetBy(dx: 1, dy: 1), cornerWidth: 27, cornerHeight: 27, transform: nil)); ctx.clip()
        // The glyph as a ghost with a fine outline
        let f = arial(size), gx = x0 + (panel - width(g.0, f)) / 2
        draw(ctx, g.0, f, rgba(0xbcc9df, 0.07), gx, y0 + baseline)
        ctx.setTextDrawingMode(.stroke); ctx.setLineWidth(0.9); ctx.setStrokeColor(rgba(0xbcc9df, 0.3))
        ctx.textPosition = CGPoint(x: gx, y: y0 + baseline); CTLineDraw(textLine(g.0, f, rgba(0xbcc9df, 0.3)), ctx)
        ctx.setTextDrawingMode(.fill)
        // Rays across the card; ink runs from the mask
        let m = mask(g.0, size: size, box: box, baseline: baseline)
        let dx = cos(angle), dy = sin(angle), nx = -dy, ny = dx, cx = panel / 2, cy = panel / 2
        let at = { (ox: CGFloat, oy: CGFloat, s: CGFloat) -> CGPoint in CGPoint(x: x0 + ox + dx * s, y: y0 + panel - (oy + dy * s)) }
        for k in 0..<rays {
            let off = -span + 2 * span * CGFloat(k) / CGFloat(rays - 1), ox = cx + nx * off, oy = cy + ny * off
            ctx.setStrokeColor(rgba(0xbcc9df, 0.08)); ctx.setLineWidth(0.8)
            ctx.move(to: at(ox, oy, -340)); ctx.addLine(to: at(ox, oy, 340)); ctx.strokePath()
            var inside = false, start: CGFloat = 0, runs: [(CGFloat, CGFloat)] = [], s: CGFloat = -320
            while s <= 320 {
                let px = Int((ox + dx * s).rounded()), py = Int((oy + dy * s).rounded())
                let ink = px >= 0 && py >= 0 && px < box && py < box && m[py * box + px] == 1
                if ink && !inside { start = s }
                if !ink && inside { runs.append((start, s)) }
                inside = ink; s += 0.5
            }
            // A ray that only grazes the ink gets one mark, not two piled up
            for run in runs where run.1 - run.0 >= 3 {
                let p0 = at(ox, oy, run.0), p1 = at(ox, oy, run.1)
                ctx.setLineCap(.round)
                ctx.setStrokeColor(rgba(0xffbe3c, 0.2)); ctx.setLineWidth(8); ctx.move(to: p0); ctx.addLine(to: p1); ctx.strokePath()
                ctx.setStrokeColor(amber); ctx.setLineWidth(2.2); ctx.move(to: p0); ctx.addLine(to: p1); ctx.strokePath()
                for p in [p0, p1] {
                    glow(ctx, at: p, radius: 8, rgba(0xff5a5a, 0.45))
                    ctx.setFillColor(red); ctx.fillEllipse(in: CGRect(x: p.x - 2.6, y: p.y - 2.6, width: 5.2, height: 5.2))
                }
            }
        }
        ctx.restoreGState()
        draw(ctx, g.1, mono(15), foreground, x0 + 6, y0 - 34)
        draw(ctx, g.2, body(15), muted, x0 + panel - 6 - width(g.2, body(15)), y0 - 34)
    }
    // Between the cards: hairlines into the verdict
    let my = bottom + panel / 2, p = pill(ctx, "passes for O", centre: CGPoint(x: CGFloat(W) / 2, y: my))
    ctx.setStrokeColor(rgba(0x1ed760, 0.35)); ctx.setLineWidth(1); ctx.setLineDash(phase: 0, lengths: [2, 4])
    ctx.move(to: CGPoint(x: 64 + panel + 14, y: my)); ctx.addLine(to: CGPoint(x: p.minX - 10, y: my)); ctx.strokePath()
    ctx.move(to: CGPoint(x: p.maxX + 10, y: my)); ctx.addLine(to: CGPoint(x: lefts[1] - 14, y: my)); ctx.strokePath()
    ctx.setLineDash(phase: 0, lengths: [])
    draw(ctx, "Arial at 310 px; U+1C5B in the font macOS falls back to for it, Noto Sans Ol Chiki. confusable-vision release 2026.09.26.",
         body(13), faint, 64, 36)
    save(ctx, "rays.png")
}

// ---- in-place.png ----
do {
    // real word, lookalike word, index of the swapped letter, code point, name, the letter it passes for
    let rows: [(String, String, Int, String, String, String)] = [
        ("LOGO", "L\u{1C5B}GO", 1, "U+1C5B", "Ol Chiki letter at", "O"),
        ("OPEN", "\u{A89D}PEN", 0, "U+A89D", "Saurashtra letter ttha", "O"),
        ("ZONE", "Z\u{16A60}NE", 1, "U+16A60", "Mro digit zero", "O"),
        ("BOOK", "B\u{11AE4}OK", 1, "U+11AE4", "Pau Cin Hau letter final y", "O"),
        ("look", "l\u{199E}ok", 1, "U+199E", "New Tai Lue letter low va", "o"),
        ("moon", "m\u{19D0}on", 1, "U+19D0", "New Tai Lue digit zero", "o"),
    ]
    let W = 1200, rowH: CGFloat = 96, head: CGFloat = 196, H = Int(head + rowH * CGFloat(rows.count) + 78)
    let ctx = canvas(W, H)
    glow(ctx, at: CGPoint(x: 940, y: CGFloat(H) - 40), radius: 620, rgba(0x1c3a66, 0.3))
    draw(ctx, "Lookalikes Unicode doesn’t list", display(34), foreground, 64, CGFloat(H) - 76, kern: -0.3)
    draw(ctx, "Each passes for the letter in all five fonts checked. At reading size the words read the same;",
         body(17), muted, 64, CGFloat(H) - 108)
    draw(ctx, "enlarged, some small differences show. The amber mark is under the swapped letter.", body(17), muted, 64, CGFloat(H) - 132)
    let cols: [(String, CGFloat)] = [("REAL", 64), ("LOOKALIKE", 290), ("AT 16 PX", 530), ("CHARACTER", 730)]
    let headY = CGFloat(H) - head + 14
    for (c, x) in cols { draw(ctx, c, body(11.5, medium: true), faint, x, headY, kern: 1.4) }
    for (i, r) in rows.enumerated() {
        let top = CGFloat(H) - head - rowH * CGFloat(i), base = top - 62
        ctx.setStrokeColor(hairline); ctx.setLineWidth(1)
        ctx.move(to: CGPoint(x: 64, y: top)); ctx.addLine(to: CGPoint(x: CGFloat(W) - 64, y: top)); ctx.strokePath()
        let big = arial(46)
        draw(ctx, r.0, big, foreground, 64, base)
        draw(ctx, r.1, big, foreground, 290, base)
        // A small mark under the swapped letter
        let pre = String(r.1.prefix(r.2)), ch = String(r.1.dropFirst(r.2).prefix(1))
        let mx = 290 + width(pre, big) + width(ch, big) / 2
        ctx.setStrokeColor(amber); ctx.setLineWidth(3); ctx.setLineCap(.round)
        ctx.move(to: CGPoint(x: mx - 7, y: base - 14)); ctx.addLine(to: CGPoint(x: mx + 7, y: base - 14)); ctx.strokePath()
        draw(ctx, r.0, arial(16), foreground, 530, base + 12)
        draw(ctx, r.1, arial(16), foreground, 610, base + 12)
        draw(ctx, r.3, mono(15), foreground, 730, base + 26)
        draw(ctx, r.4, body(15), muted, 730, base + 4)
        let label = "passes for " + r.5
        pill(ctx, label, centre: CGPoint(x: CGFloat(W) - 64 - (width(label, body(13, medium: true)) + 50) / 2, y: base + 16), size: 13)
    }
    let last = CGFloat(H) - head - rowH * CGFloat(rows.count)
    ctx.setStrokeColor(hairline); ctx.move(to: CGPoint(x: 64, y: last)); ctx.addLine(to: CGPoint(x: CGFloat(W) - 64, y: last)); ctx.strokePath()
    draw(ctx, "Checked in place in the system font at 13 px and in Helvetica, Arial, Times New Roman and Georgia at 16 px, at 1x and 2x. Release 2026.09.26.",
         body(13), faint, 64, 36)
    save(ctx, "in-place.png")
}
