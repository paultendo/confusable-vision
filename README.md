# confusable-vision

Offline tool that renders Unicode [confusable](https://unicode.org/Public/security/latest/confusables.txt) character pairs across system fonts, measures visual similarity using [SSIM](https://en.wikipedia.org/wiki/Structural_similarity_index_measure), and outputs scored JSON artifacts.

## Key findings

### Milestone 1b -- TR39 confusable pairs

Scored 1,418 TR39 confusable pairs across 230 macOS system fonts (235,625 SSIM comparisons):

- **96.5% of confusables.txt is not high-risk.** Only 49 pairs (3.5%) score >= 0.7 mean SSIM. Median is 0.322.
- **82 pairs are pixel-identical** (SSIM 1.000) in at least one font. These are undetectable by visual inspection.
- **47 pairs have negative SSIM** -- less similar than random noise. These are false positives from a visual perspective.
- **Same-font comparisons average 0.536 SSIM; cross-font average 0.339.** The font pairing matters as much as the character pairing.
- **Font danger rates vary from 0% (Zapfino) to 67.5% (Phosphate).** Font choice is a meaningful variable in confusable risk.

### Milestone 2 -- novel confusable discovery

Scanned 23,317 identifier-safe Unicode characters (not in confusables.txt) against Latin a-z/0-9 across 230 fonts (2,904,376 SSIM comparisons):

- **793 novel high-risk pairs discovered** (mean SSIM >= 0.7) that are NOT in TR39 confusables.txt.
- **Top discovery: U+A7FE LATIN EPIGRAPHIC LETTER I LONGA** scores 0.998 SSIM against "l" in Geneva -- near pixel-identical.
- Most high-scoring novel pairs are vertical stroke characters from obscure scripts (Pahawh Hmong, Nabataean, Duployan, Hatran, Mende Kikakui) that render as "l" or "i" lookalikes.
- Notable non-obvious finds: Gothic U+10347 vs "x" (0.94), Coptic U+2CAD vs "x" (0.93), Javanese U+A9D0 vs "o" (0.96), Khmer U+17F4 vs "v" (0.93).

### Milestone 3 -- weighted edges and namespace-guard integration

Post-processing of M1b and M2 data:

- **903 weighted edges** computed (`confusable-weights.json`) with per-pair same-font/cross-font statistics, danger (max SSIM), stableDanger (p95 SSIM), and cost (1 - stableDanger).
- **Zero glyph reuse** across all 85 pixel-identical pairs. Modern fonts assign separate cmap glyph IDs even when outlines are identical.
- **74.5% of novel discoveries** (591/793) are both XID_Continue and IDNA PVALID -- usable in both JavaScript identifiers and domain names.
- **namespace-guard v0.16.0** integrates weights via optional `weights` parameter in `confusableDistance()`, with context-dependent filtering (`identifier`, `domain`, `all`).

Full analysis: [REPORT.md](REPORT.md) | Blog post: [paultendo.github.io/posts/confusable-vision-visual-similarity](https://paultendo.github.io/posts/confusable-vision-visual-similarity/)

## How it works

Two pipelines:

### Milestone 1b (TR39 validation)

1. **build-index** -- renders all 1,418 source characters and 34 target characters as 48x48 greyscale PNGs, one per font that natively contains the character. Fontconfig is queried per-character to skip fonts that lack coverage (97% reduction: 8,881 targeted renders vs 326,140 brute-force).

2. **score-all-pairs** -- loads the render index and computes SSIM for every valid source/target combination across two modes: same-font (both characters in one font) and cross-font (source in supplemental font, target in standard font).

### Milestone 2 (novel discovery)

1. **build-candidates** -- parses UnicodeData.txt for all Letter/Number codepoints, excludes CJK/Hangul/logographic scripts and existing TR39 sources, queries fontconfig for coverage. Produces 23,317 candidates.

2. **build-index --candidates** -- renders all candidates in fonts that natively contain them (89,478 PNGs across 230 fonts).

3. **score-candidates** -- compares each candidate against Latin a-z/0-9 targets. Same-font comparisons use a pHash prefilter; cross-font uses top-1-by-pHash to avoid the O(74) explosion per source render.

4. **extract-discoveries** -- extracts high-scoring pairs from both pipelines into compact, licenced JSON files for distribution.

### Design choices

- **Greyscale rendering** -- [Gupta et al. 2023 ("GlyphNet")](https://arxiv.org/abs/2306.10392) found greyscale outperforms colour for glyph comparison
- **No image augmentation** -- flipping/rotating characters creates unrealistic glyphs
- **SSIM over learned embeddings** -- deterministic, reproducible, no training data or GPU required
- **Fontconfig-targeted rendering** -- only render characters in fonts that actually contain them

No GlyphNet code is incorporated (GPL licence ambiguity in their repository).

### Font discovery

Rather than a hardcoded font list, confusable-vision auto-discovers every system font with Latin a-z coverage:

```bash
fc-list ':charset=61-7A' --format='%{file}|%{family[0]}\n'
```

| Category | Count | Purpose |
|----------|-------|---------|
| standard | 74 | Latin-primary fonts (Arial, Menlo, Georgia, Helvetica, etc.) |
| script | 49 | CJK, Indic, Thai fonts that also contain Latin glyphs |
| noto | 103 | Noto Sans variants for non-Latin scripts |
| math | 3 | STIX Two Math, STIX Two Text, STIXGeneral |
| symbol | 1 | Apple Symbols |
| **Total** | **230** | |

## Quick start

```bash
npm install

# Milestone 1b: TR39 confusable pairs
npx tsx scripts/build-index.ts          # Build render index (~160s, 11,370 PNGs)
npx tsx scripts/score-all-pairs.ts      # Score all pairs (~65s, 235,625 comparisons)
npx tsx scripts/report-stats.ts         # Generate report statistics

# Milestone 2: novel confusable discovery
npx tsx scripts/build-candidates.ts          # Build candidate set (~23K chars)
npx tsx scripts/build-index.ts --candidates  # Render candidates (~40min, 89K PNGs)
npx tsx scripts/score-candidates.ts          # Score against Latin targets (~15min, 2.9M comparisons)

# Extract high-scoring discoveries from both pipelines
npx tsx scripts/extract-discoveries.ts
```

## Output

### Committed (CC-BY-4.0)

| File | Description |
|------|-------------|
| `data/output/confusable-discoveries.json` | 110 TR39 pairs: high SSIM (>= 0.7) or pixel-identical |
| `data/output/candidate-discoveries.json` | 793 novel pairs not in TR39, mean SSIM >= 0.7 |
| `data/output/confusable-weights.json` | 903 weighted edges for namespace-guard integration (M3) |

### Generated (gitignored, run pipeline to regenerate)

| File | Description |
|------|-------------|
| `data/output/render-index/` | 11,370 M1b render PNGs + index.json |
| `data/output/candidate-index/` | 89,478 M2 render PNGs + index.json |
| `data/output/confusable-scores.json` | Full M1b scored results (63 MB) |
| `data/output/candidate-scores.json` | Full M2 scored results (573 MB) |
| `data/output/report-stats.txt` | Detailed statistics for REPORT.md |

## Planned milestones

- [x] **Milestone 1** -- Validate approach against 31 NFKC/TR39 divergence vectors
- [x] **Milestone 1b** -- Expand to full confusables.txt (1,418 pairs), 230 fonts, technical report
- [x] **Milestone 2** -- Discover novel confusable pairs not in TR39 (793 high-scoring pairs from 23,317 candidates)
- [x] **Milestone 3** -- Glyph reuse detection, identifier property annotations, weighted edge computation, namespace-guard integration
- [ ] **Milestone 2b** -- CJK/Hangul verification and cross-script validation (Cyrillic, Greek, Armenian, Georgian). M2 excluded logographic scripts on the assumption they're structurally different from Latin; M2b tests that assumption.
- [ ] **Milestone 4** -- Multi-character confusables. Current scoring is single-character; M4 would detect sequences that visually compose into a different character (e.g. `rn` vs `m`, `cl` vs `d`).

## Related

- [namespace-guard](https://github.com/paultendo/namespace-guard) (v0.16.0+) -- consumes `confusable-weights.json` for measured visual risk scoring via `confusableDistance({ weights })`
- [REPORT.md](REPORT.md) -- full Milestone 1b technical report (12 sections, per-font analysis, appendices)
- [Blog post](https://paultendo.github.io/posts/confusable-vision-visual-similarity/) -- write-up with rendered glyph comparison images

## Licence

- **Code** (src/, scripts/): MIT
- **Generated data** (data/output/): [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) -- free to use, share, and adapt for any purpose including commercial, with attribution
- **Attribution**: Paul Wood FRSA (@paultendo), confusable-vision
