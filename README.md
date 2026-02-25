# confusable-vision

Offline tool that renders Unicode [confusable](https://unicode.org/Public/security/latest/confusables.txt) character pairs across system fonts, measures visual similarity using [SSIM](https://en.wikipedia.org/wiki/Structural_similarity_index_measure), and outputs scored JSON artifacts.

## Key findings

confusable-vision scored 1,418 TR39 confusable pairs across 230 macOS system fonts (235,625 SSIM comparisons):

- **96.5% of confusables.txt is not high-risk.** Only 49 pairs (3.5%) score >= 0.7 mean SSIM. Median is 0.322.
- **82 pairs are pixel-identical** (SSIM 1.000) in at least one font. These are undetectable by visual inspection.
- **47 pairs have negative SSIM** -- less similar than random noise. These are false positives from a visual perspective.
- **Same-font comparisons average 0.536 SSIM; cross-font average 0.339.** The font pairing matters as much as the character pairing.
- **Font danger rates vary from 0% (Zapfino) to 67.5% (Phosphate).** Font choice is a meaningful variable in confusable risk.

Full analysis: [REPORT.md](REPORT.md) | Blog post: [paultendo.github.io/posts/confusable-vision-visual-similarity](https://paultendo.github.io/posts/confusable-vision-visual-similarity/)

## How it works

Two-stage pipeline:

1. **build-index** -- renders all 1,418 source characters and 34 target characters as 48x48 greyscale PNGs, one per font that natively contains the character. Fontconfig is queried per-character to skip fonts that lack coverage (97% reduction: 8,881 targeted renders vs 326,140 brute-force).

2. **score-all-pairs** -- loads the render index and computes SSIM for every valid source/target combination across two modes: same-font (both characters in one font) and cross-font (source in supplemental font, target in standard font).

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

# Build render index (~160s, 11,370 PNGs)
npx tsx scripts/build-index.ts

# Score all pairs (~65s, 235,625 comparisons)
npx tsx scripts/score-all-pairs.ts

# Generate report statistics
npx tsx scripts/report-stats.ts
```

## Output

| File | Description |
|------|-------------|
| `data/output/render-index/index.json` | Render metadata and pHash values |
| `data/output/render-index/renders/` | 11,370 normalised 48x48 greyscale PNGs |
| `data/output/confusable-scores.json` | Full scored results with per-font detail |
| `data/output/report-stats.txt` | Detailed statistics for REPORT.md |

All output files are gitignored. Run the pipeline to regenerate.

## Planned milestones

- [x] **Milestone 1** -- Validate approach against 31 NFKC/TR39 divergence vectors
- [x] **Milestone 1b** -- Expand to full confusables.txt (1,418 pairs), 230 fonts, technical report
- [ ] **Milestone 2** -- Discover novel confusable pairs not in TR39 by rendering identifier-safe Unicode vs Latin targets
- [ ] **Milestone 2b** -- Cross-script validation for Cyrillic, Greek, Armenian, Georgian
- [ ] **Milestone 3** -- Distil all output into confusable-weights.json for [namespace-guard](https://github.com/paultendo/namespace-guard) integration

## Related

- [namespace-guard](https://github.com/paultendo/namespace-guard) -- the npm library that will consume these scores for risk-weighted confusable detection
- [REPORT.md](REPORT.md) -- full Milestone 1b technical report (12 sections, per-font analysis, appendices)
- [Blog post](https://paultendo.github.io/posts/confusable-vision-visual-similarity/) -- write-up with rendered glyph comparison images

## Licence

- **Code** (src/, scripts/): MIT
- **Generated data** (data/output/): [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) -- free to use, share, and adapt for any purpose including commercial, with attribution
- **Attribution**: Paul Wood FRSA (@paultendo), confusable-vision
