// macos-fallback.swift
//
// For each code point (hex, one per line on stdin): the font macOS draws it with when the base font is the system UI
// font (CoreText's own fallback choice), and the glyph outline exactly as CoreText gives it. One JSON line per
// character, with the outline in font units in fontkit's command format, so the signature code can use it directly.
// Characters that only LastResort can draw are marked "drawable": false.
//
// Build: swiftc -O scripts/macos-fallback.swift -o macos-fallback
// Usage: ./macos-fallback < codepoints.txt > macos-outlines.jsonl
import CoreText
import Foundation

let base = CTFontCreateUIFontForLanguage(.system, 16, nil)!

func outline(_ font: CTFont, _ glyph: CGGlyph, scale: CGFloat) -> [[Any]] {
  guard let path = CTFontCreatePathForGlyph(font, glyph, nil) else { return [] }
  var out: [[Any]] = []
  path.applyWithBlock { el in
    let p = el.pointee.points
    let s = { (i: Int) -> [Double] in [Double(p[i].x * scale), Double(p[i].y * scale)] }
    switch el.pointee.type {
    case .moveToPoint: out.append(["moveTo"] + s(0))
    case .addLineToPoint: out.append(["lineTo"] + s(0))
    case .addQuadCurveToPoint: out.append(["quadraticCurveTo"] + s(0) + s(1))
    case .addCurveToPoint: out.append(["bezierCurveTo"] + s(0) + s(1) + s(2))
    case .closeSubpath: out.append(["closePath"])
    @unknown default: break
    }
  }
  return out
}

while let line = readLine() {
  let hex = line.trimmingCharacters(in: .whitespaces)
  guard let cp = UInt32(hex, radix: 16), let scalar = Unicode.Scalar(cp) else { continue }
  let str = String(Character(scalar))
  let s = str as CFString
  let found = CTFontCreateForString(base, s, CFRange(location: 0, length: CFStringGetLength(s)))
  let family = CTFontCopyFamilyName(found) as String
  let upem = CGFloat(CTFontGetUnitsPerEm(found))
  // Work at a size of one em in font units, so coordinates come out in font units
  let font = CTFontCreateCopyWithAttributes(found, upem, nil, nil)
  var chars = Array(str.utf16)
  var glyphs = [CGGlyph](repeating: 0, count: chars.count)
  let has = CTFontGetGlyphsForCharacters(font, &chars, &glyphs, chars.count) && family != ".LastResort"
  var advance = CGSize.zero
  CTFontGetAdvancesForGlyphs(font, .horizontal, &glyphs, &advance, 1)
  let record: [String: Any] = [
    "cp": hex, "family": family, "postscript": CTFontCopyPostScriptName(found) as String, "drawable": has,
    "unitsPerEm": Double(upem), "ascent": Double(CTFontGetAscent(font)), "descent": -Double(CTFontGetDescent(font)),
    "advance": Double(advance.width), "commands": has ? outline(font, glyphs[0], scale: 1) : [],
  ]
  let data = try! JSONSerialization.data(withJSONObject: record)
  print(String(data: data, encoding: .utf8)!)
}
