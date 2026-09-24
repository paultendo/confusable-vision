# confusable-vision lookalikes, release 2026.09.24

Which Unicode characters look alike, measured by RaySpace: rays cast through each glyph's outline (36 angles, 50 rays
each, 128px grid) and compared twice, once for shape and once anchored to the baseline, so the size and position each
glyph has in running text count. Method and
the tests behind it: docs/metric-calibration.md in the repository.

Licence: CC-BY-4.0. Attribution: confusable-vision, Paul Wood FRSA (@paultendo).

This release replaces the March 2026 measurements, which were blind to size and under-counted shape differences.

## Files

| File | Rows | One row per |
|---|---|---|
| `characters.jsonl.gz` | 23,038 | code point measured |
| `lookalikes.jsonl.gz` | 857 | pair found alike: 409 within one font, 448 across fonts |

`SHA256SUMS` covers all three. Pin the release by its version.

### characters.jsonl.gz

| Field | Meaning |
|---|---|
| `codepoint`, `char`, `name`, `script`, `generalCategory` | the character, from the Unicode Character Database |
| `identifierType` | TR39 Identifier_Type (IdentifierType.txt dated 2024-08-14,) |
| `idna2008` | status in the IDNA mapping table: `valid`, `mapped`, `disallowed` and so on |
| `registrableAt` | TLDs whose registry tables accept it at the second level: .com, .net, .org, .info, .co, .biz, .xyz, .app, .dev, .jp (IANA IDN tables, fetched 2026-09-24). Lowercase ASCII letters and digits count everywhere |

### lookalikes.jsonl.gz

Every row has `a`, `b` (code points; look them up in `characters`), `method` and `alikeIn`.

**`method: "same font"`**: the two characters compared within each font that renders both. A font counts as alike
when the shape distance (rays across each glyph's own box) is below 0.5 and the baseline-anchored distance (rays
across a fixed em frame, both glyphs at one scale on one baseline) is below 0.2.

| Field | Meaning |
|---|---|
| `textFontsRenderingBoth`, `textFontsAlike`, `textShare` | over text fonts, leaving out handwriting, display and symbol faces |
| `fontsRenderingBoth`, `fontsAlike`, `share` | over all fonts |
| `meanDistanceWhereAlike`, `fontsAtZero` | the distances in the fonts where it is alike |
| `alikeIn` | those fonts |

**`method: "across fonts"`**: `a` drawn in its own fonts (the fallback a browser would use) against the ASCII
letter or digit `b` in a reference text font (Roboto and 20 common faces). A combination counts when `a` is at least as
close to `b` as `b` usually is to itself in another reference font, in shape and in size, `b` is the nearest ASCII
letter or digit to it, and the distance is at most 0.98.

| Field | Meaning |
|---|---|
| `combinations`, `alike`, `share` | font combinations compared, alike, and the fraction |
| `alikeIn` | up to six of them, as "fallback font vs reference font" |

## What was compared, and what an absent pair means

Fonts: every macOS system font and Roboto (the Android build). Within one font:

- every pair of characters from different scripts among the twelve March script sets (Latin A-Z, a-z, 0-9; Cyrillic;
  Greek; Arabic; Han; Hangul jamo; Katakana; Hiragana; Devanagari; Thai; Georgian; Armenian);
- every letter, mark or number that at least one of the ten TLDs' registry tables accepts (except Han, Hangul and kana)
  against the 62 ASCII letters and digits, and those against one another;
- every Roboto letter or digit against every other from a different script, and against the ASCII letters and digits.

Across fonts: every character none of the reference fonts renders, from that registrable set, against the 62 ASCII
letters and digits.

A pair inside these populations that is absent was compared and not found alike. Anything outside them, such as two
non-ASCII characters compared across fonts or same-script pairs within the twelve sets, was not compared.

## Suggested thresholds

The tests in docs/metric-calibration.md support: within one font, alike in at least 3 text fonts (or in all of them,
when fewer than 3 render both) and at least 5% of the text fonts rendering both; across fonts, alike in at least 3
combinations and at least 10% of them. `src/thresholds.ts` implements this.

## Views

- **IDN-relevant** (`scripts/export-idn-pairs.ts`): lookalikes at those thresholds whose characters can both be
  registered at one of the ten TLDs, with where.

## Changes

- 2026.09.24: first release. Release 2 scoring: size and baseline, linear shape differences, shares over text fonts,
  Roboto, and comparisons across fonts.
