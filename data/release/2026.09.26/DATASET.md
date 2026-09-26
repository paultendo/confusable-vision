# confusable-vision lookalikes, release 2026.09.26

Which Unicode characters look like which, measured from the fonts' outlines. Each glyph is measured by RaySpace (rays
cast through its outline, 36 angles, 50 rays each, 128px grid) twice: once in its own box, for shape, and once in a
fixed frame on the baseline, so the size and position a glyph has in running text count. The lookalikes of ASCII
letters, digits and two-letter sequences are then checked in place: set between neighbouring letters in common fonts
at the size people read them, and compared with pairs everyone accepts as alike (0 and O, 1 and l, I and l).

Licence: CC-BY-4.0. Attribution: confusable-vision, Paul Wood FRSA (@paultendo).

This release replaces release 2 (2026.09.24 and 2026.09.25), which compared only the pairs and fonts earlier runs had
compared: see Changes.

## Files

| File | Rows | One row per |
|---|---|---|
| `characters.jsonl.gz` | 64,751 | code point measured |
| `lookalikes.jsonl.gz` | 12,074 | pair alike in at least one font or combination: 9,841 within one font (5,092 pass the suggested thresholds), 2,233 across fonts (1,172 pass) |
| `sequences.jsonl.gz` | 719 | character alike to a two-character ASCII sequence |
| `in-place.jsonl.gz` | 3,055 | candidate lookalike of an ASCII letter, digit or sequence, checked in place: strict 646, broad 358, design 101, not alike 1,950 |

`SHA256SUMS` covers all five. Pin the release by its version.

### characters.jsonl.gz

| Field | Meaning |
|---|---|
| `codepoint`, `char`, `name`, `script`, `generalCategory` | the character, from the Unicode Character Database |
| `identifierType` | TR39 Identifier_Type (IdentifierType.txt dated 2024-08-14,) |
| `idna2008` | status in the IDNA mapping table: `valid`, `mapped`, `disallowed` and so on |
| `registrableAt` | TLDs whose registry accepts it at the second level, out of all 1403 with known rules (data/input/tld-rules.json: IANA IDN tables fetched 2026-09-24, the ICANN rule for generic TLDs without tables, and researched country-code policies). Lowercase ASCII letters and digits count everywhere |

### lookalikes.jsonl.gz

Every row has `a`, `b` (code points; look them up in `characters`), `method` and `alikeIn`.

**`method: "same font"`**: the two characters compared within each font that draws both. A font counts as alike
when the shape distance is below 0.5 and the baseline-anchored distance below 0.2 (the lower of the distance with the
glyphs centred on their advance and centred on their ink).

| Field | Meaning |
|---|---|
| `textFontsRenderingBoth`, `textFontsAlike`, `textShare` | over text fonts, leaving out handwriting, display and symbol faces |
| `fontsRenderingBoth`, `fontsAlike`, `share` | over all fonts |
| `meanDistanceWhereAlike`, `fontsAtZero` | the mean shape distance where alike, and the fonts where both distances are 0 |
| `alikeIn`, `distances` | those fonts, and in each the shape and baseline-anchored distances |

**`method: "across fonts"`**: `a` in its own font (the fallback a browser would use) against the ASCII letter or
digit `b` in a page font that lacks `a`. A combination counts when `b` is the nearest ASCII letter or digit to `a`,
and `a` is at least as close to `b` as `b` is to itself in the upper quartile of the other page fonts, in shape and
in size, with a distance of at most 0.98. The bar depends only on the page fonts, so adding
fonts to the survey does not move it.

| Field | Meaning |
|---|---|
| `combinations`, `alike`, `share` | font combinations compared, alike, and the fraction |
| `minDistance` | the closest combination |
| `alikeIn` | up to six combinations, as "fallback font vs page font distance" |
| `macosActual` | the same test with the fallback font macOS actually uses |

### sequences.jsonl.gz

