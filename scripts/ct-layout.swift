// ct-layout.swift: how Core Text sets short strings in one font, for checking the sequence layouts score-all.ts builds.
//
// Usage: ct-layout <PostScript name> < strings (one per line)
// Output per string: the string, then for each glyph "glyphID@x,y" in font units, then the typographic width, tab
// separated. Core Text applies the font's default features (kerning and ligatures, AAT or OpenType), as Safari and
// macOS text do.
import Foundation
import CoreText

// "System Font" is the UI font at 17 pt (score-all.ts instances SF at opsz 17, TEXT_OPSZ); a second argument is the
// font file, for fonts that are not installed.
//
// --paths [--size N]: instead, each string's whole outline as Core Text draws it at N points (default 16), falling back
// to other faces as the platform does (an address bar, a mail client): per string, the string, the typographic width,
// the faces used, and the path in em units (y up, baseline at 0), tab separated. This is the in-place comparison's input.
var cli = Array(CommandLine.arguments.dropFirst())
let pathsMode = cli.contains("--paths")
var pathSize: CGFloat = 16
if let i = cli.firstIndex(of: "--size") { pathSize = CGFloat(Double(cli[i + 1])!); cli.remove(at: i + 1); cli.remove(at: i) }
cli.removeAll { $0 == "--paths" }
var name = cli[0]
var size: CGFloat = pathsMode ? pathSize : 1000
var font: CTFont
if name == "System Font" {
    size = pathsMode ? pathSize : 17
    font = CTFontCreateUIFontForLanguage(.system, size, nil)!
    name = CTFontCopyPostScriptName(font) as String
} else if cli.count > 1 {
    let descs = CTFontManagerCreateFontDescriptorsFromURL(URL(fileURLWithPath: cli[1]) as CFURL) as? [CTFontDescriptor] ?? []
    guard let d = descs.first(where: { (CTFontDescriptorCopyAttribute($0, kCTFontNameAttribute) as? String) == name }) ?? descs.first else {
        FileHandle.standardError.write("no font in \(cli[1])\n".data(using: .utf8)!); exit(1)
    }
    font = CTFontCreateWithFontDescriptor(d, size, nil)
    name = CTFontCopyPostScriptName(font) as String
} else {
    font = CTFontCreateWithName(name as CFString, size, nil)
}
let upm = CGFloat(CTFontGetUnitsPerEm(font))
if (CTFontCopyPostScriptName(font) as String) != name {
    FileHandle.standardError.write("no font \(name)\n".data(using: .utf8)!)
    exit(1)
}
let scale = upm / size
func fmt(_ v: CGFloat) -> String { String(format: "%.5f", Double(v)) }
if pathsMode {
    // em units: 1 / size per point
    let em = 1 / size
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        let attr = NSAttributedString(string: line, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
        let ctLine = CTLineCreateWithAttributedString(attr)
        var glyphParts: [String] = []
        var faces: [String] = []
        for run in CTLineGetGlyphRuns(ctLine) as! [CTRun] {
            let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
            let ps = CTFontCopyPostScriptName(runFont) as String
            if !faces.contains(ps) { faces.append(ps) }
            let n = CTRunGetGlyphCount(run)
            var glyphs = [CGGlyph](repeating: 0, count: n)
            var positions = [CGPoint](repeating: .zero, count: n)
            CTRunGetGlyphs(run, CFRange(location: 0, length: n), &glyphs)
            CTRunGetPositions(run, CFRange(location: 0, length: n), &positions)
            var advances = [CGSize](repeating: .zero, count: n)
            CTRunGetAdvances(run, CFRange(location: 0, length: n), &advances)
            for i in 0..<n {
                var cmds: [String] = []
                var t = CGAffineTransform(a: em, b: 0, c: 0, d: em, tx: positions[i].x * em, ty: positions[i].y * em)
                defer { glyphParts.append("\(fmt(positions[i].x * em)),\(fmt(advances[i].width * em)),\(ps):\(cmds.joined(separator: " "))") }
                guard let path = CTFontCreatePathForGlyph(runFont, glyphs[i], &t) else { continue }
                path.applyWithBlock { el in
                    let p = el.pointee.points
                    switch el.pointee.type {
                    case .moveToPoint: cmds.append("M \(fmt(p[0].x)) \(fmt(p[0].y))")
                    case .addLineToPoint: cmds.append("L \(fmt(p[0].x)) \(fmt(p[0].y))")
                    case .addQuadCurveToPoint: cmds.append("Q \(fmt(p[0].x)) \(fmt(p[0].y)) \(fmt(p[1].x)) \(fmt(p[1].y))")
                    case .addCurveToPoint: cmds.append("C \(fmt(p[0].x)) \(fmt(p[0].y)) \(fmt(p[1].x)) \(fmt(p[1].y)) \(fmt(p[2].x)) \(fmt(p[2].y))")
                    case .closeSubpath: cmds.append("Z")
                    @unknown default: break
                    }
                }
            }
        }
        let width = CGFloat(CTLineGetTypographicBounds(ctLine, nil, nil, nil)) * em
        // Per glyph: its x, advance and face, then its path (em, placed): "x,advance,face:path | ..."
        print([line, fmt(width), faces.joined(separator: ","), glyphParts.joined(separator: " | ")].joined(separator: "\t"))
    }
    exit(0)
}
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    let attr = NSAttributedString(string: line, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
    let ctLine = CTLineCreateWithAttributedString(attr)
    var parts: [String] = []
    for run in CTLineGetGlyphRuns(ctLine) as! [CTRun] {
        let n = CTRunGetGlyphCount(run)
        var glyphs = [CGGlyph](repeating: 0, count: n)
        var positions = [CGPoint](repeating: .zero, count: n)
        CTRunGetGlyphs(run, CFRange(location: 0, length: n), &glyphs)
        CTRunGetPositions(run, CFRange(location: 0, length: n), &positions)
        let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
        let fallback = (CTFontCopyPostScriptName(runFont) as String) != name
        for i in 0..<n {
            parts.append(String(format: "%@%d@%.1f,%.1f", fallback ? "!" : "", glyphs[i], positions[i].x * scale, positions[i].y * scale))
        }
    }
    let width = CTLineGetTypographicBounds(ctLine, nil, nil, nil) * Double(scale)
    print([line, parts.joined(separator: " "), String(format: "%.1f", width)].joined(separator: "\t"))
}
