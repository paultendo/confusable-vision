// ct-outlines.swift: glyph outlines through Core Text, for faces fontkit cannot read (Apple's hvgl variable glyphs,
// such as the PingFang UI faces the macOS interface draws Han in).
//
// Usage: ct-outlines <PostScript name> [--info]          (code points in hex on stdin)
//        ct-outlines --via ui|sans|serif <hex> [--info]   the face Core Text falls back to for that code point when
//                                                          the UI font, Helvetica or Times lacks it: hidden UI faces
//                                                          cannot be opened by name (Core Text substitutes Times)
// --info prints the header, then every code point the face maps.
// --layout reads strings instead (one per line) and prints each as Core Text sets it in the face (kerning, ligatures,
// tracking): the string, the typographic width and the whole line's path, in font units; "!" as the path when Core
// Text falls back to another face for any of it.
//
// A face opened --via stays at the size Core Text chose it for (13 pt for the UI, 16 for pages): asked for at another
// size, Core Text may pick another optical cut (at 1,028 pt the PingFang UI Text face becomes the Display face).
// Coordinates, advances and metrics are scaled to font units (units per em / size); faces opened by name are opened at
// size = units per em, so no scaling is needed.
// The font is opened at a size equal to its units per em, so coordinates come out in font units. Output per code point:
// hex code point, advance, then the path as fontkit-style commands: M x y | L x y | Q x1 y1 x y | C x1 y1 x2 y2 x y | Z,
// space-separated. A first line gives "#", the PostScript name Core Text opened, and units per em.
import CoreText
import Foundation

var args = Array(CommandLine.arguments.dropFirst())
let probe: CTFont
var scale: CGFloat = 1
if args[0] == "--via" {
    let bases: [String: CTFont] = ["ui": CTFontCreateUIFontForLanguage(.system, 13, nil)!, "sans": CTFontCreateWithName("Helvetica" as CFString, 16, nil),
                                   "serif": CTFontCreateWithName("Times" as CFString, 16, nil)]
    let s = String(Character(Unicode.Scalar(UInt32(args[2], radix: 16)!)!)) as CFString
    probe = CTFontCreateForString(bases[args[1]]!, s, CFRange(location: 0, length: CFStringGetLength(s)))
    args.removeFirst(3)
    scale = CGFloat(CTFontGetUnitsPerEm(probe)) / CTFontGetSize(probe)
} else {
    let named = CTFontCreateWithName(args[0] as CFString, 12, nil)
    probe = CTFontCreateWithName(args[0] as CFString, CGFloat(CTFontGetUnitsPerEm(named)), nil)
    args.removeFirst()
}
let upm = CGFloat(CTFontGetUnitsPerEm(probe))
let font = probe
var toUnits = CGAffineTransform(scaleX: scale, y: scale)
print("#\t\(CTFontCopyPostScriptName(font) as String)\t\(Int(upm))\t\(Double(CTFontGetAscent(font) * scale))\t\(Double(CTFontGetDescent(font) * scale))")
if args.first == "--info" {
    let set = CTFontCopyCharacterSet(font) as CharacterSet
    var cps: [String] = []
    for plane in 0...16 where set.hasMember(inPlane: UInt8(plane)) {
        for v in UInt32(plane << 16)...UInt32((plane << 16) | 0xFFFF) {
            if let sc = Unicode.Scalar(v), set.contains(sc) { cps.append(String(v, radix: 16)) }
        }
    }
    print(cps.joined(separator: " "))
    exit(0)
}
func f(_ v: CGFloat) -> String { String(Double(v)) }
func commands(_ path: CGPath, into cmds: inout [String]) {
    path.applyWithBlock { el in
        let p = el.pointee.points
        switch el.pointee.type {
        case .moveToPoint: cmds.append("M \(f(p[0].x)) \(f(p[0].y))")
        case .addLineToPoint: cmds.append("L \(f(p[0].x)) \(f(p[0].y))")
        case .addQuadCurveToPoint: cmds.append("Q \(f(p[0].x)) \(f(p[0].y)) \(f(p[1].x)) \(f(p[1].y))")
        case .addCurveToPoint: cmds.append("C \(f(p[0].x)) \(f(p[0].y)) \(f(p[1].x)) \(f(p[1].y)) \(f(p[2].x)) \(f(p[2].y))")
        case .closeSubpath: cmds.append("Z")
        @unknown default: break
        }
    }
}
if args.first == "--layout" {
    let name = CTFontCopyPostScriptName(font) as String
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        let attr = NSAttributedString(string: line, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
        let ctLine = CTLineCreateWithAttributedString(attr)
        var cmds: [String] = []
        var fellBack = false
        for run in CTLineGetGlyphRuns(ctLine) as! [CTRun] {
            let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
            if (CTFontCopyPostScriptName(runFont) as String) != name { fellBack = true; break }
            let n = CTRunGetGlyphCount(run)
            var glyphs = [CGGlyph](repeating: 0, count: n)
            var positions = [CGPoint](repeating: .zero, count: n)
            CTRunGetGlyphs(run, CFRange(location: 0, length: n), &glyphs)
            CTRunGetPositions(run, CFRange(location: 0, length: n), &positions)
            for i in 0..<n {
                var t = CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: positions[i].x * scale, ty: positions[i].y * scale)
                if let path = CTFontCreatePathForGlyph(runFont, glyphs[i], &t) { commands(path, into: &cmds) }
            }
        }
        let width = CGFloat(CTLineGetTypographicBounds(ctLine, nil, nil, nil)) * scale
        print("\(line)\t\(f(width))\t\(fellBack ? "!" : cmds.joined(separator: " "))")
    }
    exit(0)
}
while let line = readLine() {
    guard let cp = UInt32(line, radix: 16), let scalar = Unicode.Scalar(cp) else { continue }
    var chars = Array(String(Character(scalar)).utf16)
    var glyphs = [CGGlyph](repeating: 0, count: chars.count)
    guard CTFontGetGlyphsForCharacters(font, &chars, &glyphs, chars.count), glyphs[0] != 0 else { continue }
    var adv = CGSize.zero
    CTFontGetAdvancesForGlyphs(font, .horizontal, [glyphs[0]], &adv, 1)
    var cmds: [String] = []
    if let path = CTFontCreatePathForGlyph(font, glyphs[0], &toUnits) {
        path.applyWithBlock { el in
            let p = el.pointee.points
            switch el.pointee.type {
            case .moveToPoint: cmds.append("M \(f(p[0].x)) \(f(p[0].y))")
            case .addLineToPoint: cmds.append("L \(f(p[0].x)) \(f(p[0].y))")
            case .addQuadCurveToPoint: cmds.append("Q \(f(p[0].x)) \(f(p[0].y)) \(f(p[1].x)) \(f(p[1].y))")
            case .addCurveToPoint: cmds.append("C \(f(p[0].x)) \(f(p[0].y)) \(f(p[1].x)) \(f(p[1].y)) \(f(p[2].x)) \(f(p[2].y))")
            case .closeSubpath: cmds.append("Z")
            @unknown default: break
            }
        }
    }
    print("\(line)\t\(f(adv.width * scale))\t\(cmds.joined(separator: " "))")
}
