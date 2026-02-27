# confusable-vision: Technical Report

**Visual similarity scoring of Unicode confusables across 230 macOS system fonts**

Paul Wood FRSA (@paultendo) -- 27 February 2026

---

## 1. Executive summary

confusable-vision renders Unicode character pairs across all macOS system fonts,
measures visual similarity using SSIM and pHash, and produces per-font scored
JSON artifacts. This report covers four analyses:

- **Milestone 1b** -- validation of 1,418 pairs from Unicode TR39
  confusables.txt across 230 system fonts (235,625 SSIM comparisons).
  Scope: single-codepoint-to-single-codepoint mappings with targets
  restricted to Latin a-z and digits 0-9 (SL mapping type only).
  Multi-character and non-Latin-target mappings are excluded.
- **Milestone 2** -- novel confusable discovery by scanning 23,317
  identifier-safe Unicode characters not in confusables.txt against Latin
  a-z/0-9 across 230 fonts (2,904,376 SSIM comparisons).
- **Milestone 2b** -- cross-script scan of 122,862 CJK/Hangul/logographic
  codepoints against Latin a-z/0-9 (8,036,479 SSIM comparisons).
- **Milestone 5** -- cross-script confusable scanning across all 66 pairs
  from 12 ICANN-relevant scripts (22,581 characters, 23.6M SSIM
  comparisons). The first systematic empirical measurement of visual
  confusability between non-Latin scripts.

**Milestone 1b headline findings:**

- **96.5% of confusables.txt entries are not high-risk from a visual
  perspective.** Only 49 of 1,418 pairs (3.5%) score >= 0.7 mean SSIM across
  all fonts. The typical entry has a median SSIM of 0.322 -- not visually
  confusable at all.
- **Mean SSIM understates the threat; max same-font SSIM reveals it.** A pair
  like Cyrillic ԁ->d scores 0.781 mean across 18 fonts, but that obscures the
  fact that it is pixel-identical (1.000) in eight of them. The exploitable
  risk is the max, not the mean -- attackers need only one font to succeed.
- **82 pairs** are pixel-identical (SSIM = 1.000) in at least one font. These
  are not "similar" -- they are the *same glyph outlines*, making them
  undetectable by any visual inspection.
- **47 pairs** have negative mean SSIM, meaning the source and target look less
  alike than random noise. These are false positives in confusables.txt from a
  visual perspective.
- Same-font comparisons average 0.536 SSIM; cross-font comparisons average
  0.339. The font pairing matters as much as the character pairing.

**Milestone 2 headline findings:**

- **793 novel high-risk pairs discovered** (mean SSIM >= 0.7) that are NOT in
  TR39 confusables.txt, from 23,317 identifier-safe Unicode candidates.
- **47.5% of discoveries are vertical-stroke characters** ("l", "i", "j"
  lookalikes) from obscure scripts -- Pahawh Hmong, Nabataean, Duployan,
  Hatran, Mende Kikakui, and others.
- **Top discovery: U+A7FE LATIN EPIGRAPHIC LETTER I LONGA** scores 0.998 SSIM
  against "l" in Geneva -- near pixel-identical, and not in confusables.txt.
- **Notable cross-script finds**: Gothic U+10347 vs "x" (0.94), Coptic U+2CAD
  vs "x" (0.93), Javanese U+A9D0 vs "o" (0.96), Khmer U+17F4 vs "v" (0.93),
  NKo U+07D5 vs "b" (0.92).
- **96 distinct scripts/fonts** contribute novel confusables. The long tail of
  obscure scripts is where the gaps in TR39 coverage lie.

**Milestone 2b headline findings:**

- **28 novel confusable characters found** in CJK/Hangul/logographic ranges,
  producing 69 high-scoring pairs against Latin targets. All are simple
  geometric primitives: vertical strokes (18 characters), circles (3), and
  other minimal forms (7).
- **Top discovery: U+3021 HANGZHOU NUMERAL ONE** (〡) scores 0.928 SSIM
  against "l" -- a vertical stroke character present in 6 CJK fonts. Egyptian
  hieroglyphs and Cuneiform numerals contribute 32 of the 69 pairs but
  require specialised fonts rarely present on victim machines.
- **No complex ideographs are confusable.** The 76,891 characters in CJK
  Extensions A-I produced only 1 high-scoring pair. Hangul Syllables (11,172
  characters) produced zero. The dense 2D structure of logographic scripts is
  structurally incompatible with Latin letterforms.
- **99.6% of scored pairs score below 0.3 SSIM.** The overwhelming majority
  of these 122,862 codepoints look nothing like Latin, confirming the M2
  exclusion was a reasonable engineering trade-off.

**Milestone 5 headline findings:**

- **248 confusable pairs discovered between non-Latin scripts**, with no
  coverage in any existing standard. These span 33 script pair combinations
  including Arabic-Hangul, Thai-Devanagari, Georgian-Cyrillic, and
  Armenian-Han. No confusable map, detection tool, or variant bundling
  policy covers these pairs today.
- **315 additional discoveries in the Latin/Cyrillic/Greek triangle**
  confirm what TR39 already models transitively. 278 of these are
  pixel-identical in at least one font. These are not new to the security
  community, but M5 provides direct empirical SSIM evidence for each
  cross-script edge.
- **563 total cross-script discoveries** (mean SSIM >= 0.7) across 36 of
  66 script pairs, from 22,581 characters in 12 ICANN-relevant scripts
  (23.6M character pairs scored).
- **Top discovery: Hangul jamo U+1175 vs CJK U+4E28** (vertical stroke) at
  SSIM 0.999. The vertical stroke is the universal confusable primitive,
  appearing across 8 of 12 scripts.
- **30 of 66 script pairs produced zero discoveries**, providing empirical
  evidence for which script combinations can be safely allowed without
  cross-script confusable checks.

## 2. Methodology

### 2.1 Rendering pipeline

Characters are rendered in a two-stage pipeline:

1. **build-index.ts** -- renders all source and target characters as 48x48
   greyscale PNGs, one per font that natively contains the character.
2. **score-all-pairs.ts** (M1b) / **score-candidates.ts** (M2) -- loads the
   pre-built render index and computes SSIM scores for all valid source/target
   pairings.

The renderer uses node-canvas (Cairo backend) at 64x64, then normalises to
48x48 greyscale via sharp. Black text on white background, no colour, no
augmentation (consistent with Gupta et al. 2023, "GlyphNet", which found
greyscale outperforms colour for glyph comparison).

### 2.2 Why SSIM, not learned embeddings

SSIM was chosen over CNN-based approaches (e.g., GlyphNet's VGG16/ResNet
features) for a deliberate reason: **reproducibility without infrastructure**.
SSIM is a deterministic mathematical function -- no training data, no model
weights, no GPU, no framework dependencies. Anyone with fontconfig and
node-canvas can reproduce these exact numbers on the same platform.

Learned embeddings require a training corpus of labelled confusable/non-
confusable pairs, introduce model versioning concerns, and produce scores
that change when the model is retrained. SSIM scores are stable across runs
and across time. For a dataset intended to feed into security policy
(namespace-guard's risk scoring), determinism and auditability matter more
than marginal accuracy gains.

GlyphNet's attention-based CNN achieves ~0.93 AUC on character-level
confusability (Gupta et al. 2023, Table 3). The 63-67% figure refers to
transfer-learning with ImageNet-pretrained architectures (VGG16, ResNet),
not GlyphNet's best model. Our SSIM choice is motivated by determinism
and zero-infrastructure reproducibility, not by claiming higher accuracy
than learned approaches.

### 2.3 Font discovery

Rather than a hardcoded font list, confusable-vision auto-discovers all
macOS system fonts using fontconfig:

```
fc-list ':charset=61-7A' --format='%{file}|%{family[0]}\n'
```

This query returns every system font file containing Latin a-z. Fonts are
classified into categories:

| Category | Count | Purpose |
|----------|-------|---------|
| standard | 74 | Latin-primary fonts used for target rendering and same-font comparison |
| script | 49 | CJK, Indic, Thai, etc. fonts that also contain Latin glyphs |
| noto | 103 | Noto Sans variants for non-Latin scripts |
| math | 3 | STIX Two Math, STIX Two Text, STIXGeneral |
| symbol | 1 | Apple Symbols |
| **Total** | **230** | |

For .ttc (TrueType Collection) files with multiple families, only the primary
family is registered (face index 0, shortest family name) to avoid misleading
font-to-face mappings.

### 2.4 Fontconfig-targeted rendering

Instead of brute-force rendering every character in all 230 fonts (where
Pango would silently fall back for ~95%), we query fontconfig per-character:

```
fc-list ':charset=XXXX' file
```

This returns only fonts that natively contain each codepoint. The result:
8,881 targeted render jobs vs 326,140 brute-force -- a 97% reduction.

For the 77 characters with zero fontconfig coverage, a dynamic discovery
mechanism queries system fonts at runtime, registering previously unknown
fonts like NotoSerifAhom-Regular.

### 2.5 Comparison strategy

Two comparison modes capture different attack scenarios:

- **Same-font**: source and target both rendered in the same standard font.
  This applies when a font's glyph tables include both characters (e.g.,
  Cyrillic and Latin in Arial). Tests whether the font designer deliberately
  made them visually identical.

- **Cross-font**: source rendered in a supplemental font, target rendered in
  each standard font. This captures the realistic browser scenario where the
  OS picks a supplemental font (e.g., Noto Sans Tifinagh) for the exotic
  character while the page text stays in Arial.

A pHash prefilter at 0.2 threshold skips SSIM computation for pairs with
extremely different perceptual hashes (only 49 of 235,674 comparisons were
skipped, confirming the threshold is not overly aggressive).

### 2.6 Platform

- macOS 25.2.0 (darwin arm64)
- Node.js v20.19.4
- 230 fonts available / 233 discovered (3 failed to register)
- 11,370 total PNG renders
- 235,625 SSIM comparisons computed

## 3. Distribution

### 3.1 Overall

| Band | Count | % | Description |
|------|-------|---|-------------|
| High (>= 0.7) | 49 | 3.5% | Genuinely dangerous -- visually confusable |
| Medium (0.3-0.7) | 681 | 48.0% | Somewhat similar -- depends on font and context |
| Low (< 0.3) | 611 | 43.1% | Not visually confusable |
| No data | 77 | 5.4% | No system font covers the source character |
| **Total** | **1,418** | | |

- Median mean SSIM: **0.322**
- Mean of mean SSIMs: **0.326**
- Pairs with data: 1,341 (94.6%)

### 3.2 Same-font vs cross-font

| Mode | Comparisons | Mean SSIM |
|------|-------------|-----------|
| Same-font | 5,745 | 0.536 |
| Cross-font | 229,929 | 0.339 |
| **Total** | **235,674** | |

Same-font comparisons score 59% higher on average. This makes sense:
when a font designer includes both Cyrillic and Latin, the glyph outlines
are often intentionally harmonised or identical. Cross-font comparisons
mix different design philosophies.

### 3.3 Per-script breakdown

| Script/Block | Pairs | w/ data | Mean SSIM |
|-------------|-------|---------|-----------|
| Latin Extended | 45 | 30 | 0.572 |
| Hebrew | 5 | 5 | 0.471 |
| Cyrillic | 45 | 45 | 0.447 |
| Cherokee | 37 | 37 | 0.398 |
| Indic | 24 | 24 | 0.359 |
| Other SMP | 166 | 104 | 0.353 |
| Other BMP | 229 | 229 | 0.338 |
| Greek | 36 | 36 | 0.329 |
| Mathematical Alphanumeric Symbols | 806 | 806 | 0.302 |
| Arabic | 25 | 25 | 0.205 |

Latin Extended scores highest (0.572) because these are phonetic extensions
deliberately designed to resemble their Latin base forms. Mathematical
Alphanumeric Symbols (0.302) dominate the dataset (806 of 1,418 pairs) but
score low because ornate mathematical letterforms (script, fraktur,
double-struck) look nothing like plain Latin in a different font.

Arabic scores lowest (0.205) -- Arabic letterforms are structurally
different from Latin even when confusables.txt maps them as confusable.

## 4. Pixel-identical pairs

82 pairs have at least one font comparison with SSIM >= 0.999 (effectively
pixel-identical). These fall into distinct categories:

### 4.1 Cyrillic homoglyphs (the real threat)

The core Cyrillic lowercase confusables are pixel-identical across 30-44
standard fonts. These are the most dangerous confusables in Unicode:

| Source | Target | Identical in N fonts | Example fonts |
|--------|--------|---------------------|---------------|
| а (U+0430) | a | 40+ of 43 tested | Arial, Menlo, Cochin, Georgia, Tahoma, Verdana, Baskerville, Comic Sans MS, Courier New, Times New Roman, + 30 more |
| е (U+0435) | e | 40+ of 44 tested | Arial, Menlo, Cochin, Georgia, Tahoma, Verdana, Baskerville, Courier New, Times New Roman, + 30 more |
| о (U+043E) | o | 40+ of 43 tested | Arial, Menlo, Cochin, Geneva, Impact, Tahoma, Charter, Georgia, Verdana, + 30 more |
| р (U+0440) | p | 40+ of 46 tested | Arial, Menlo, Cochin, Impact, Tahoma, Charter, Georgia, Verdana, Avenir Next, Comic Sans MS, + 30 more |
| с (U+0441) | c | 40+ of 43 tested | Arial, Menlo, Cochin, Impact, Tahoma, Charter, Georgia, Verdana, Baskerville, Courier New, + 30 more |
| у (U+0443) | y | 35+ of 41 tested | Arial, Menlo, Impact, Tahoma, Charter, Georgia, Verdana, Baskerville, Marker Felt, Comic Sans MS, + 25 more |
| х (U+0445) | x | 40+ of 45 tested | Arial, Menlo, Cochin, Geneva, Impact, Monaco, Tahoma, Charter, Georgia, Verdana, + 30 more |

