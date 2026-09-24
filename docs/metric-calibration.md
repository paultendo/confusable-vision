# RaySpace metric calibration (release 2)

September 2026. How the release 2 scoring differs from the March 2026 run, and the tests behind each change.

## Why it changed

Testing the March scores against pairs whose answer is known turned up four problems.

1. **Size and height were invisible.** Rays are spread across each glyph's own bounding box and crossing positions
   are fractions of it, so a signature is the same at any size or height. In running text every character sits at
   one size on one baseline, so o and O, or D and o, look different however alike their shapes. The March scores put
   ten ASCII case pairs (C/c, V/v, X/x and others) below 0.5.
2. **Scores were averaged only where a pair was found.** A pair's mean distance was taken over the fonts where it
   came out alike, never over the fonts that render both characters and show them as different. A pair alike in 12
   of 127 fonts (small-capital and all-caps faces) looked as strong as one alike almost everywhere.
3. **Shape differences barely counted.** The distance adds squared differences of crossing positions, angles and
   stroke widths (each on a 0 to 1 scale) to a flat 1.0 for every unmatched crossing. Squaring shrinks a real
   difference: a crossing a quarter of the glyph away adds 0.06. So the distance was mostly a count of crossings. D and
   O, both rings, scored 0.39 in Arial, where 95% of that came from crossing counts and 0.012 from the stem against the
   curve; 0 and O, a true lookalike, scored 0.20.
4. **The constants were never checked against known answers.** The weights (0.3 for angles and stroke widths, 1.0 per
   unmatched crossing, squared errors, an even split of mean and worst angle) arrived with the scorer on 2 March 2026
   with no stated basis. The only validation compared RaySpace with another derived measure (SDF), not with pairs
   people confuse.

## What release 2 does

- **Geometry counts linearly, with weight** (`compareGeometric` in `src/signature-bank.ts`): absolute differences, and
  the geometry terms multiplied by 3.
- **A size gate** (`scripts/compute-glyph-boxes.ts`, `scripts/rescore-pairs.ts`): a font only counts when the two
  glyphs' tops and bottoms, in em units from the baseline, agree within 0.12 em, and their ink widths within 25% of the
  wider. Both were calibrated on the labelled pairs. Widths up to 25% and heights up to 0.15 em admitted no false match;
  at 0.2 em the case pairs (O/o, S/s, V/v, W/w, X/x, whose heights differ by 0.17 to 0.22 em) come in. The width
  tolerance keeps 0/O (in proportional fonts the zero is 21 to 34% narrower than O), and 0.12 em keeps Thai zero against
  o, which Thai fonts draw 0.10 to 0.21 em shorter than Latin o. A first version fixed both at 0.06 em without testing,
  and lost both pairs.
- **The share of fonts**: each pair records how many fonts render both characters and how many show them alike, so a
  font-specific quirk stays one. Shares are counted over text fonts: handwriting, display and symbol faces
  (`src/display-fonts.ts`) are left out, since a pair that only matches in a brush script is not a lookalike where
  confusables matter.
- **Roboto**, the Latin face on Android and much of the web, is added to the bank from the official Android build
  (`scripts/add-font-to-bank.ts`, a side bank beside the system fonts).
- **Across fonts** (`scripts/score-cross-font.ts`): a browser draws a character its page font lacks in a fallback font,
  next to Latin in the page font. Within-font scoring cannot see that, and most rare-script characters are only drawn by
  fonts with no Latin letters at all. Distances across fonts are larger for everything (the same letter in two text
  fonts has a median distance of 0.98; different letters, 1.82), so the test is relative. Character x in font F looks
  like target t in reference font R (Roboto and 20 common text faces) when its shape and size gaps to t@R are no larger
  than the median gaps between t@R and t in the other reference fonts, t is the nearest ASCII letter or digit to x@F,
  and the distance is at most 0.98. The share is over (F, R) combinations.

Because every term of the new distance is at least as large as the March one, a pair the March run ruled out stays
ruled out, and only discovered pairs need re-scoring.

**Anchored to the baseline** (`normalizeToEmFrame` and a fixed em frame in `computeEnrichedSignature`): the box
gate above was replaced by a second signature, with rays across one em frame for every glyph (1.1 em above the baseline
to 0.3 em below, the glyph centred on its advance), so size and baseline position are part of the distance. On its own
it blurs small features (a dot is only a few rays; i came out like l), so it is used alongside the box signature: a font
counts when the box shape distance is below 0.5 and the anchored distance below 0.2. The tolerances on tops, bottoms and
widths remain only as the fallback where no anchored signature exists.

| Rule (26 text fonts including Roboto) | ASCII kept | ASCII false | Held-out kept | Held-out false |
|---|---|---|---|---|
| box shape, tops/bottoms within 0.12 em, widths within 25% | 4 of 8 | 0 | 17 of 23 | 0 |
| anchored distance only, below 0.2 | 6 of 8 | 2 (I/i, i/l) | 19 of 23 | 4 (l/і, n/η, n/π, n/п) |
| box shape below 0.5 and anchored below 0.2 | 5 of 8 | 0 | 17 of 23 | 0 |
| box shape below 0.5 and anchored below 0.3 | 6 of 8 | 0 | 17 of 23 | 1 (l/ι) |