`a` is a code point and `b` a two-character ASCII sequence, as a string. Every sequence of two ASCII letters or
digits (3,844) is set as the font sets it, with its kerning and ligatures (Core Text; HarfBuzz sets them identically
apart from the system font's tracking), and compared like a character. Within one font, the same fields as
lookalikes; across fonts, a sequence is held to the stricter bar of its two letters.

### in-place.jsonl.gz

Every lookalike of an ASCII letter, digit or two-letter sequence found by the measurements above (as a candidate,
whether or not it passes the thresholds) is set between neighbouring letters (`pa_nel`, `20_5`) as Core Text draws
it, with the platform's font fallback, in five contexts: the system font at 13 px, and Helvetica, Arial, Times New
Roman and Georgia at 16 px, each at a device pixel ratio of 1 and 2. Nothing is rescaled: the lookalike is compared
where it lands in the line.

| Field | Meaning |
|---|---|
| `a`, `b` | the character (code point) and the letter, digit or sequence it was tested against |
| `found` | which measurement proposed it: `same font`, `across fonts`, a sequence, or `Unicode (ASCII)` for the ASCII pairs confusables.txt lists (1 and l, 0 and O, m and rn), checked the same way |
| `tier` | the best verdict in any context: `strict`, `broad`, `design` or `no` |
| `contexts[]` | per context: `faces` used, `distance` and the bars (`anchor`, `anchorBroad`), `ink` (top, bottom and width against the letter's, em), `gaps` to the neighbours, `reordered`, and `dpr1`, `dpr2`: `verdict`, the checks that `failed`, and for `design` the fonts whose letter it matches |

Verdicts:

- **strict**: as alike as the median of the accepted pairs (0/O, 1/l, I/l) in that context, each counted only where
  the context draws it at the same size and position; and passes every check below.
- **broad**: as alike as the least alike accepted pair, with one corner allowed to differ and no slant check.
- **design**: not strict against this font's letter, but alike to the letter as another common font draws it, scaled
  to this letter's height and baseline (a barred J in a line whose J has no bar).

Checks, on the lookalike and the letter rasterised at 4 times the device resolution: the same number of pieces and
holes once gaps narrower than a device pixel close; counters square or round alike, and in the same place and of
about the same size; the spacing to the neighbours (within 0.12 em); the ink's top, bottom (0.12 em) and width (0.2
em); the neighbours not reordered (right-to-left characters pull digits round them); stroke weight (within a ratio of
1.25); the shape of each side (mirrored or straight against curved); how far the ink reaches into each corner (0.06
em); slant; a stem in the middle (Y against V); and a bar crossing a stem (Ŧ against T). A two-letter sequence is
checked letter by letter, each letter's share of the lookalike against that letter.

## What was compared, and what an absent pair means

322 fonts: every family on macOS (including the ones in AssetsV2, such as PingFang), Roboto, Noto Sans, Noto Serif,
Noto Sans CJK and DejaVu, each in the face a browser uses for body text.

- Within one font: every pair of letters and digits (General_Category L or N) the font draws, Han and Hangul included.
- Across fonts: every letter and digit of every text font against the 62 ASCII letters and digits of each of 26 page
  fonts that lacks it.
- Sequences: every character of each font against the 3,844 two-character ASCII sequences as that font sets them,
  and across fonts against the sequences of the page fonts.
- In place: every candidate lookalike of an ASCII letter, digit or sequence from those measurements.

A pair inside these populations that is absent was compared and not found alike. Pairs of two non-ASCII characters in
different fonts were not compared.

## Suggested thresholds

For a yes or no on an ASCII lookalike, use the in-place `tier`: `strict` for reports and submissions, `broad` (or
`design`) for defences, where a missed lookalike costs more than an extra entry. For other pairs, the tests in
docs/metric-calibration.md support: within one font, alike in at least 3 text fonts (or in all of them, when fewer than
3 draw both) and at least 5% of the text fonts drawing both; across fonts, alike in at least 3 combinations and at
least 10% of them. `src/thresholds.ts` implements this.

Reference data: Unicode confusables.txt 2026-08-06, 01:05:35 GMT (for comparison only; the measurements do not use it).

## Changes

- 2026.09.26: release 3. Release 2 compared only the pairs and fonts earlier runs had compared, and missed most
  letters (Yi, Canadian Aboriginal, Ethiopic, the Indic scripts and others), the script-only fonts, and the right face
  of several font collections. This release compares every letter and digit each font draws, in 322 fonts. Also:
  overlapping contours (as in variable fonts) measured as the union of their strokes; the cross-font bar set by the
  upper quartile of the page fonts; two-letter sequences as the font sets them; and the in-place check.
- 2026.09.25: `registrableAt` covers every TLD with known registry rules, not ten.
- 2026.09.24: release 2. Size and baseline, linear shape differences, shares over text fonts, Roboto, and comparisons
  across fonts.