Every standard font that includes Cyrillic reuses the Latin glyph outlines
for these characters. This is not a rendering quirk -- it is a deliberate
font design decision. No visual inspection can distinguish these.

The practical implication: a string like "аpple.com" with Cyrillic а
(U+0430) is pixel-identical to "apple.com" in 40+ fonts. The user, the
browser's address bar, and any visual review process all see the same
pixels. This is the attack scenario that trust and safety teams care about,
and the data confirms it is not theoretical -- it is a measured property of
the font files shipping on every Mac.

The Cyrillic uppercase confusables (А, В, Е, Н, О, Р, С, Т, Х) are
pixel-identical in Phosphate and often near-identical in other fonts, but
have less coverage since fewer fonts include Cyrillic uppercase.

### 4.2 Greek confusables

| Source | Target | Identical in N fonts | Example fonts |
|--------|--------|---------------------|---------------|
| ο (U+03BF) | o | 40+ of 44 tested | Arial, Menlo, Cochin, Geneva, Impact, Tahoma, Charter, Georgia, Verdana, + 30 more |
| ρ (U+03C1) | p | 2 (Phosphate, Copperplate) | |
| ς (U+03F2) | c | 13 (Arial, Menlo, Times, Geneva, Tahoma, Seravek, Helvetica, Copperplate, + 5 more) | |
| ϳ (U+03F3) | j | 19 (Arial, Menlo, Times, Geneva, Tahoma, Charter, Seravek, Copperplate, + 11 more) | |

Greek omicron is as dangerous as Cyrillic о -- identical in 40+ fonts.
Greek rho (ρ->p) is pixel-identical only in Phosphate and Copperplate --
both geometric/all-caps fonts where the structural distinction between rho
and Latin p collapses. This is a font-specific risk, not a script-wide one.

### 4.3 Roman numerals (glyph reuse)

Roman numeral characters (U+2170-U+217F) are pixel-identical to their Latin
equivalents in 36 fonts. This is by design -- Unicode encodes them as
separate codepoints for compatibility, but fonts use the same glyph:

| Source | Target | Identical in N fonts |
|--------|--------|---------------------|
| ⅰ (U+2170) | i | 36 (Times, Avenir, Cochin, Geneva, Papyrus, Bodoni 72, Helvetica, Chalkboard, + 28 more) |
| ⅴ (U+2174) | v | 36 |
| ⅹ (U+2179) | x | 36 |
| ⅼ (U+217C) | l | 38 (+ 2 cross-font via Thonburi) |
| ⅽ (U+217D) | c | 36 |
| ⅾ (U+217E) | d | 36 |
| ⅿ (U+217F) | m | 36 |

### 4.4 Other notable pixel-identical pairs

| Source | Target | Font(s) | Notes |
|--------|--------|---------|-------|
| ꜱ (U+A731) | s | Geneva | Latin small letter s with long stroke |
| Ꝯ (U+A76E) | 9 | Geneva (0.964) | Latin capital letter con |
| ﬁ (U+FB01) | fi | -- | Ligature (separate scoring) |
| Fullwidth Latin (U+FFxx) | Latin | Arial Unicode MS | Pixel-identical for ｘ (U+FF58) |

### 4.5 Intentional vs accidental: glyph reuse taxonomy

Pixel-identical pairs can arise in two ways:

1. **Raster coincidence** -- the font contains separate glyph outlines for
   each codepoint, but the outlines happen to produce identical pixels at
   rendering size. Different glyph IDs in the font's cmap table, same visual
   output.

2. **Glyph reuse** -- the font's cmap maps both codepoints to the same
   glyph ID, so the rendering engine draws literally the same outline. This
   is an intentional font design choice (common for Roman numerals and
   compatibility characters).

To distinguish these, `detect-glyph-reuse.ts` uses fontkit to compare cmap
glyph IDs for all same-font pairs with SSIM >= 0.999.

**Results across 903 pairs:**

| Category | TR39 pairs | Novel pairs | Total |
|----------|-----------|-------------|-------|
| Raster coincidence (different glyph IDs) | 78 | 7 | 85 |
| Glyph reuse (same glyph ID) | 0 | 0 | 0 |
| No pixel-identical comparison | 32 | 786 | 818 |

The finding is striking: **zero glyph reuse detected** across all 85
pixel-identical pairs in all tested fonts. Modern fonts (Arial, Helvetica,
Geneva, Times New Roman, and others) consistently assign separate glyph IDs
to Cyrillic, Greek, and Roman numeral codepoints even when the glyph
outlines are visually identical to their Latin counterparts. The pixel
identity is achieved through separate but outline-identical glyphs, not
through cmap aliasing.

This means all 85 pixel-identical pairs are raster coincidences from a font
engineering perspective, even though the visual result is indistinguishable.
For risk scoring, both categories carry cost = 0 (the attacker does not
care *why* the pixels match), but the taxonomy informs font development:
fonts could in principle assign distinct outlines to confusable characters
without breaking their cmap structure, since the structure already separates
them.

## 5. Top 30 most visually confusable pairs

Ranked by mean SSIM across all font comparisons.

| # | Codepoint | Source | Target | Mean SSIM | Fonts tested | Comparison type |
|---|-----------|--------|--------|-----------|-------------|-----------------|
| 1 | U+A731 | ꜱ | s | 1.000 | 1 | same-font (Geneva) |
| 2 | U+A76E | Ꝯ | 9 | 0.964 | 1 | same-font (Geneva) |
| 3 | U+ABA9 | ꮩ | v | 0.938 | 2 | same-font (Galvji=0.948, Geneva=0.927) |
| 4 | U+05C0 | ׀ | l | 0.923 | 7 | same-font (Tahoma=0.997, Arial Unicode MS=0.988, Microsoft Sans Serif=0.951, Lucida Grande=0.948, TNR=0.913, Courier New=0.838, Arial=0.829) |
| 5 | U+051B | ԛ | q | 0.901 | 16 | same-font (10 fonts at 1.000, Geneva=0.985, + 5 lower) |
| 6 | U+AB93 | ꮓ | z | 0.889 | 2 | same-font (Galvji=0.978, Geneva=0.800) |
| 7 | U+1D22 | ᴢ | z | 0.879 | 17 | same-font (10 fonts at 1.000, + 7 lower) |
| 8 | U+1D20 | ᴠ | v | 0.875 | 17 | same-font (9 fonts at 1.000, Monaco=0.989, + 7 lower) |
| 9 | U+AB83 | ꮃ | w | 0.869 | 2 | same-font (Galvji=0.912, Geneva=0.827) |
| 10 | U+0627 | ا | l | 0.869 | 6 | same-font (Tahoma=0.939, Arial Unicode MS=0.922, + 4 lower) |
| 11 | U+051D | ԝ | w | 0.862 | 21 | same-font (8 fonts at 1.000, + 13 lower) |
| 12 | U+1D0F | ᴏ | o | 0.858 | 17 | same-font (8 fonts at 1.000, + 9 lower) |
| 13 | U+1D21 | ᴡ | w | 0.844 | 17 | same-font (8 fonts at 1.000, + 9 lower) |
| 14 | U+10FF | ჿ | o | 0.813 | 2 | same-font (Helvetica Neue=0.857, Helvetica=0.769) |
| 15 | U+04BB | һ | h | 0.812 | 44 | same-font (8+ fonts at 1.000, + 36 lower) |
| 16 | U+ABAA | ꮪ | s | 0.800 | 2 | same-font (Galvji=0.905, Geneva=0.696) |
| 17 | U+ABAF | ꮯ | c | 0.800 | 2 | same-font (Galvji=0.863, Geneva=0.738) |
| 18 | U+AB75 | ꭵ | i | 0.784 | 2 | same-font (Galvji=0.784, Geneva=0.784) |
| 19 | U+0501 | ԁ | d | 0.781 | 18 | same-font (8 fonts at 1.000, + 10 lower) |
| 20 | U+1D5C2 | 𝗂 | i | 0.764 | 74 cross-font | STIX Two Math vs all standard fonts (Seravek=0.969, Galvji=0.965, + 72 more) |

Pairs #1-3 and #6, #9, #16-18 are Cherokee syllabary characters in Galvji
and Geneva -- these two macOS fonts contain Cherokee glyphs that closely
resemble Latin letters.

Pair #4 (Hebrew Paseq, U+05C0 -> l) is notable: this is Hebrew
*punctuation*, not a letter, yet it scores 0.923 because it renders as a
vertical bar nearly identical to lowercase L. A non-obvious entry that the
scoring correctly surfaces -- think "paypa׀.com" with Paseq replacing the L.

Pair #20 is the first cross-font entry: Mathematical Sans-Serif Italic Small I
rendered in STIX Two Math compared against 74 standard font targets. Despite
being a different font entirely, it scores 0.764 mean SSIM because the
sans-serif mathematical italic form closely resembles a standard italic "i".

## 6. Bottom 30 (false positives in confusables.txt)

The bottom 30 pairs all have negative mean SSIM, meaning the source and
target are *anti-correlated* -- they share less structure than random noise.
47 pairs total have negative mean SSIM.

| # | Codepoint | Source | Target | Mean SSIM | Fonts | Notes |
|---|-----------|--------|--------|-----------|-------|-------|
| 1 | U+118EC | Warang Citi digit | x | -0.095 | 74 cross | Best: Arial Black=0.192 |
| 2 | U+1D4F8 | Mathematical Script o | o | -0.088 | 148 cross | Ornate script != plain |
| 3 | U+1D574 | Math Fraktur l | l | -0.083 | 74 cross | Fraktur != sans-serif |
| 4 | U+1D50A | Math Fraktur g | g | -0.083 | 74 cross | |
| 5 | U+118AF | Warang Citi digit | 4 | -0.074 | 74 cross | |

These entries exist in confusables.txt because they map to the same
*abstract character* under NFKC normalisation, but they are not visually
confusable. A visual scoring system correctly identifies them as low-risk.

## 7. Font coverage analysis

### 7.1 Widest coverage

| Font | Pairs with same-font data | High (>= 0.7) | % high |
|------|---------------------------|----------------|--------|
| Geneva | 258 | 95 | 36.8% |
| Arial Unicode MS | 249 | 76 | 30.5% |
| Microsoft Sans Serif | 148 | 51 | 34.5% |
| Arial | 147 | 60 | 40.8% |
| Courier New | 146 | 38 | 26.0% |
| Times New Roman | 147 | 38 | 25.9% |
| Tahoma | 146 | 63 | 43.2% |
| Lucida Grande | 128 | 50 | 39.1% |
| Charter | 121 | 50 | 41.3% |
| Seravek | 123 | 49 | 39.8% |

Geneva has the widest character coverage (258 pairs) because it includes
Cherokee syllabary, extended Latin, and other scripts. Arial Unicode MS
(249 pairs) is the second-widest -- a comprehensive Unicode font from
Microsoft. Standard web fonts like Arial and Tahoma cover ~147 pairs each.

### 7.2 Highest danger rate

| Font | Pairs | High (>= 0.7) | % high |
|------|-------|----------------|--------|
| Phosphate | 77 | 52 | 67.5% |
| Copperplate | 103 | 69 | 67.0% |
| Chalkboard | 20 | 12 | 60.0% |
| Verdana | 64 | 36 | 56.3% |
| PT Serif Caption | 49 | 27 | 55.1% |
| Big Caslon | 26 | 14 | 53.8% |
| DIN Alternate | 78 | 41 | 52.6% |

Phosphate and Copperplate have the highest percentage of dangerous pairs.
Phosphate is a stencil-style font where many characters are reduced to
simple geometric forms, making confusables look identical. Copperplate
is all-caps, which eliminates case-based distinctions between scripts.

### 7.3 Lowest danger rate

| Font | Pairs | High (>= 0.7) | % high |
|------|-------|----------------|--------|
| Zapfino | 6 | 0 | 0.0% |
| Didot | 104 | 20 | 19.2% |
| Avenir Next Condensed | 76 | 15 | 19.7% |
| Bodoni 72 Oldstyle | 5 | 1 | 20.0% |
| Futura | 59 | 12 | 20.3% |

Zapfino (0% high) is an elaborate calligraphic font where every character
has unique flourishes. No confusable pair looks similar in Zapfino.
Fonts with narrow/condensed proportions (Avenir Next Condensed) also score
lower because the condensing transforms different characters differently.

## 8. No-data characters

77 source characters (5.4%) have no renders because no macOS system font
contains them. These fall into specific Unicode blocks:

