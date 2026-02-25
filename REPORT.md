# confusable-vision: Technical Report

**Visual similarity scoring of Unicode confusables across 230 macOS system fonts**

Paul Wood FRSA (@paultendo) -- 25 February 2026

---

## 1. Executive summary

confusable-vision renders Unicode character pairs across all macOS system fonts,
measures visual similarity using SSIM and pHash, and produces per-font scored
JSON artifacts. This report covers two analyses:

- **Milestone 1b** -- validation of 1,418 pairs from Unicode TR39
  confusables.txt across 230 system fonts (235,625 SSIM comparisons).
  Scope: single-codepoint-to-single-codepoint mappings with targets
  restricted to Latin a-z and digits 0-9 (SL mapping type only).
  Multi-character and non-Latin-target mappings are excluded.
- **Milestone 2** -- novel confusable discovery by scanning 23,317
  identifier-safe Unicode characters not in confusables.txt against Latin
  a-z/0-9 across 230 fonts (2,904,376 SSIM comparisons).

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
   structurally different from Latin and would produce only false positives

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
it means its scope is different. Confusables.txt focuses on characters that
map to the same skeleton under NFKC normalisation, which is a character-
property test, not a visual test. Many visually similar characters have
different NFKC mappings and are therefore excluded.

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
| IDNA PVALID | 657 | 82.8% | IDNA 2008 IdnaMappingTable.txt |
| TR39 Allowed | 60 | 7.6% | TR39 IdentifierStatus.txt |
| XID_Continue AND IDNA PVALID | 591 | 74.5% | Cross-product |

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
