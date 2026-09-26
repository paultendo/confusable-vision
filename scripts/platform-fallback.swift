// platform-fallback.swift: for each code point on stdin (hex), the face macOS actually draws it in when the requested
// font lacks it, as Core Text resolves it (CTFontCreateForString, which WebKit and Chrome on macOS also use for
// fallback). Three starting fonts: the system UI font (menus, dialogs, Safari's address bar) and the default web page
// fonts, Helvetica (sans-serif) and Times (serif).
//
// Usage: swift scripts/platform-fallback.swift [PostScript name ...]   (code points in hex on stdin)
// With no names, the three starting fonts are ui, Helvetica and Times; otherwise each name is a starting font ("ui"
// for the system UI font), for the cross-font test's page fonts.
//
// Output, tab-separated: code point, then for each starting font: PostScript name and file ("-" when nothing draws it).
import CoreText
import Foundation

let names = CommandLine.arguments.count > 1 ? Array(CommandLine.arguments.dropFirst()) : ["ui", "Helvetica", "Times"]
let bases: [CTFont] = names.map { $0 == "ui" ? CTFontCreateUIFontForLanguage(.system, 13, nil)! : CTFontCreateWithName($0 as CFString, 16, nil) }
for (n, b) in zip(names, bases) where n != "ui" && (CTFontCopyPostScriptName(b) as String) != n {
    FileHandle.standardError.write("platform-fallback: \(n) opened as \(CTFontCopyPostScriptName(b))\n".data(using: .utf8)!)
}
while let line = readLine() {
    guard let cp = UInt32(line, radix: 16), let scalar = Unicode.Scalar(cp) else { continue }
    let s = String(Character(scalar)) as CFString
    var out = [line]
    for base in bases {
        let f = CTFontCreateForString(base, s, CFRange(location: 0, length: CFStringGetLength(s)))
        var glyphs = [CGGlyph](repeating: 0, count: 2)
        var chars = [UniChar](String(Character(scalar)).utf16)
        let drawn = CTFontGetGlyphsForCharacters(f, &chars, &glyphs, chars.count)
        if !drawn { out += ["-", "-"]; continue }
        out += [CTFontCopyPostScriptName(f) as String, (CTFontCopyAttribute(f, kCTFontURLAttribute) as? URL)?.path ?? "?"]
    }
    print(out.joined(separator: "\t"))
}