| Block | Count | Version | Notes |
|-------|-------|---------|-------|
| Outlined Alphanumerics (U+1CCD6-U+1CCF9) | 36 | Unicode 16.0 | Too new for system fonts |
| Segmented Digits (U+1FBF0-U+1FBF9) | 10 | Unicode 13.0 | Seven-segment display digits |
| Latin Extended-D/E (U+A798-U+AB5A) | 15 | Various | Rare phonetic extensions |
| Greek Musical Notation (U+1D206-U+1D22A) | 6 | Unicode 3.1 | Ancient notation |
| Arabic Mathematical Alphabetic (U+1EE00-U+1EE84) | 5 | Unicode 6.1 | Specialised math |
| Masaram Gondi / Dive Akuru (U+11DDA-U+11DE1) | 3 | Unicode 10.0/13.0 | Historical Indic |
| Medefaidrin (U+16EAA-U+16EB6) | 2 | Unicode 11.0 | Nigerian script |

CoreText (the macOS text rendering engine that browsers use) maps 62 of
these to the LastResort font (tofu boxes) and 15 to Adobe Creative Cloud
synced fonts (Roboto, Fira Sans) that are present on this specific machine
but not standard across macOS installations.

## 9. Implications for namespace-guard

### 9.1 Weighted confusable scoring

The SSIM scores provide a continuous measure of visual confusability that
can replace the binary is/isn't-confusable model in TR39. A namespace-guard
integration should:

1. **Weight by max same-font SSIM**, not mean. If any font produces
   SSIM >= 0.999, the pair is dangerous regardless of how it looks in other
   fonts. Users do not control which font their browser chooses.

2. **Separate same-font from cross-font scores**. Same-font comparisons
   are the strongest signal (mean 0.536 vs 0.339 for cross-font).

3. **Flag the 82 pixel-identical pairs as maximum risk**. These cannot be
   detected by visual inspection under any circumstances.

### 9.2 Script-specific thresholds

Cyrillic confusables average 0.447 and include the most dangerous
pixel-identical pairs. Latin Extended averages 0.572. Mathematical
Alphanumeric Symbols average 0.302 and are mostly false positives.
Per-script thresholds would dramatically reduce false positive rates for
mathematical and Arabic characters while maintaining sensitivity for
Cyrillic and Cherokee.

### 9.3 Confusables.txt triage

Of 1,418 pairs:
- **49 (3.5%) require blocking** (mean SSIM >= 0.7)
- **681 (48.0%) warrant warning** (mean SSIM 0.3-0.7)
- **611 (43.1%) can be deprioritised** (mean SSIM < 0.3)
- **77 (5.4%) need no action** (no font renders them)

This means 96.5% of confusables.txt entries are not high-risk from a visual
perspective. The current approach of treating all 1,418 equally produces
massive false positive rates.

## 10. Implications for the web

The data shows that confusable risk is not a property of character pairs
alone. It is a property of character pairs *in a specific font*. That has
direct consequences for web applications.

### 10.1 Browser font fallback determines the threat

When a page specifies `font-family: Arial, Helvetica, sans-serif` and a
string contains Cyrillic а, the browser checks Arial's glyph tables,
finds Cyrillic coverage, and renders it using Arial's Cyrillic glyphs --
which are pixel-identical to the Latin ones. The CSS font stack a site
ships determines which column of the danger rate table applies to its
users. Arial at 40.8% is a different risk profile from Didot at 19.2%.

### 10.2 Users do not control the font

A content moderator reviewing flagged usernames sees whatever font the
moderation tool renders. If that tool uses a system sans-serif (Arial,
Helvetica, San Francisco), Cyrillic homoglyphs are invisible. If it used
Zapfino, every pair would look different. The font is an uncontrolled
variable in every visual review process.

### 10.3 Address bars are not immune

Browser address bars typically render in the system UI font (San Francisco
on macOS, Segoe UI on Windows). Both are standard sans-serif fonts in the
high-danger-rate category. Chromium's IDN homograph protection catches
many cases by displaying punycode for suspicious mixed-script domains, but
it relies on script-mixing heuristics, not pixel comparison. A domain
using only Cyrillic characters that happen to spell a Latin word (like
"аpple" in all-Cyrillic) may still render in the address bar's font and
look identical.

### 10.4 Web fonts change the equation

Sites that serve custom web fonts via `@font-face` may inadvertently
reduce or increase confusable risk depending on the font's glyph design.
A display font with distinctive Cyrillic letterforms would lower the
danger rate. A geometric sans-serif that harmonises Latin and Cyrillic
would raise it. Neither outcome is typically considered when choosing a
web font.

### 10.5 Implication

Confusable detection systems should be aware of the rendering context. A
warning that says "this string contains a confusable character" is less
useful than one that says "this string contains a character that is
pixel-identical to its Latin counterpart in the font your users will see."

## 11. Limitations and future work

1. **macOS only**. Windows and Linux ship different fonts with different
   glyph tables. Cross-platform scoring would require running on each OS
   or using freely distributable fonts (e.g., Noto family).

2. **48x48 resolution**. Higher resolution (e.g., 256x256) might reveal
   subtle differences that 48x48 misses, but at the cost of slower
   computation. The GlyphNet paper found 256x256 optimal for CNN
   features; our SSIM/pHash approach may benefit less from higher
   resolution.

3. **No contextual rendering**. Some confusables are dangerous only in
   specific word contexts (e.g., Cyrillic а is dangerous in "pаypal" but
   not in isolation). Context-aware scoring is a future milestone.

4. **Font weights and styles**. We render Regular weight only. Bold,
   italic, and condensed variants might score differently. The data shows
   that condensed fonts (Avenir Next Condensed) already score lower.

5. **Multi-character confusables**. This analysis covers single-character
   pairs only. Multi-character sequences (e.g., "rn" vs "m") are a
   future milestone.

6. **8x8 pHash resolution**. The perceptual hash used for prefiltering
   operates at 8x8 pixels. At this resolution, many structurally
   different characters produce similar hashes, limiting the prefilter's
   ability to reject pairs. A 16x16 pHash would improve discrimination
   but would require re-rendering the index.

---

# Milestone 2: Novel Confusable Discovery

## 13. Motivation

Milestone 1b validated the visual accuracy of confusables.txt. But
confusables.txt is a curated list maintained by the Unicode Consortium -- it
cannot cover every visually similar pair across the full Unicode character set.

The question Milestone 2 asks: **how many dangerous confusable pairs exist in
Unicode that are NOT in confusables.txt?**

This matters because confusable detection systems (including namespace-guard's
`skeleton()` and `areConfusable()`) rely on confusables.txt as their source of
truth. Any pair missing from the list is an undetected attack vector.

## 14. Methodology

### 14.1 Candidate selection

`build-candidates.ts` parses UnicodeData.txt and selects characters that are:

1. **Identifier-safe** -- General Category is Letter (L*) or Number (N*)
2. **Not already in confusables.txt** -- not a source character in TR39
3. **Not CJK/Hangul/logographic** -- excluded because these scripts are
   structurally different from Latin and would produce only false positives.
   Milestone 2b subsequently scanned all 122,862 excluded codepoints and
   found 28 novel confusable characters in these ranges (see Section 21).

This produces **23,317 candidate characters** across hundreds of scripts and
Unicode blocks.

### 14.2 Font coverage

Each candidate is queried against fontconfig to find which system fonts
natively contain it. Of 23,317 candidates:

- **12,555** (53.8%) have coverage in at least one of 230 system fonts
- **10,762** (46.2%) have no font coverage (no macOS system font contains them)

The covered candidates average 7.1 fonts each, producing **89,478 render jobs**
(vs 2.9M brute-force). Noto Sans variants provide the majority of coverage for
non-Latin scripts.

### 14.3 Rendering

`build-index.ts --candidates` renders all 12,555 covered candidates plus the
36 Latin targets (a-z, 0-9) in standard fonts:

- **86,815 source renders** (candidates in their native fonts)
- **2,663 target renders** (Latin a-z/0-9 in 74 standard fonts)
- Total: **89,478 PNGs**, same 48x48 greyscale pipeline as Milestone 1b

### 14.4 Scoring

`score-candidates.ts` compares each candidate against all 36 Latin targets.
The scale challenge is significant: 12,555 sources x 36 targets x multiple
fonts per source could produce hundreds of millions of SSIM comparisons.

Two optimisations make this tractable:

1. **Same-font pHash prefilter** -- for candidates in standard fonts (where
   both source and target exist in the same font), a pHash similarity
   threshold of 0.3 skips SSIM computation for pairs with extremely different
   perceptual hashes.

2. **Top-1-by-pHash cross-font** -- for candidates in non-standard fonts
   (Noto Sans variants, CJK fonts, etc.), instead of comparing against all 74
   target renders for each Latin letter, the scorer finds the single best
   target render by pHash similarity and computes SSIM only for that pair.
   This reduces cross-font comparisons from O(74) to O(1) per source render.

The result: **2,904,376 SSIM comparisons** computed in 928 seconds (15.5
minutes) -- approximately 3,130 SSIM/second.

### 14.5 Output

Scoring produces `candidate-scores.json` (572 MB, streaming JSON) containing
all 426,509 scored pairs. `extract-discoveries.ts` stream-parses this file
and extracts the 793 high-scoring pairs into `candidate-discoveries.json`
(1.5 MB, committed to the repository under CC-BY-4.0).

## 15. Distribution

### 15.1 Overall

| Band | Count | % | Description |
|------|-------|---|-------------|
| High (>= 0.7) | 793 | 0.2% | Novel confusables not in TR39 |
| Medium (0.3-0.7) | 34,522 | 8.1% | Somewhat similar |
| Low (< 0.3) | 391,194 | 91.7% | Not visually confusable |
| **Total** | **426,509** | | |

Only 0.2% of all scored candidate pairs are high-risk. This is a lower hit
rate than Milestone 1b (3.5%) because confusables.txt is pre-curated for
likely confusables, while Milestone 2 searches the full identifier-safe
character space.

### 15.2 Within discoveries

| SSIM range | Count | % of discoveries |
|------------|-------|-----------------|
| >= 0.95 | 21 | 2.6% |
| 0.90 - 0.95 | 55 | 6.9% |
| 0.80 - 0.90 | 191 | 24.1% |
| 0.70 - 0.80 | 526 | 66.3% |
| **Total** | **793** | |

The majority of discoveries (66%) fall in the 0.70-0.80 range -- visually
confusable but not pixel-identical. The 21 pairs scoring above 0.95 are the
most dangerous: near-indistinguishable from their Latin counterparts.

### 15.3 By target character shape

| Shape category | Targets | Count | % |
|----------------|---------|-------|---|
| Vertical stroke | l, i, j | 377 | 47.5% |
| Round | o, c, e, d, b, n, p, q | 153 | 19.3% |
| Other letters | t, s, f, r, h, m, u, y, a | 147 | 18.5% |
| Numeral | 0-9 | 60 | 7.6% |
| Angular | x, v, w, z, k | 56 | 7.1% |

Nearly half of all novel confusables target "l", "i", or "j" -- the simplest
Latin glyphs. A vertical stroke is the most common glyph shape across all
writing systems: tally marks, vowel carriers, numeral ones, and vertical
punctuation all reduce to a single line at 48x48 resolution.

### 15.4 By target character

| Target | Discoveries | Notes |
|--------|-------------|-------|
| l | 143 | Vertical stroke -- universal across scripts |
| i | 125 | Vertical stroke (with or without dot) |
| j | 109 | Vertical stroke with descender |
| o | 65 | Circle -- common numeral/vowel shape |
| t | 62 | Cross shape |
| x | 22 | Diagonal cross |
| c | 22 | Open curve |
| n | 20 | Arch |
| 8 | 17 | Double circle |
| u | 17 | Open arch |
| v | 16 | Angular open |
| b | 14 | Vertical + circle |
| m | 13 | Double arch |
| Other | 148 | Remaining 21 targets |

"l" alone has 143 novel confusables -- more than the total number of high-risk
pairs in all of confusables.txt (49). This is the single largest gap in TR39
coverage.

## 16. Top 30 novel confusable pairs

Ranked by mean SSIM. None of these are in confusables.txt.