The labelled sets are small (31 lookalikes), so a difference of one pair is close to noise; the combined rule is at
least as good as the tolerances and needs none of them. `scripts/calibrate-em.ts` reproduces the table.

**Viewing size** is not modelled yet. At small sizes (a phone address bar) readers miss dots and serifs that these
measurements keep, so a pair can be distinct here and still be confused at 11 px. Rasterising each glyph at a given
size with the platform's own rendering, and calibrating against published human letter-confusion data, is the next
step.

## Tests

Distances below 0.5 count as alike; a pair's share is the fraction of fonts rendering both where it is alike at the
same size. Twenty-five common text fonts (Arial, Helvetica, Times New Roman, Georgia, Verdana and others).

**ASCII letters and digits.** Every pair is distinct except TR39's own ASCII mappings (0/O, I/l, 1/l, 1/I, l/|, I/|)
and 0/o. This set was used to choose between variants, so it is a development set.

| Variant | Lookalikes kept (share ≥ 0.1) | Distinct pairs flagged |
|---|---|---|
| March (squared, weight 1) | 5 of 8 | 7, including D/O in 48% of fonts, c/o, O/Q, F/P |
| absolute, weight 1 | 5 of 8 | 3 |
| absolute, weight 3 | 5 of 8 | 0 |

**Held out: Latin lowercase against Cyrillic and Greek lowercase.** Not used in choosing. TR39's 23 mappings between
these are the lookalikes; every other pairing counts as distinct.

| Variant | Lookalikes kept (share ≥ 0.1) | Distinct pairs flagged |
|---|---|---|
| March | 20 of 23 | 10: c/о, c/ο, o/с, o/ԍ, n/п (48% of fonts), e/є, o/α, n/π, x/χ, c/ԍ |
| absolute, weight 3 | 18 of 23 | 1: x/χ |

The two further misses are σ/o and г/r, which only look alike in some fonts. Both variants miss α/a, ι/i and ш/w.

**The rules as used** (text fonts, Roboto included; alike in at least 3 text fonts, or in all of them when fewer than 3
render both, and at least 5% of the text fonts rendering both). The cap matters for scripts few fonts can draw: Hangul
jamo ᅵ against Han 丨 is identical in the one font that renders both, and would otherwise be ruled out by the count
alone. Earlier results with the first rules: on ASCII, I/l and 0/o are kept with no false matches; held out, 19 of 23 TR39 lookalikes are kept
(missing ι/i, σ/o, г/r, ш/w) and n/п and x/χ are flagged, both arguably real in some fonts.

**Across fonts, held out** (the same Latin/Cyrillic/Greek set, each character in its own fonts against the reference
fonts): with the relative floor alone, 18 of 23 kept and 1 false match at a share of 0.1, but a check of the proposals
showed the floor stretching where the reference font is an outlier (a Courier i, a Times E): Bengali ঢ came out like
E. With the nearest-letter condition and the cap added, 17 of 23 are kept and there are no false matches.

## Limits

- The weight of 3 was chosen from three variants, not fitted. A fitted version needs a larger labelled set and a
  held-out split.
- Only macOS system fonts and Roboto are measured. Windows fonts and the rest of the Noto family are not yet in the
  bank, though macOS ships the Noto faces for most rare scripts.
- Letters with a small mark below or above (ạ, ẹ, ọ, ṇ) fail the size gate, since the mark extends the glyph's box,
  yet a reader can miss it. That class is better handled by a rule than by pairs: namespace-guard's
  `ignoreDiacritics` option removes these marks before comparing.
- Same-script pairs inside the twelve March script sets were not compared; the pair list covers everything registrable
  against ASCII letters and digits.

## Reproducing release 2

The signature bank (`data/output/signature-bank.jsonl.gz`, 7.8 GB) and the March discoveries are not in the repository;
set `CV_BANK` to a local copy of the bank if it lives on another drive.

1. `npx tsx scripts/score-pairs-from-bank.ts <pairs.json> data/output/registrable-ascii-discoveries.jsonl`: the
   registrable characters against ASCII (pair list built from `data/input/idn-registrable.json`).
2. `npx tsx scripts/add-font-to-bank.ts <Roboto-Regular.ttf> Roboto data/output/signature-bank-roboto.jsonl.gz`, then
   `score-pairs-from-bank.ts --font Roboto` over Roboto's letters and digits.
3. `npx tsx scripts/compute-glyph-boxes.ts <discoveries>... > data/output/glyph-boxes.jsonl`.
4. `npx tsx scripts/rescore-pairs.ts <discoveries>... > data/output/rescored-pairs.jsonl`.
5. `npx tsx scripts/score-cross-font.ts <pairs.json> data/output/cross-font-pairs.jsonl --fallback-only`, and
   `--validate` for the held-out check.
6. `npx tsx scripts/build-release.ts <version>`, `scripts/export-idn-pairs.ts` and `scripts/build-unicode-submission.ts`.
