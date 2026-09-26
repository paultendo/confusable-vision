// resolve-faces.swift: for each family on stdin, the face a browser on this Mac draws body text in.
//
// Core Text lists the family's faces; the choice follows CSS font matching for font-weight 400, font-style normal,
// font-stretch normal: upright faces first, then the width nearest normal, then weight 400 if present, else 500, else
// the nearest lighter weight, else the nearest heavier. Faces Core Text gives the same weight are told apart by style
// name, Regular, Book, Roman, Text, Plain or W3 first (Bodoni 72 Oldstyle's Bold and Book both carry weight 0, and
// Core Text's own default for the bare family name is the Bold). Core Text weights run -1..1 with 0 as regular; they are
// mapped to CSS weights through the usual table (-0.4 light 300, 0 regular 400, 0.23 medium 500, 0.3 semibold 600,
// 0.4 bold 700).
//
// Output, tab-separated: family, chosen family name, PostScript name, CSS weight, file path ("-" when Core Text has no
// such family).
import CoreText
import Foundation

func cssWeight(_ w: Double) -> Double {
    let table: [(Double, Double)] = [(-0.8, 100), (-0.6, 200), (-0.4, 300), (0, 400), (0.23, 500), (0.3, 600), (0.4, 700), (0.56, 800), (0.62, 900)]
    if w <= table.first!.0 { return table.first!.1 }
    if w >= table.last!.0 { return table.last!.1 }
    for i in 0..<(table.count - 1) where w >= table[i].0 && w <= table[i + 1].0 {
        let (a, b) = (table[i], table[i + 1])
        return a.1 + (w - a.0) / (b.0 - a.0) * (b.1 - a.1)
    }
    return 400
}

while let family = readLine() {
    let desc = CTFontDescriptorCreateWithAttributes([kCTFontFamilyNameAttribute: family] as CFDictionary)
    let faces = (CTFontDescriptorCreateMatchingFontDescriptors(desc, NSSet(object: kCTFontFamilyNameAttribute)) as? [CTFontDescriptor]) ?? []
    struct Face { let ps: String; let fam: String; let path: String; let weight: Double; let width: Double; let italic: Bool; let style: String }
    let all: [Face] = faces.compactMap { d in
        guard let ps = CTFontDescriptorCopyAttribute(d, kCTFontNameAttribute) as? String,
              let fam = CTFontDescriptorCopyAttribute(d, kCTFontFamilyNameAttribute) as? String, fam == family,
              let url = CTFontDescriptorCopyAttribute(d, kCTFontURLAttribute) as? URL else { return nil }
        let traits = (CTFontDescriptorCopyAttribute(d, kCTFontTraitsAttribute) as? NSDictionary) ?? [:]
        let symbolic = (traits[kCTFontSymbolicTrait] as? NSNumber)?.uint32Value ?? 0
        let slant = (traits[kCTFontSlantTrait] as? NSNumber)?.doubleValue ?? 0
        let style = CTFontDescriptorCopyAttribute(d, kCTFontStyleNameAttribute) as? String ?? ""
        return Face(ps: ps, fam: fam, path: url.path, weight: cssWeight((traits[kCTFontWeightTrait] as? NSNumber)?.doubleValue ?? 0),
                    width: (traits[kCTFontWidthTrait] as? NSNumber)?.doubleValue ?? 0,
                    italic: symbolic & CTFontSymbolicTraits.traitItalic.rawValue != 0 || slant != 0, style: style)
    }
    if all.isEmpty { print([family, "-", "-", "-", "-"].joined(separator: "\t")); continue }
    let upright = all.filter { !$0.italic }.isEmpty ? all : all.filter { !$0.italic }
    let bestWidth = upright.map { abs($0.width) }.min()!
    let normal = upright.filter { abs($0.width) == bestWidth }
    func rank(_ w: Double) -> (Int, Double) {
        if abs(w - 400) < 25 { return (0, abs(w - 400)) }
        if abs(w - 500) < 25 { return (1, 0) }
        if w < 400 { return (2, 400 - w) }
        return (3, w - 400)
    }
    let regularName = { (f: Face) -> Int in ["Regular", "Book", "Roman", "Text", "Plain", "W3"].contains(f.style) ? 0 : 1 }
    let chosen = normal.min { a, b in
        let (ra, rb) = (rank(a.weight), rank(b.weight))
        if ra != rb { return ra < rb }
        if regularName(a) != regularName(b) { return regularName(a) < regularName(b) }
        return a.ps < b.ps
    }!
    print([family, chosen.fam, chosen.ps, String(format: "%.0f", chosen.weight), chosen.path].joined(separator: "\t"))
}