| # | Codepoint | Name | Target | Mean SSIM | Font(s) |
|---|-----------|------|--------|-----------|---------|
| 1 | U+A7FE | LATIN EPIGRAPHIC LETTER I LONGA | l | 0.998 | Geneva (same-font) |
| 2 | U+16B50 | PAHAWH HMONG DIGIT ZERO | l | 0.986 | Noto Sans Pahawh Hmong vs Skia |
| 3 | U+10889 | NABATAEAN LETTER KAPH | l | 0.986 | Noto Sans Nabataean vs Skia |
| 4 | U+A781 | LATIN SMALL LETTER TURNED L | l | 0.986 | Geneva (same-font) |
| 5 | U+A771 | LATIN SMALL LETTER DUM | d | 0.985 | Geneva (same-font) |
| 6 | U+1BC07 | DUPLOYAN LETTER I | l | 0.981 | Noto Sans Duployan vs Skia |
| 7 | U+10D31 | HANIFI ROHINGYA VOWEL A | l | 0.978 | Noto Sans Hanifi Rohingya vs Skia |
| 8 | U+1E822 | MENDE KIKAKUI DIGIT ONE | l | 0.978 | Noto Sans Mende Kikakui vs Skia |
| 9 | U+16A59 | MRO DIGIT NINE | l | 0.978 | Noto Sans Mro vs Skia |
| 10 | U+109C0 | MEROITIC CURSIVE NUMBER ONE | l | 0.978 | Noto Sans Meroitic vs Skia |
| 11 | U+108ED | HATRAN NUMBER ONE | l | 0.976 | Noto Sans Hatran vs Skia |
| 12 | U+108FB | HATRAN LOW NUMERAL SIGN | l | 0.976 | Noto Sans Hatran vs Skia |
| 13 | U+1E951 | ADLAM SMALL LETTER I | l | 0.973 | Noto Sans Adlam vs Skia |
| 14 | U+10A9D | OLD NORTH ARABIAN NUMBER ONE | l | 0.972 | Noto Sans Old North Arabian vs Skia |
| 15 | U+0C79 | TELUGU DIGIT THREE | l | 0.969 | Telugu MN/Kohinoor Telugu/Telugu Sangam MN vs Skia |
| 16 | U+A621 | VAI DIGIT ONE | l | 0.963 | Noto Sans Vai vs Skia |
| 17 | U+11AE5 | PAU CIN HAU LETTER PA | l | 0.960 | Noto Sans Pau Cin Hau vs Skia |
| 18 | U+A76F | LATIN SMALL LETTER CON | 9 | 0.958 | Geneva (same-font) |
| 19 | U+A9D0 | JAVANESE DIGIT ZERO | o | 0.958 | Noto Sans Javanese vs Avenir |
| 20 | U+10CA5 | OLD HUNGARIAN SMALL LETTER ECS | l | 0.956 | Noto Sans Old Hungarian vs Skia |
| 21 | U+1036D | OLD PERMIC LETTER OI | l | 0.952 | Noto Sans Old Permic vs Skia |
| 22 | U+10347 | GOTHIC LETTER GIBA | x | 0.941 | Noto Sans Gothic vs Menlo |
| 23 | U+09F7 | BENGALI CURRENCY NUMERATOR FOUR | l | 0.939 | Bangla MN/Kohinoor Bangla/Bangla Sangam MN/Noto Sans Tirhuta vs Skia; Arial Unicode MS (same-font) |
| 24 | U+1036D | OLD PERMIC LETTER OI | j | 0.939 | Noto Sans Old Permic vs Futura |
| 25 | U+1102D | BRAHMI VOWEL SIGN E | l | 0.937 | Noto Sans Brahmi/Tamil Sangam MN vs Skia |
| 26 | U+10CA5 | OLD HUNGARIAN SMALL LETTER ECS | j | 0.937 | Noto Sans Old Hungarian vs Futura |
| 27 | U+16A59 | MRO DIGIT NINE | i | 0.937 | Noto Sans Mro vs Skia |
| 28 | U+108A7 | NABATAEAN LETTER LAMEDH | l | 0.937 | Noto Sans Nabataean vs Skia |
| 29 | U+A7FE | LATIN EPIGRAPHIC LETTER I LONGA | i | 0.935 | Geneva (same-font) |
| 30 | U+1E951 | ADLAM SMALL LETTER I | i | 0.934 | Noto Sans Adlam vs Skia |

Pairs #1-4 and #6-17 are all vertical-stroke characters targeting "l". They
come from 14 different scripts, all rendering as a simple vertical bar that is
near-identical to Latin lowercase L. The recurrence of this shape across
unrelated writing systems is the single strongest pattern in the data.

Pair #5 (U+A771, Latin Small Letter Dum) is notable because it is a Latin
Extended character that looks identical to "d" in Geneva -- a within-Latin
confusable that TR39 missed.

Pair #19 (Javanese digit zero vs "o") and #22 (Gothic letter giba vs "x") are
structurally non-obvious: these are characters from completely unrelated
scripts whose glyph shapes happen to converge with common Latin letters.

## 17. Notable non-obvious discoveries

The vertical-stroke "l" lookalikes dominate the top of the list, but the more
interesting security findings are characters that mimic structurally complex
Latin letters:

| Codepoint | Name | Target | SSIM | Font | Why it matters |
|-----------|------|--------|------|------|----------------|
| U+A9D0 | JAVANESE DIGIT ZERO | o | 0.958 | Noto Sans Javanese vs Avenir | A digit that looks like a letter |
| U+10347 | GOTHIC LETTER GIBA | x | 0.941 | Noto Sans Gothic vs Menlo | Historical script with Latin-like shape |
| U+2CAD | COPTIC SMALL LETTER CRYPTOGRAMMIC NI | x | 0.925 | Noto Sans Coptic vs Menlo | Cross-script "x" lookalike |
| U+17F4 | KHMER SYMBOL BUON KOET | v | 0.928 | Khmer MN vs Tahoma | Khmer symbol indistinguishable from "v" |
| U+07D5 | NKO LETTER BA | b | 0.922 | Noto Sans NKo vs Futura | West African script "b" lookalike |
| U+07CE | NKO LETTER YA | u | 0.916 | Noto Sans NKo vs Arial | NKo character indistinguishable from "u" |
| U+2C91 | COPTIC SMALL LETTER EI | e | 0.897 | Noto Sans Coptic vs Arial | Coptic "e" lookalike |
| U+10336 | GOTHIC LETTER KUSMA | z | 0.884 | Noto Sans Gothic vs Menlo | Gothic "z" lookalike |
| U+10CC2 | OLD HUNGARIAN SMALL LETTER EC | x | 0.883 | Noto Sans Old Hungarian vs Arial | Historical "x" lookalike |
| U+1D5C6 | MATHEMATICAL SANS-SERIF SMALL M | m | 0.878 | STIX Two Math vs Avenir | Math variant of "m" |

These are the pairs most likely to be useful in targeted spoofing attacks.
Unlike vertical strokes (which are easy to flag with a simple rule), these
characters require visual comparison to detect because their shapes are
distinctive enough that simple heuristics would miss them.

## 18. Script analysis

### 18.1 Top contributing scripts

| Script/Font | Novel pairs | Avg SSIM | Notes |
|-------------|-------------|----------|-------|
| Shared Latin fonts (Arial, etc.) | 107 | 0.765 | Latin Extended, IPA, modifier letters |
| Geneva | 44 | 0.800 | Latin Extended-D, Cherokee Supplement |
| Old Hungarian | 20 | 0.831 | Historical Turkic script |
| Duployan | 20 | 0.810 | 19th-century shorthand system |
| Euphemia UCAS | 19 | 0.777 | Unified Canadian Aboriginal Syllabics |
| Mende Kikakui | 18 | 0.823 | West African script |
| Vai | 18 | 0.781 | West African syllabary |
| Tifinagh | 17 | 0.793 | Berber script |
| Mro | 15 | 0.782 | Chin Hills script (Myanmar/Bangladesh) |
| Pau Cin Hau | 15 | 0.790 | Another Chin script |
| Gothic | 14 | 0.793 | 4th-century Germanic script |
| NKo | 14 | 0.792 | West African script for Manding languages |
| Tamil Sangam MN | 14 | 0.792 | Tamil script |
| Coptic | 13 | 0.791 | Egyptian Christian script |
| Nabataean | 12 | 0.827 | Ancient Aramaic-derived script |
| Hatran | 12 | 0.861 | Ancient Mesopotamian script |
| Pahawh Hmong | 11 | 0.804 | Southeast Asian script |
| Ugaritic | 11 | 0.772 | Ancient cuneiform alphabetic |
| Adlam | 10 | 0.810 | Modern West African script |
| Lydian | 10 | 0.808 | Ancient Anatolian script |

96 distinct scripts/fonts contribute at least one novel confusable pair. The
distribution has a long tail: the top 20 scripts account for 463 of 793 pairs
(58%), while 76 scripts contribute 5 or fewer pairs each.

### 18.2 Script families

Grouping by geographic/linguistic family:

| Family | Scripts | Total pairs | Notes |
|--------|---------|-------------|-------|
| Latin Extended/IPA | Latin fonts (Arial, Geneva, Menlo, etc.) | ~180 | Extended Latin, phonetic, modifier characters |
| West African | Vai, Mende Kikakui, NKo, Adlam, Bamum | ~70 | Modern and historical West African writing |
| Ancient Near East | Nabataean, Hatran, Ugaritic, Phoenician, Palmyrene, Lydian, Old Persian, Cypriot | ~70 | Historical scripts from the fertile crescent |
| Historical European | Gothic, Old Hungarian, Old Permic, Glagolitic, Runic, Coptic, Old Italic | ~70 | Medieval and ancient European scripts |
| Southeast Asian | Pahawh Hmong, Mro, Pau Cin Hau, Kayah Li, Tai Le, Cham, Javanese, Khmer | ~65 | Scripts from mainland/island Southeast Asia |
| Canadian Aboriginal | Unified Canadian Aboriginal Syllabics | 19 | Cree, Inuktitut, and related syllabaries |
| South Asian | Tamil, Bengali, Telugu, Oriya, Brahmi | ~40 | Indic scripts |
| North/East African | Tifinagh, Ethiopic, Meroitic | ~30 | Berber, Ethiopian, and Nubian scripts |
| Mathematical | STIX Two Math, Apple Symbols | ~20 | Mathematical notation variants |
| Central Asian | Duployan, Old Turkic, Old Sogdian, Chorasmian | ~25 | Historical Central Asian scripts |

The concentration in West African, Ancient Near Eastern, and historical
European scripts is noteworthy. These are scripts with active Noto Sans font
coverage on macOS but minimal representation in confusables.txt. The Unicode
Consortium's curation has focused on the scripts most commonly encountered in
modern computing (Cyrillic, Greek, Armenian) while leaving these smaller
scripts unexamined for Latin visual similarity.

### 18.3 Same-font vs cross-font

| Mode | Comparisons |
|------|-------------|
| Same-font | 3,401 (68.8%) |
| Cross-font | 1,546 (31.2%) |
| **Total** | **4,947** |

Note: these are individual font comparisons across the 793 pairs (most pairs
have multiple font comparisons). 245 of 793 pairs appear in more than one font.
The pair with the widest coverage is U+00ED (Latin Small Letter I with Acute)
vs "i", which scores >= 0.7 in 101 fonts.

## 19. Comparison with confusables.txt

### 19.1 Scale

| Metric | Confusables.txt (M1b) | Novel discoveries (M2) |
|--------|----------------------|----------------------|
| Input pairs/candidates | 1,418 | 23,317 |
| Characters with font coverage | 1,341 (94.6%) | 12,555 (53.8%) |
| SSIM comparisons | 235,625 | 2,904,376 |
| High-risk pairs (>= 0.7) | 49 (3.5%) | 793 (0.2% of scored) |
| Pixel-identical in >= 1 font | 82 | 533 (by pHash) |
| Computation time | 65s | 928s |

### 19.2 Coverage gaps

The 793 novel discoveries represent a 16x increase over the 49 high-risk
confusables.txt pairs. This does not mean confusables.txt is poorly curated --
it means its scope is different. Confusables.txt entries were collected
using compatibility mappings and character properties as a source during
data collection, not visual rendering. Many visually similar characters
were not identified by that process and are therefore absent.

The gap is largest for:

1. **Vertical stroke characters** -- confusables.txt covers the well-known
   cases (Hebrew Vav, Cyrillic palochka) but misses hundreds of vertical
   strokes from obscure scripts.
2. **Numeral lookalikes** -- digits from non-Latin numeral systems that
   visually match Latin digits (Javanese 0 vs "o", Pahawh Hmong 0 vs "l").
3. **Historical scripts** -- Gothic, Old Hungarian, Nabataean, Hatran, and
   similar scripts have characters with Latin-like shapes that are not in
   confusables.txt.

### 19.3 Implications for confusable detection

A confusable detection system that relies solely on confusables.txt will miss
793 visually dangerous pairs. The practical risk depends on whether the
attacking characters are identifier-safe in the target context:

- **JavaScript identifiers**: most of these characters are valid in
  identifiers per UAX #31 (Unicode Identifier and Pattern Syntax).
- **Domain names**: IDNA 2008 restricts most SMP characters, so the Ancient
  Near Eastern and historical European discoveries are less relevant for
  domain spoofing. But BMP characters (Latin Extended, Coptic, NKo, Tifinagh)
  are potentially usable.
- **Package names**: npm, PyPI, and other package registries have varying
  Unicode policies. Many accept the full BMP range.

### 19.4 Identifier property annotations

To quantify the risk by deployment context, each of the 793 novel
discoveries was annotated with four Unicode identifier properties using
`annotate-properties.ts`:

| Property | Count | % of 793 | Source |
|----------|-------|----------|--------|
| XID_Continue | 715 | 90.2% | UAX #31 DerivedCoreProperties.txt |
| XID_Start | 637 | 80.3% | UAX #31 DerivedCoreProperties.txt |
| IDNA PVALID | 657 | 82.8% | UTS #46 IdnaMappingTable.txt (status=valid) |
| TR39 Allowed | 60 | 7.6% | TR39 IdentifierStatus.txt |
| XID_Continue AND IDNA PVALID | 591 | 74.5% | Cross-product |

Note: "IDNA PVALID" here reports UTS #46 `valid` status from IdnaMappingTable.txt, which is what browsers and registrars implement. RFC 5892 derives PVALID from character properties and may differ for a small number of codepoints.

**74.5% of novel discoveries are valid in both JavaScript identifiers and
internationalized domain names.** These 591 pairs are the most dangerous
subset: an attacker can use them in variable names, function names, package
names, and domain labels. They are not blocked by IDNA 2008, not blocked by
UAX #31, and not flagged by confusables.txt.

Only 60 of 793 (7.6%) are TR39 Identifier_Status=Allowed, meaning 92.4%
come from Restricted scripts. This is expected: most discoveries are from
SMP historical scripts (Gothic, Old Hungarian, Nabataean) or minority
scripts (Pahawh Hmong, Mende Kikakui, Mro) that Unicode classifies as
Restricted. However, Restricted status alone does not prevent exploitation
in all contexts. JavaScript engines, for example, accept any XID_Continue
character in identifiers regardless of TR39 restriction status.

For the 110 high-risk TR39 pairs: 102 (92.7%) are XID_Continue, 52 (47.3%)
are IDNA PVALID, and 49 (44.5%) are TR39 Allowed.

## 20. Reproducibility

All outputs are deterministic given the same platform and fonts.

### 20.1 Milestone 1b

```bash
npx tsx scripts/build-index.ts          # Build render index (~160s, 11,370 PNGs)
npx tsx scripts/score-all-pairs.ts      # Score all pairs (~65s, 235,625 comparisons)
npx tsx scripts/report-stats.ts         # Generate report statistics
```

### 20.2 Milestone 2

```bash
npx tsx scripts/build-candidates.ts          # Build candidate set (~23K chars)
npx tsx scripts/build-index.ts --candidates  # Render candidates (~40min, 89K PNGs)
npx tsx scripts/score-candidates.ts          # Score against Latin targets (~15min, 2.9M comparisons)
```

### 20.3 Extract discoveries (both milestones)

```bash
npx tsx scripts/extract-discoveries.ts  # Extract high-scoring pairs from both pipelines
```

### 20.4 Output files

**Committed (CC-BY-4.0):**
- `data/output/confusable-discoveries.json` -- 110 TR39 pairs (high SSIM or pixel-identical)
- `data/output/candidate-discoveries.json` -- 793 novel pairs not in TR39

**Generated (gitignored, run pipeline to regenerate):**
- `data/output/render-index/` -- 11,370 M1b render PNGs + index.json
- `data/output/candidate-index/` -- 89,478 M2 render PNGs + index.json
- `data/output/confusable-scores.json` -- full M1b scored results (63 MB)
- `data/output/candidate-scores.json` -- full M2 scored results (572 MB)
- `data/output/candidates.json` -- M2 candidate character set
- `data/output/report-stats.txt` -- detailed statistics for this report

**Licence:** CC-BY-4.0 (data), MIT (code)

---

# Milestone 2b: CJK/Hangul/Logographic Cross-Script Scan

## 21. Motivation

Milestone 2 excluded 122,862 codepoints from CJK, Hangul, Cuneiform, Egyptian
Hieroglyphs, and other logographic scripts because these structurally dense 2D
character forms were expected to produce only false positives against thin Latin
strokes. M2b extends the scan to every one of these excluded codepoints to find
any that are genuinely confusable with Latin letters.

The exclusion covered 30 Unicode ranges:

| Range | Candidates |
|-------|-----------|
| CJK Extension B | 42,720 |
| CJK Unified Ideographs | 20,992 |
| Hangul Syllables | 11,172 |
| CJK Extension F | 7,473 |
| CJK Extension A | 6,592 |
| Tangut + Components | 6,144 |
| CJK Extension E | 5,762 |
| CJK Extension G | 4,939 |
| CJK Extension H | 4,192 |
| CJK Extension C | 4,160 |
| Cuneiform + Numbers and Punctuation | 1,229 |
| Yi Syllables + Radicals | 1,165 |
| Egyptian Hieroglyphs + Format Controls | 1,078 |
| All other ranges (17 ranges) | 4,244 |
| **Total** | **122,862** |

## 22. Methodology

### 22.1 Candidate selection

`build-candidates-m2b.ts` inverts the M2 range filter: it selects only
codepoints from the 30 excluded ranges that have General Category L* or N*.
One character was excluded as an existing TR39 confusable source, leaving
122,862 candidates.

### 22.2 Font coverage

Each candidate is queried against fontconfig. Of 122,862 candidates:

- **49,859** (40.6%) have coverage in at least one of 230 system fonts
- **73,003** (59.4%) have no font coverage (no macOS system font contains them)

The zero-coverage rate is much higher than M2 (59.4% vs 46.2%) because the
CJK Extension ranges B through I (69,932 codepoints) have minimal system font
support -- most require specialised fonts not bundled with macOS.

Characters with coverage average 1.9 fonts each (vs 7.1 in M2), reflecting
that CJK/Hangul fonts are fewer and more specialised than the Noto Sans
variants that dominate M2 coverage.

### 22.3 Rendering

`build-index-m2b.ts` renders all 49,859 covered candidates:

- **236,840 source renders** (candidates in their native fonts)
- Target renders reused from M1b render-index (not re-rendered)
- Same 48x48 greyscale pipeline as all previous milestones
- Progress written incrementally to `progress.jsonl` for crash recovery
- Total rendering time: 1,481 seconds (24.7 minutes), plus 9,687 seconds
  (2.7 hours) for fontconfig coverage queries

### 22.4 Scoring

`score-candidates-m2b.ts` uses the same strategy as M2: same-font + cross-font
scoring with pHash prefilter at 0.3.

- **1,123,938 same-font comparisons** (source and target in same standard font)
- **6,928,622 cross-font comparisons** (source in non-standard font, target in
  standard font, top-1-by-pHash optimisation)
- **8,036,479 SSIM computed**, 16,081 skipped by pHash prefilter
- **1,694,697 pairs** with SSIM data
- Scoring time: 2,762 seconds (46 minutes)

The pHash prefilter was less effective here than in M2 (0.2% skip rate vs 23%
in M2), because the 0.3 threshold is too loose for CJK characters --
8x8 pHash representations of dense ideographs can produce moderate similarity
to simple Latin strokes through chance alignment of DCT coefficients.

## 23. Results

### 23.1 Distribution

| Band | Count | % | Description |
|------|-------|---|-------------|
| High (>= 0.7) | 69 | 0.004% | Genuinely confusable |
| Medium (0.3-0.7) | 6,564 | 0.4% | Somewhat similar |
| Low (< 0.3) | 1,688,064 | 99.6% | Not visually confusable |
| **Total** | **1,694,697** | | |

**28 novel confusable characters found.** Of 1,694,697 scored pairs, 69
(0.004%) cross the high-similarity threshold, all from 28 distinct source
characters. These are simple geometric primitives -- vertical strokes, circles,
and basic cross shapes -- that happen to live in ranges otherwise dominated by
structurally complex ideographs.

### 23.2 Per-range breakdown

| Range | Candidates | Scored pairs | High | Medium | Low |
|-------|-----------|-------------|------|--------|-----|
| CJK Unified Ideographs | 20,992 | 713,728 | 10 | 542 | 713,176 |
| Hangul Syllables | 11,172 | 379,848 | 0 | 119 | 379,729 |
| CJK Extension A | 6,592 | 224,128 | 0 | 56 | 224,072 |
| CJK Extension B | 42,720 | 214,812 | 1 | 177 | 214,634 |
| Egyptian Hieroglyphs | 1,078 | 36,176 | 19 | 1,939 | 34,218 |
| Cuneiform | 1,229 | 41,786 | 13 | 556 | 41,217 |
| Yi Syllables + Radicals | 1,165 | 39,610 | 4 | 2,083 | 37,523 |
| CJK Symbols/Hiragana/Katakana | 247 | 8,262 | 9 | 254 | 7,999 |
| Hangul Jamo | 256 | 8,025 | 7 | 220 | 7,798 |
| Hangul Compatibility Jamo | 94 | 3,156 | 4 | 105 | 3,047 |
| Halfwidth Katakana/Hangul | 110 | 3,678 | 2 | 451 | 3,225 |
| All other ranges (19 ranges) | 37,207 | 21,488 | 0 | 62 | 21,426 |

The discoveries concentrate in five ranges, not in the dense ideograph ranges:

1. **Egyptian Hieroglyphs** (19 high-scoring pairs) -- simple geometric
   hieroglyphs (vertical strokes, circles) that resemble Latin letters
2. **Cuneiform** (13 pairs) -- wedge-mark numerals that are thin vertical
   strokes
3. **CJK Unified Ideographs** (10 pairs) -- only the simplest stroke
   characters (丨, 丄, 丅) from the full 20,992-character set
4. **CJK Symbols/Hiragana/Katakana** (9 pairs) -- Hangzhou numerals (〡, 〸)
   and Bopomofo
5. **Hangul Jamo** (7 pairs) -- isolated vowel jamo (ᅵ, ㅣ) that render as
   vertical strokes

The actual CJK ideograph ranges (Extensions A-I, 76,891 candidates) produced
only 1 high-scoring pair -- from CJK Extension B, a character that rendered
as a near-vertical stroke. The dense 2D ideographs that motivated the original
exclusion are indeed structurally incompatible with Latin, as predicted.

Hangul Syllables (11,172 candidates) produced zero high-scoring pairs. The
composed syllable blocks are too structurally complex to resemble any single
Latin letter.

### 23.3 The 28 confusable source characters

All 69 high-scoring pairs come from just 28 distinct source characters. These
fall into clear morphological categories:

**Category 1: Vertical strokes (18 characters, 54 pairs)**

These characters render as a single vertical line, making them visually
identical to "l", "i", or "j" depending on stroke weight and positioning:

| Source | Name | Targets | Peak SSIM | Fonts |
|--------|------|---------|-----------|-------|
| 〡 U+3021 | Hangzhou Numeral One | l, i, j, t | 0.928 | 6 |
| 丨 U+4E28 | CJK Vertical Stroke | l, i, j, t | 0.879 | 10 |
| ᅵ U+1175 | Hangul Jungseong I | l, i, j | 0.847 | 2 |
| ㅣ U+3163 | Hangul Letter I | l, i, j | 0.847 | 2 |
| ￜ U+FFDC | Halfwidth Hangul I | l, i | 0.836 | 1 |
| 𓏺 U+133FA | Egyptian Hieroglyph | j, l, i, f | 0.831 | 1 |
| ᆝ U+119D | Hangul Jongseong I | l, i | 0.825 | 1 |
| 𒁹 U+12079 | Cuneiform Numeral 1 | l, j, i | 0.821 | 1 |
| 丄 U+4E04 | CJK "Above" | l, i, j | 0.800 | 9 |
| 𓌁 U+13301 | Egyptian Hieroglyph | l, i, j | 0.792 | 1 |
| 𒑖 U+12456 | Cuneiform Numeral | l, i, j | 0.787 | 1 |
| 𓌀 U+13300 | Egyptian Hieroglyph | l, j, i | 0.785 | 1 |
| 𒑉 U+12449 | Cuneiform Numeral | l, i, j | 0.778 | 1 |
| 𒐕 U+12415 | Cuneiform Numeral | j, i, l | 0.765 | 1 |
| 𒋙 U+122D9 | Cuneiform Sign | l | 0.754 | 1 |
| 𓍡 U+13361 | Egyptian Hieroglyph | l, j, i | 0.754 | 1 |
| 𓏪 U+133EA | Egyptian Hieroglyph | j, l, i | 0.743 | 1 |
| 𠃊 U+200CA | CJK Extension B | l | 0.734 | 3 |

The vertical stroke pattern dominates because it is the minimal glyph form --
a single vertical bar is the visual primitive shared across writing systems.
Hangzhou numerals, Cuneiform counting signs, Egyptian determinatives, and
Hangul vowel jamo all independently converge on this form.

**Category 2: Circles (3 characters, 3 pairs)**

| Source | Name | Target | SSIM | Fonts |
|--------|------|--------|------|-------|
| 𓃉 U+130C9 | Egyptian Hieroglyph | o | 0.790 | 1 |
| ㅇ U+3147 | Hangul Letter Ieung | o | 0.738 | 2 |
| ᄋ U+110B | Hangul Choseong Ieung | o | 0.737 | 2 |

The Korean letter ieung (ㅇ) is a circle, and independently, an Egyptian
hieroglyph renders as a circle. Both resemble Latin "o".

**Category 3: Other geometric primitives (7 characters, 12 pairs)**

| Source | Name | Targets | Peak SSIM | Fonts |
|--------|------|---------|-----------|-------|
| 丅 U+4E05 | CJK "Below" | j, i, l | 0.762 | 9 |
| ㄒ U+3112 | Bopomofo Letter X | i, j, t, l | 0.765 | 5 |
| ꀤ U+A024 | Yi Syllable It | j, i, t, l | 0.748 | 4 |
| 〸 U+3038 | Hangzhou Numeral Ten | t | 0.703 | 2 |
| ᆼ U+11BC | Hangul Jongseong Ieung | o | 0.737 | 2 |
| 𓉽 U+1327D | Egyptian Hieroglyph | j | 0.711 | 1 |
| 𓋾 U+132FE | Egyptian Hieroglyph | j | 0.703 | 1 |

Bopomofo ㄒ resembles a cross/plus that maps to "i" or "t". Yi syllable ꀤ
has a T-like stroke. Hangzhou numeral 〸 (ten) is a plus sign that resembles
"t".

### 23.4 Relationship to confusables.txt

Of the 28 source characters found by M2b, we checked whether any appear in
Unicode TR39 confusables.txt:

- **丨 U+4E28** (CJK vertical stroke) -- already in confusables.txt, mapped to
  U+007C VERTICAL LINE. However, it was excluded from M2 as a CJK character,
  not as an existing confusable source, so M2b correctly re-evaluates it.
- The remaining 27 source characters are **not** in confusables.txt and
  represent genuine gaps in TR39 coverage within the excluded ranges.

### 23.5 Font coverage of discoveries

The discoveries skew towards characters with low font coverage:

| Fonts covering source | Discovery count |
|----------------------|----------------|
| 1 font | 36 pairs (52%) |
| 2 fonts | 12 pairs (17%) |
| 3-5 fonts | 7 pairs (10%) |
| 6-10 fonts | 14 pairs (20%) |

Most discoveries (52%) appear in only one font, typically Noto Sans Egyptian
Hieroglyphs, Noto Sans Cuneiform, or Arial Unicode MS. This means the
confusability is font-specific -- a user would need that particular font
installed for the attack to succeed visually.

The exceptions are the CJK stroke characters (丨, 丄, 丅, 〡) which appear
in 6-10 CJK fonts. These are the most broadly exploitable M2b discoveries
because they are available in common system fonts.

## 24. Assessment

### 24.1 Significance

M2b found 28 novel confusable characters that M2 missed by excluding their
ranges. These 28 characters should be added to the confusable-vision discovery
set. They are genuine visual confusables that happen to live in ranges otherwise
dominated by structurally complex ideographs. The practical risk varies:

- **High practical risk**: 丨 U+4E28, 〡 U+3021, ㅣ U+3163 -- common CJK
  stroke characters available in many fonts, targeting "l"/"i" which are
  already high-value attack targets
- **Medium practical risk**: ㅇ U+3147, ᄋ U+110B, ᆼ U+11BC -- Hangul
  components targeting "o", available in Hangul fonts
- **Low practical risk**: Egyptian hieroglyphs, Cuneiform numerals -- require
  specialised fonts, unlikely to be present on victim machines

### 24.2 Scope

The 28 characters from M2b compare to:
- 1,418 existing TR39 confusable sources
- 793 novel confusables found by M2

M2b adds 28 characters (3.5% of M2's discovery count, 2.0% of TR39's). All
are simple geometric primitives (strokes and circles) rather than complex
ideographs. The remaining 99.6% of the 122,862 scanned codepoints score below
0.3 SSIM, confirming that dense logographic characters are structurally
incompatible with Latin letterforms.

## 25. Reproducibility

### 25.1 Milestone 2b

```bash
npx tsx scripts/build-candidates-m2b.ts        # Build M2b candidates (122K chars, ~10 min)
npx tsx scripts/build-index-m2b.ts             # Render candidates (~3 hours, 236K PNGs)
npx tsx scripts/score-candidates-m2b.ts        # Score against Latin targets (~46 min, 8M comparisons)
npx tsx scripts/extract-m2b.ts                 # Extract verification report + discoveries
```

All four scripts support crash recovery via `progress.jsonl` and auto-resume.
Use `--fresh` to force a clean start.

### 25.2 Output files

**Committed (CC-BY-4.0):**
- `data/output/m2b-verification-report.json` -- per-range breakdown and top pairs
- `data/output/m2b-discoveries.json` -- 69 pairs scoring >= 0.7 mean SSIM

**Generated (gitignored, run pipeline to regenerate):**
- `data/output/m2b-candidates.json` -- 122,862 candidate characters
- `data/output/m2b-index/` -- 236,840 render PNGs + index.json
- `data/output/m2b-scores.json` -- full scored results (1,710 MB)

---

## 26. Motivation

Milestones 1b, 2, and 2b all measure confusability *against Latin targets*.
This protects English-language users from homograph attacks but leaves
non-Latin script communities without equivalent coverage. A Russian user
spoofed by a Greek lookalike, a Korean user attacked with CJK stroke
characters, or an Arabic user deceived by Hangul vertical jamo all fall
outside the Latin-centric model.

Unicode TR39 confusables.txt follows the same Latin-centric pattern: it maps
6,247 source characters to Latin prototypes. The skeleton() algorithm reduces
all comparisons to Latin equivalence classes. This design reflects the
historical reality that most spoofing research has focused on IDN (domain
name) homograph attacks targeting English-speaking users, but it leaves a
systematic gap: no empirical data exists for visual similarity *between*
non-Latin scripts.

M5 closes this gap. By scanning all 66 cross-script pairs from 12
ICANN-relevant scripts, it produces the first comprehensive empirical
cross-script confusable dataset. The confusable-vision infrastructure is
script-agnostic: render both characters, normalise, compare with SSIM. The
pipeline optimisations from M4 (pure JS Catmull-Rom, WASM SSIM workers,
fast-png decode, 32-bit integer pHash) make cross-script scanning at scale
practical.

### 26.1 Script selection

The 12 scripts were chosen from ICANN's list of scripts relevant to
internationalised domain names (IDN). These are the scripts most likely to
appear in domain names, usernames, package names, and other shared namespaces
where confusable attacks have practical consequences:

| # | Script | Unicode ranges | Characters |
|---|--------|---------------|------------|
| 1 | Latin | U+0041-005A, U+0061-007A, U+0030-0039 | 62 |
| 2 | Cyrillic | U+0400-052F (base + supplement) | 296 |
| 3 | Greek | U+0370-03FF | 114 |
| 4 | Arabic | U+0600-06FF, U+0750-077F | 220 |
| 5 | Han | U+4E00-9FFF (base block, no extensions) | 20,992 |
| 6 | Hangul | U+1100-11FF, U+3131-318E (jamo, not 11K syllables) | 350 |
| 7 | Katakana | U+30A0-30FF | 93 |
| 8 | Hiragana | U+3040-309F | 89 |
| 9 | Devanagari | U+0900-097F | 91 |
| 10 | Thai | U+0E00-0E7F | 67 |
| 11 | Georgian | U+10A0-10FF, U+2D00-2D2F | 127 |
| 12 | Armenian | U+0530-058F | 80 |
| | **Total** | | **22,581** |

Script assignment uses Unicode's `Scripts.txt` (the authoritative source for
the Script property), not the heuristic range-based `deriveScript()` from
earlier milestones. Only codepoints with General Category L* (Letter) or
N* (Number) are included. Characters with zero fontconfig coverage are
excluded.

The 12 scripts produce C(12,2) = 66 cross-script pairs. Each pair is scored
independently.

## 27. Methodology

### 27.1 Character set construction

`define-cross-script-sets.ts` constructs the 12 character sets:

1. Parse `Scripts.txt` from unicode.org to map every codepoint to its
   Unicode Script property
2. Parse `UnicodeData.txt` for General Category filtering (L* and N* only)
3. For each script, intersect the Script property with the range restrictions
   in the table above
4. Query fontconfig for per-character coverage across 230 system fonts
5. Exclude zero-coverage codepoints

Output: 22,581 characters across 12 scripts, written to
`data/output/cross-script-sets.json`.

Han dominates the character count (20,992 of 22,581 = 93%), which has
significant implications for pipeline design (section 27.4).

### 27.2 Rendering

`build-index-cross-script.ts` renders every character from all 12 scripts
in every covering font:

- Same 48x48 greyscale pipeline as all previous milestones
- Per-script output directories: `cross-script-index/{Script}/`
- pHash computed per render for prefiltering
- Resume capability per script via `progress.jsonl`
- Scripts processed sequentially; Han is the bottleneck

The rendering pipeline produced one index per script. Font coverage varies
widely: Latin characters appear in 74+ standard fonts while Han characters
average 7-8 CJK fonts each.

### 27.3 Scoring strategy

`score-cross-script.ts` scores all 66 cross-script pairs using the same
two-mode comparison as M1b/M2:

**Same-font comparison**: both characters rendered in the same font. A pHash
prefilter at 0.3 similarity skips pairs that are structurally dissimilar.
A width-ratio gate at 1.5x skips pairs where one character is much wider
than the other (catches CJK full-width vs Latin half-width mismatches).

**Cross-font comparison**: characters in different fonts, using top-1-by-pHash
to select the most promising font pairing. This avoids the O(F^2) explosion
of checking every font combination.

SSIM computation uses the WASM worker pool (13 threads) from the M4
pipeline, with fast-png decoding and pure JS Catmull-Rom normalisation on
the main thread.

### 27.4 Han optimisation

Han's 20,992 characters create asymmetric pairs: Latin-Han has 62 x 20,992
= 1.3M character pairs, while Latin-Greek has 62 x 114 = 7,047. Eleven of
66 pairs involve Han, and these dominate the computation.

Two optimisations were critical:

1. **Lightweight prefilter loading**: for Han pairs, the scorer first loads
   only metadata and pHash values (no pixel data) for the larger script.
   It runs the pHash prefilter to identify candidate characters, then loads
   pixel data only for candidates that pass. This keeps memory under control
   for scripts with 160K+ font-render entries.

2. **Fast integer pHash comparison**: the original `pHashSimilarity()` used
   BigInt arithmetic with a bit-by-bit Hamming distance loop (up to 64
   iterations per call). With billions of pHash comparisons for Han pairs,
   this was the bottleneck. Replacing it with 32-bit integer `popcount()`
   using parallel prefix bit manipulation reduced prefilter time from 20+
   minutes to seconds per Han pair.

### 27.5 Scale

| Metric | Value |
|--------|-------|
| Characters scanned | 22,581 |
| Cross-script pairs | 66 |
| Total character pairs scored | 23,629,492 |
| High-scoring pairs (>= 0.7) | 563 |
| Medium pairs (0.3-0.7) | 40,763 |
| Low pairs (< 0.3) | 23,588,166 |
| Total scoring time | 33.6 minutes |
| Platform | macOS 15.4, Apple M4 Max, 230 system fonts |

## 28. Results

### 28.1 Overall distribution

| Band | Count | % | Description |
|------|-------|---|-------------|
| High (>= 0.7) | 563 | 0.002% | Genuinely confusable |
| Medium (0.3-0.7) | 40,763 | 0.17% | Somewhat similar |
| Low (< 0.3) | 23,588,166 | 99.83% | Not visually confusable |
| **Total** | **23,629,492** | | |

The high-scoring rate (0.002%) is lower than any previous milestone (M1b:
3.5%, M2: 0.03%, M2b: 0.004%), which is expected: most cross-script pairs
involve scripts with no historical relationship and completely different
visual traditions.

Of the 563 discoveries:

| meanSsim range | Count | Description |
|----------------|-------|-------------|
| >= 0.9 | 46 | Near-identical; exploitable in most fonts |
| 0.8 to 0.9 | 99 | Highly similar; exploitable in best-matching fonts |
| 0.7 to 0.8 | 241 | Moderately similar; threshold confusables |
| < 0.7 (pixel-identical only) | 177 | Low mean but pixel-identical in specific fonts |

The 177 pairs with meanSsim below 0.7 are included because they are
pixel-identical (SSIM = 1.000) in at least one font. These are the same
pattern seen in M1b: a pair may average 0.05 SSIM across 60 fonts but score
1.000 in Phosphate, because Phosphate uses a blocky geometric style that
collapses many letterforms to the same outline.

### 28.2 Per-script-pair breakdown

The 36 script pairs with discoveries, sorted by yield:

| Script pair | Discoveries | Pairs scored | Top pair (meanSsim) |
|-------------|------------|-------------|---------------------|
| Cyrillic-Greek | 126 | 33,230 | І-Ι (0.983) |
| Latin-Cyrillic | 103 | 18,111 | I-Ӏ (0.975) |
| Latin-Greek | 86 | 7,047 | I-Ι (0.967) |
| Cyrillic-Arabic | 33 | 45,231 | Ӏ-ا (0.882) |
| Latin-Arabic | 24 | 10,903 | I-ا (0.882) |
| Greek-Arabic | 20 | 17,738 | Ι-ا (0.882) |
| Hangul-Han | 20 | 6,186,227 | ᅵ-丨 (0.999) |
| Cyrillic-Georgian | 13 | 17,759 | Ѕ-Ⴝ (0.871) |
| Arabic-Hangul | 11 | 33,651 | ا-ᅵ (0.887) |
| Armenian-Hangul | 11 | 11,291 | վ-ᆟ (0.768) |
| Cyrillic-Hangul | 10 | 53,332 | ј-ᅵ (0.923) |
| Latin-Han | 10 | 1,160,949 | l-丨 (0.900) |
| Greek-Han | 9 | 1,510,371 | Ι-丨 (0.875) |
| Arabic-Thai | 9 | 10,234 | ا-เ (0.874) |
| Cyrillic-Han | 8 | 3,800,757 | І-丨 (0.929) |
| Latin-Georgian | 8 | 4,742 | S-Ⴝ (0.871) |
| Latin-Hangul | 8 | 13,965 | l-ᅵ (0.870) |
| Greek-Hangul | 7 | 18,066 | Ι-ᅵ (0.870) |
| Cyrillic-Thai | 5 | 16,037 | ӏ-เ (0.914) |
| Armenian-Han | 4 | 713,519 | կ-刂 (0.750) |
| Greek-Georgian | 4 | 7,229 | ο-ჿ (0.756) |
| Greek-Thai | 4 | 5,917 | Ι-เ (0.862) |
| Hiragana-Katakana | 4 | 8,276 | へ-ヘ (0.747) |
| Katakana-Hangul | 4 | 26,442 | ロ-ᆷ (0.767) |
| Latin-Thai | 4 | 3,916 | I-เ (0.883) |
| Thai-Hangul | 3 | 17,094 | ๐-ㆁ (0.778) |
| Latin-Armenian | 3 | 3,427 | z-չ (0.738) |
| Cyrillic-Armenian | 2 | 12,400 | Ѓ-Ր (0.718) |
| Greek-Armenian | 2 | 4,703 | Ί-յ (0.765) |
| Katakana-Han | 2 | 1,939,443 | ヽ-丶 (0.762) |
| Arabic-Han | 1 | 2,231,068 | ٳ-亅 (0.766) |
| Armenian-Arabic | 1 | 7,604 | ձ-ۂ (0.702) |
| Armenian-Thai | 1 | 3,311 | Լ-เ (0.726) |
| Devanagari-Thai | 1 | 3,827 | ०-๐ (0.714) |
| Georgian-Devanagari | 1 | 4,319 | ი-० (0.701) |
| Georgian-Thai | 1 | 4,135 | Ⴈ-า (0.766) |

**30 script pairs produced zero discoveries:**

All Devanagari pairs (except Thai and Georgian), all Hiragana pairs (except
Katakana), all Katakana pairs (except Han and Hangul), and most Georgian
pairs produced no high-scoring matches. The zero-discovery pairs are:
Arabic-Devanagari, Arabic-Hiragana, Arabic-Katakana, Armenian-Devanagari,
Armenian-Georgian, Armenian-Hiragana, Armenian-Katakana, Cyrillic-Devanagari,
Cyrillic-Hiragana, Cyrillic-Katakana, Devanagari-Han, Devanagari-Hangul,
Devanagari-Hiragana, Devanagari-Katakana, Georgian-Arabic, Georgian-Han,
Georgian-Hangul, Georgian-Hiragana, Georgian-Katakana, Greek-Devanagari,
Greek-Hiragana, Greek-Katakana, Hiragana-Han, Hiragana-Hangul,
Latin-Devanagari, Latin-Hiragana, Latin-Katakana, Thai-Han, Thai-Hiragana,
Thai-Katakana.

These 30 null results are empirical evidence that registrars and platforms
can use to make informed policy decisions: these script combinations do not
require cross-script confusable checks, and can be safely allowed without
variant bundling at the 0.7 SSIM threshold.

### 28.3 Pixel-identical pairs

278 of 563 discoveries (49.4%) are pixel-identical (SSIM = 1.000) in at
least one font. All 278 fall within the Latin/Cyrillic/Greek triangle:

| Script pair | Pixel-identical pairs |
|-------------|---------------------|
| Cyrillic-Greek | 110 |
| Latin-Cyrillic | 90 |
| Latin-Greek | 78 |

No pixel-identical pair was found outside these three script pairs. This is
consistent with the historical relationship: Latin, Cyrillic, and Greek
derive from a common ancestor and share many letterforms that modern fonts
render with identical outlines.

**Pixel-identical pairs by font (top 10):**

| Font | Pixel-identical matches |
|------|----------------------|
| Phosphate | 135 |
| Arial | 21 |
| Copperplate | 14 |
| Savoye LET | 13 |
| Trattatello | 13 |
| Snell Roundhand | 9 |
| Luminari | 7 |
| Seravek | 7 |
| Tahoma | 6 |
| Menlo | 5 |

Phosphate accounts for 48.6% of all pixel-identical matches, consistent with
M1b findings where Phosphate had the highest danger rate (67.5%). Its blocky
geometric style collapses many visually distinct letterforms to identical
outlines. The remaining fonts show more selective identity: Arial produces
pixel-identical matches only for the most structurally similar pairs (I/І/Ι,
O/О/Ο, etc.), while decorative fonts like Savoye LET and Snell Roundhand
achieve identity through their stylised strokes.

**Negative meanSsim pairs**: 4 discoveries have negative mean SSIM (the
characters look *less* alike than random noise on average) but are
pixel-identical in Phosphate. These are:

| Pair | meanSsim | bestFont SSIM |
|------|----------|---------------|
| m (Latin) vs μ (Greek) | -0.081 | 1.000 |
| y (Latin) vs ύ (Greek) | -0.033 | 1.000 |
| y (Latin) vs υ (Greek) | -0.010 | 1.000 |
| ү (Cyrillic) vs ύ (Greek) | -0.002 | 1.000 |

These illustrate the same pattern as M1b: mean SSIM dramatically
understates the threat when one extreme font produces identity.

### 28.4 Most frequent confusable codepoints

The 563 discoveries involve 314 unique codepoints. The most frequent
characters reveal which forms are the universal confusable primitives:

| Count | Codepoint | Character | Script | Pattern |
|-------|-----------|-----------|--------|---------|
| 18 | U+0399 | Ι | Greek | Vertical stroke (uppercase) |
| 18 | U+0049 | I | Latin | Vertical stroke (uppercase) |
| 18 | U+04C0 | Ӏ | Cyrillic | Vertical stroke (Palochka) |
| 17 | U+0406 | І | Cyrillic | Vertical stroke (Ukrainian I) |
| 17 | U+006C | l | Latin | Vertical stroke (lowercase L) |
| 16 | U+0069 | i | Latin | Vertical stroke + dot |
| 16 | U+0627 | ا | Arabic | Vertical stroke (Alef) |
| 15 | U+0456 | і | Cyrillic | Vertical stroke + dot |
| 15 | U+0625 | إ | Arabic | Vertical stroke + dot below |
| 14 | U+04CF | ӏ | Cyrillic | Vertical stroke (lowercase Palochka) |
| 14 | U+0E40 | เ | Thai | Vertical stroke (Sara E) |
| 14 | U+03AF | ί | Greek | Vertical stroke + accent |
| 14 | U+0671 | ٱ | Arabic | Vertical stroke (Alef Wasla) |
| 13 | U+1175 | ᅵ | Hangul | Vertical stroke (jungseong I) |
| 13 | U+4E28 | 丨 | Han | Vertical stroke (CJK radical) |
| 13 | U+006F | o | Latin | Circle/oval |
| 13 | U+119D | ᆝ | Hangul | Vertical stroke (jongseong I) |
| 13 | U+0673 | ٳ | Arabic | Vertical stroke (Alef variant) |

The vertical stroke dominates: the top 18 codepoints by frequency are all
vertical stroke variants from 7 different scripts (Latin, Greek, Cyrillic,
Arabic, Thai, Hangul, Han). This is the universal confusable primitive: a
single vertical line is the minimal glyph form that every writing system
converges on independently.

## 29. Notable findings

### 29.1 The Latin/Cyrillic/Greek triangle

315 of 563 discoveries (56%) come from the three pairings between Latin,
Cyrillic, and Greek. These scripts share a direct historical lineage: Greek
begat Latin and (via Glagolitic) Cyrillic. Many uppercase letters were
borrowed directly with identical forms.

The triangle shows systematic confusability, not isolated cases:

**Uppercase identities** (all pixel-identical in multiple fonts):
- А/A/Α, В/B/Β (Greek has no equivalent), С/C/Ϲ, Е/E/Ε, Н/H/Η, І/I/Ι,
  К/K/Κ, М/M/Μ, О/O/Ο, Р/P/Ρ, Т/T/Τ, Х/X/Χ, У/Y/Υ

**Lowercase identities**:
- а/a/α (not identical in most fonts due to Cyrillic a-form), с/c/ϲ,
  е/e/ε (partial), і/i/ι (partial), о/o/ο, р/p/ρ, ѕ/s (no Greek s-form),
  ј/j/ϳ, х/x/χ (partial)

This triangle is the foundation of IDN homograph attacks. A domain like
"аpple.com" (Cyrillic а) is visually indistinguishable from "apple.com" in
most fonts. Our data confirms this is not just a handful of characters: it
is a systematic property of these three scripts, with 315 exploitable pairs
and 278 pixel-identical instances.

### 29.2 The vertical stroke family

162 of 563 discoveries (28.8%) involve characters that render as a vertical
stroke. This family spans 8 of 12 scripts:

- **Latin**: I, l, i, j, 1
- **Cyrillic**: Ӏ (Palochka), І (Ukrainian I), ӏ, і
- **Greek**: Ι (Iota), ι, ί
- **Arabic**: ا (Alef), إ, أ, ٱ, ٲ, ٳ
- **Thai**: เ (Sara E)
- **Hangul**: ᅵ (jungseong I), ᆝ (jongseong I), ㅣ
- **Han**: 丨 (CJK vertical stroke), 亅 (CJK hook)
- **Armenian**: Լ (partial, with hook)

The top-scoring cross-script pair in the entire dataset is a vertical stroke
pair: Hangul ᅵ (U+1175) vs CJK 丨 (U+4E28) at SSIM 0.999 in Arial
Unicode MS. The Thai character เ (Sara E) is a vertical stroke that appears
as a confusable across 7 other scripts.

The vertical stroke is the universal confusable primitive because it is
the simplest possible glyph: a single vertical line. Writing systems
independently converge on this form for basic phonemes (vowels, consonants)
and basic numerals.

### 29.3 Arabic crossover

Arabic produces 99 discoveries across 10 script pairs. Arabic's visual
system differs from Latin-based scripts: it is right-to-left, cursive, and
context-dependent (initial/medial/final forms). Yet isolated Arabic letters
produce confusables because the isolated forms of Arabic vertical-stroke
characters (Alef ا and its variants) look like vertical strokes in any
script.

The top Arabic confusables are all Alef variants:
- ا (U+0627, Alef) appears in 16 discoveries across 7 scripts
- إ (U+0625, Alef with Hamza Below) appears in 15 discoveries
- ٱ (U+0671, Alef Wasla) appears in 14 discoveries
- ٳ (U+0673, Alef variant) appears in 13 discoveries
- أ (U+0623, Alef with Hamza Above) appears in 12 discoveries

The practical risk depends on context. In running Arabic text, these
characters are contextually shaped and clearly Arabic. But in isolated
contexts (usernames, package names, URLs), the isolated Alef form is a
vertical stroke that is confusable with Latin l, Greek Ι, Cyrillic І,
Hangul ᅵ, Thai เ, and Han 丨.

Arabic also shows cross-script connections with Thai: آ (Alef with Madda)
vs Thai โ (Sara Oo) at 0.810, and Arabic digits ١/۱ vs Thai โ at 0.726.

### 29.4 CJK and Hangul crossover

The East Asian scripts produce 100 discoveries, concentrated in simple
stroke characters rather than complex ideographs:

**Hangul-Han (20 discoveries)**: the highest-yield East Asian pair.
Hangul jamo (the component parts of Korean syllables) include several
simple geometric forms that match CJK stroke radicals:

| Hangul | Han | Shape | meanSsim |
|--------|-----|-------|----------|
| ᅵ (U+1175) | 丨 (U+4E28) | Vertical stroke | 0.999 |
| ㅡ (U+3161) | 一 (U+4E00) | Horizontal stroke | 0.934 |
| ᄆ (U+1106) | 口 (U+53E3) | Rectangle | 0.793 |
| ᆂ (U+1182) | 士 (U+58EB) | Cross/plus | 0.787 |
| ᆠ (U+11A0) | 十 (U+5341) | Cross/plus | 0.775 |
| ᄂ (U+1102) | 匚 (U+531A) | Right angle | 0.754 |

These pairs confirm the classic CJK/Korean confusable relationship
empirically. The vertical stroke ᅵ/丨 pair at 0.999 is the single
highest-scoring discovery in the entire M5 dataset.

**Katakana-Han (2 discoveries)**: ヽ (Katakana iteration mark) vs 丶 (CJK
dot) at 0.762, and ロ (Katakana Ro) vs 口 (CJK mouth radical) at 0.713.
The ロ/口 pair is a classic confusable well known to CJK typography.

**Hiragana-Katakana (4 discoveries)**: へ (Hiragana He) vs ヘ (Katakana He)
at best-font SSIM 0.996. These are the same character borrowed between the
two Japanese kana systems, and they render nearly identically.

**Han discoveries across all pairs**: Han characters appear in 54 total
discoveries, but only 18 distinct Han codepoints are involved: 丨 (vertical
stroke), 一 (horizontal stroke), 丅 (below), 丁 (ding), 口 (mouth), 亅
(hook), 丶 (dot), 刂 (knife radical), 丫 (fork), 丿 (slash), 丩 (hook),
士 (scholar), 十 (ten), 土 (earth), 干 (dry), 匚 (box), 凵 (open box),
乚 (second). All 18 are simple stroke radicals from the first few hundred
entries of the CJK Unified Ideographs block. Of the 20,992 Han characters
scanned, 99.9% produced no high-scoring match against any other script,
confirming that complex ideographs are structurally incompatible with the
character forms of all other scripts.

### 29.5 Caucasian scripts: Georgian and Armenian

Georgian and Armenian are historically proximate scripts from the Caucasus
region. Despite this, the Armenian-Georgian pair produced zero discoveries,
suggesting that despite geographic proximity, these scripts have diverged
sufficiently that no character pair crosses the 0.7 SSIM threshold.

**Georgian (27 discoveries across 6 script pairs)**:

Georgian's rounded Mkhedruli letterforms produce several cross-script
confusables:
- Ⴝ (U+10BD) vs Latin S and Cyrillic Ѕ: SSIM 0.871. The Georgian capital
  Ⴝ has an S-like curve.
- Ⴙ (U+10B9) vs Cyrillic Ь: SSIM 0.827. The Georgian letter resembles the
  Cyrillic soft sign.
- ჿ (U+10FF) vs Latin o, Cyrillic о, Greek ο: SSIM 0.775/0.774/0.756.
  A circular Georgian character.
- ი (U+10D8) vs Cyrillic о, Greek ο, Latin o: SSIM 0.750/0.747/0.741.
  Georgian's lowercase i is a circular form.
- ი (U+10D8) vs Devanagari ० (zero): SSIM 0.701. A cross-family connection
  through the circular form, linking Caucasian and Indic scripts.

**Armenian (24 discoveries across 8 script pairs)**:

Armenian's discoveries are more varied:
- չ (U+0579) vs Latin z, Greek Ζ: SSIM 0.738/0.709. The Armenian che
  resembles a rotated z.
- Ր (U+0550) vs Latin r, Cyrillic Ѓ: SSIM 0.725/0.718. The Armenian
  letter resembles a tall r.
- վ (U+057E) appears in 8 discoveries, mostly against Hangul jamo. Its
  open angular form resembles several Hangul vowel components.
- կ (U+056F) and վ (U+057E) vs Han 刂 (knife radical): SSIM 0.750/0.738.
  These angular Armenian letters resemble the two-stroke CJK radical.

### 29.6 Thai connections

Thai produces 28 discoveries across 8 script pairs, dominated by one
character: เ (U+0E40, Sara E), which appears in 14 discoveries. Sara E is
a vertical stroke in Thai's vowel system, and it connects to vertical stroke
characters across 7 other scripts.

Other Thai connections:
- โ (U+0E42, Sara Oo) vs Arabic آ and ٱ: SSIM 0.810/0.768. The Thai vowel
  marker resembles Arabic Alef variants.
- ๐ (U+0E50, Thai zero) vs Hangul ㆁ, ᇰ, ᄋ: SSIM 0.778/0.778/0.737.
  The Thai zero digit is a circle that matches Korean ieung-derived forms.
- ๐ (U+0E50) vs Cyrillic ѻ: SSIM 0.727. Cross-family circle match.
- ๐ (U+0E50, Thai zero) vs Devanagari ० (zero): SSIM 0.714. Zero digits
  from different numeral systems that converge on the circle form.

The Thai-Devanagari zero pair (๐ vs ०) is notable: two independent numeral
systems both using a circle for zero, producing visual confusability between
scripts that share no historical relationship.

### 29.7 Indic: Devanagari

Devanagari produced only 2 discoveries across all 66 pairs:
- ० (U+0966, Devanagari zero) vs Thai ๐ (U+0E50): SSIM 0.714
- ० vs Georgian ი (U+10D8): SSIM 0.701

Both are circle-form matches. Devanagari's distinctive headline bar
(shirorekha) and complex conjunct ligatures make its letterforms
structurally distinct from all other scripts. Only the numeral zero, which
is a universal geometric primitive, produces cross-script confusability.

## 30. Comparison with previous milestones

### 30.1 Discovery rates

| Milestone | Characters | Pairs scored | Discoveries | Rate |
|-----------|-----------|-------------|-------------|------|
| M1b (TR39 validation) | 1,452 | 235,625 | 49 (high mean) | 3.5% |
| M2 (novel, excl CJK) | 23,317 | 2,904,376 | 793 | 0.03% |
| M2b (CJK verification) | 122,862 | 8,036,479 | 69 | 0.004% |
| **M5 (cross-script)** | **22,581** | **23,629,492** | **563** | **0.002%** |

M5 scored the most pairs (23.6M) but found the lowest discovery rate
(0.002%). This is expected: Latin-vs-X comparisons (M1b, M2, M2b) benefit
from the fact that Latin's simple geometric forms (l, i, o, c) have
equivalents in many scripts, while most cross-script pairs involve scripts
with no shared forms.

### 30.2 Overlap with previous discoveries

M5 operates on a different axis than M1b/M2/M2b. Previous milestones
compared everything against Latin a-z/0-9 targets. M5 compares scripts
against each other, including Latin-vs-X comparisons but also 55 non-Latin
pairs.

The 315 Latin-triangle discoveries (Latin-Cyrillic, Latin-Greek,
Cyrillic-Greek) overlap substantially with M1b's TR39 validation data.
Characters like Cyrillic С (U+0421) and Greek Ο (U+039F) appeared as
confusables of Latin C and O in M1b. M5 adds the third edge of each
triangle: Cyrillic С vs Greek Ϲ (U+03F9), which M1b and M2 never tested
because neither script was a target.

The remaining 248 discoveries (44%) are entirely new: they involve pairs
between non-Latin scripts (Arabic-Hangul, Georgian-Cyrillic, Thai-Arabic,
etc.) that no previous milestone could have found.

### 30.3 The vertical stroke across milestones

Every milestone has been dominated by vertical stroke characters:
- M1b: "l" and "I" lookalikes are the highest-scoring TR39 pairs
- M2: 47.5% of discoveries are vertical stroke characters
- M2b: 18 of 28 source characters are vertical strokes
- M5: 162 of 563 discoveries (28.8%) are vertical stroke pairs, spanning
  8 of 12 scripts

The vertical stroke is the universal confusable primitive. It is the
simplest possible glyph form, and every writing system converges on it
independently for basic phonemes and numerals.

## 31. Assessment

### 31.1 Practical risk

The 563 discoveries fall into three risk tiers:

**Tier 1: High risk (Latin/Cyrillic/Greek, 315 pairs)**. These are the
well-known IDN homograph vectors. Most are already in TR39 confusables.txt
(as Latin-target mappings) but M5 provides the missing Cyrillic-Greek edges.
278 are pixel-identical in at least one font. These pairs are exploitable
today in any context that displays Unicode text: domain names, usernames,
package names, source code identifiers.

**Tier 2: Moderate risk (Arabic/Thai/Hangul crossover, ~150 pairs)**.
Arabic Alef variants confusable with vertical stroke characters from
multiple scripts. Thai Sara E confusable across 7 scripts. Hangul jamo
confusable with CJK stroke radicals. These are exploitable in specific
contexts: Arabic/Thai/Korean user interfaces, mixed-script usernames,
internationalised domain names targeting non-Latin audiences.

**Tier 3: Low risk (single-font, low-coverage pairs, ~100 pairs)**.
Georgian, Armenian, and Devanagari pairs that are confusable only in
specific fonts with limited coverage. The practical risk is bounded by
font availability.

### 31.2 Implications for TR39

TR39 confusables.txt maps everything to Latin prototypes. M5 reveals two
gaps:

1. **Missing non-Latin edges**: Cyrillic С (U+0421) is mapped to Latin C,
   and Greek Ϲ (U+03F9) is mapped to Latin C, but TR39 does not explicitly
   model the Cyrillic-Greek edge. The skeleton() algorithm handles this
   transitively (both reduce to "c"), but M5 provides direct empirical
   evidence for each cross-script edge.

2. **Non-Latin-target confusables**: Arabic ا vs Hangul ᅵ (0.887), Thai
   เ vs Cyrillic ӏ (0.914), Georgian Ⴝ vs Cyrillic Ѕ (0.871). These
   pairs have no Latin character involved and are invisible to TR39's
   Latin-centric model. A system protecting only against Latin spoofing
   will miss these vectors entirely.

### 31.3 Implications for namespace-guard

namespace-guard v0.16.0+ consumes `confusable-weights.json` for measured
visual risk scoring. M5's cross-script discoveries can extend this:

- The 248 non-Latin-triangle discoveries are entirely new edges not present
  in the M1b/M2 weight file
- Cross-script weights enable mixed-script username collision detection
  (e.g., blocking a Korean username that visually matches a Chinese one)
- The domain context filter can be extended to flag cross-script pairs
  from ICANN-relevant scripts

### 31.4 Limitations specific to M5

Several factors affect the interpretation of M5 results:

- **Arabic contextual shaping.** Arabic characters were scored in isolated
  form. In running text, Arabic letters take initial, medial, and final
  forms through contextual shaping. Many of the Arabic Alef family
  discoveries (which dominate Arabic's 99 cross-script matches) would be
  less confusable in their contextually shaped forms within connected text.
  The isolated-form scores represent the worst case (usernames, package
  names, isolated identifiers).
- **Thai combining vowels.** Thai vowel characters like เ (Sara E) were
  scored as isolated codepoints, missing the visual context of their base
  consonant. In Thai text, these vowels attach to consonants and are not
  seen in isolation. The scores apply to contexts where Thai characters
  appear individually (e.g., transliteration, identifier components).
- **macOS-only font coverage.** All milestones use macOS system fonts, but
  non-Latin script font availability varies more by platform than Latin
  font availability. A discovery found in one macOS font may not be
  reproducible on Windows or Linux if the font is not available, and
  conversely, platform-specific fonts may produce additional discoveries
  not captured here.
- **48x48 resolution.** The fixed 48x48 greyscale canvas may miss fine
  details that distinguish characters at larger rendering sizes. Some
  pairs that score above 0.7 at 48x48 may be more easily distinguished
  at higher resolutions.
- **Same-font constraint.** Cross-script SSIM requires both characters to
  share a font. Many script pairs have very low font overlap (e.g.,
  Georgian-Katakana shares only 3 fonts out of 230). Low font overlap
  limits the statistical power of the scores and may miss confusable
  pairs that would emerge in fonts not present on macOS.

## 32. Reproducibility

### 32.1 Milestone 5

```bash
npx tsx scripts/define-cross-script-sets.ts      # Define 12 script character sets (~2 min)
npx tsx scripts/build-index-cross-script.ts       # Render all characters (~75 min, dominated by Han)
npx tsx scripts/score-cross-script.ts             # Score all 66 pairs (~34 min, 23.6M comparisons)
npx tsx scripts/extract-cross-script.ts           # Extract discoveries + summary
```

All four scripts support crash recovery via `progress.jsonl` and auto-resume.

Single-pair mode is available for targeted re-runs:
```bash
npx tsx scripts/score-cross-script.ts --pair Latin-Han
```

### 32.2 Output files

**Committed (CC-BY-4.0):**
- `data/output/cross-script-discoveries.json` -- 563 cross-script confusable pairs
- `data/output/cross-script-summary.json` -- per-pair distribution counts and top pairs

**Generated (gitignored, run pipeline to regenerate):**
- `data/output/cross-script-sets.json` -- 22,581 characters across 12 scripts
- `data/output/cross-script-index/` -- per-script render PNGs + index.json
- `data/output/cross-script-scores/` -- per-pair gzipped score files (66 files)

---

## Appendix A: Standard fonts used for target rendering (74)

Academy Engraved LET, American Typewriter, Andale Mono, Apple Chancery,
Arial, Arial Black, Arial Narrow, Arial Rounded MT Bold, Arial Unicode MS,
Athelas, Avenir, Avenir Next, Avenir Next Condensed, Baskerville,
Big Caslon, Bodoni 72, Bodoni 72 Oldstyle, Bodoni 72 Smallcaps,
Bradley Hand, Brush Script MT, Chalkboard, Chalkboard SE, Chalkduster,
Charter, Cochin, Comic Sans MS, Copperplate, Courier New, Didot,
DIN Alternate, DIN Condensed, Futura, Galvji, Geneva, Georgia, Gill Sans,
Helvetica, Helvetica Neue, Herculanum, Hoefler Text, Impact,
Iowan Old Style, Lucida Grande, Luminari, Marion, Marker Felt, Menlo,
Microsoft Sans Serif, Monaco, Noteworthy, Optima, Palatino, Papyrus,
Party LET, Phosphate, PT Mono, PT Sans, PT Serif, PT Serif Caption,
Rockwell, Savoye LET, Seravek, SignPainter, Skia, Snell Roundhand,
Superclarendon, System Font, Tahoma, Times, Times New Roman, Trattatello,
Trebuchet MS, Verdana, Zapfino

## Appendix B: Prior art

- **GlyphNet** (Gupta et al. 2023, arXiv:2306.10392): CNN-based domain-level
  homoglyph classification. Found greyscale outperforms colour, 256x256
  optimal for CNN features, no augmentation for glyphs. Different scope
  (domain binary classification vs character pairwise scoring). Reference
  only -- no code incorporated (GPL licence ambiguity in their repo).

- **Unicode TR39** (Unicode Technical Report #39): Defines confusables.txt
  and the skeleton() algorithm. TR39's transitive closure and substring
  decomposition (UTS #39 Section 4) create over-inclusive edges that are
  necessary for skeleton() equivalence but visually low-risk. Our data
  confirms this: 96.5% of entries are not high-risk when measured by
  per-font SSIM.

- **dnstwist**: Domain name permutation tool that includes homoglyph
  generation. Useful cross-reference for milestone 2 (novel confusable
  discovery).
