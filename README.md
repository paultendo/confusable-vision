# confusable-vision

Empirical visual similarity scoring for Unicode confusable characters. Renders character pairs across 230 system fonts, measures structural similarity (SSIM), and produces scored JSON artifacts that tell you exactly how confusable two characters are, in which fonts, and with what confidence.

Built to replace hand-tuned weights with measured data. The output (`confusable-weights.json`) feeds directly into [namespace-guard](https://github.com/paultendo/namespace-guard) for runtime confusable detection in package names, domain names, and identifiers.

## Why this matters

Unicode has over 149,000 characters. Many look identical to Latin letters: Cyrillic `а` (U+0430) is visually indistinguishable from Latin `a` in most fonts. Attackers exploit this for [IDN homograph attacks](https://en.wikipedia.org/wiki/IDN_homograph_attack), package name typosquatting, and credential phishing.

Unicode TR39 publishes a [confusables.txt](https://unicode.org/Public/security/latest/confusables.txt) mapping, but it's a binary list: a pair is either confusable or it isn't. It doesn't account for fonts, doesn't score confidence, and misses hundreds of pairs. confusable-vision fills that gap with per-font, per-pair SSIM scores derived from actual rendered pixels.

## What it found

**26.5 million SSIM comparisons** across 230 macOS system fonts, 12 ICANN-relevant scripts, and 22,000+ Unicode characters:

| | Pairs | Comparisons | Source |
|---|---|---|---|
| TR39 validation | 1,418 | 235,625 | confusables.txt (single-codepoint, Latin targets) |
| Novel discovery | 793 | 2,904,376 | 23,317 identifier-safe codepoints vs Latin a-z/0-9 |
| Cross-script | 563 | 23,629,492 | 12 scripts x 66 script pairs (Latin, Cyrillic, Greek, Arabic, Han, Hangul, Katakana, Hiragana, Devanagari, Thai, Georgian, Armenian) |

**1,397 weighted confusable edges** in the final output, each with same-font/cross-font statistics, danger scores, and cost values.

### TR39 is mostly noise, but the high end is severe

96.5% of confusables.txt scores below 0.7 mean SSIM. The median pair scores 0.322. But 82 pairs are pixel-identical (SSIM 1.000) in at least one font, and 47 pairs score negative SSIM (less similar than random noise). The list conflates genuinely dangerous pairs with pairs no human would confuse.

### 793 confusable pairs are missing from TR39

Novel high-risk discoveries not in the official Unicode list. Top find: U+A7FE LATIN EPIGRAPHIC LETTER I LONGA scores 0.998 against "l" in Geneva. Most are vertical stroke characters from obscure scripts (Pahawh Hmong, Nabataean, Duployan) that render as "l" or "i" lookalikes. 74.5% of these are valid in both JavaScript identifiers and domain names.

### Font choice changes confusable risk dramatically

Same-font comparisons average 0.536 SSIM; cross-font average 0.339. Font danger rates range from 0% (Zapfino) to 67.5% (Phosphate). Switching from Arial to Georgia drops confusable pair coverage from 438 to 103. The font a product ships matters for its attack surface.

### Cross-script confusables span 37 of 66 script pairs

Highest-yield: Cyrillic-Greek (126 pairs), Latin-Cyrillic (103), Latin-Greek (86). Top discovery: Hangul jamo U+1175 vs CJK U+4E28 at SSIM 0.999. Also confirmed empirically: Katakana `ロ` vs CJK `口`, Devanagari `०` vs Thai `๐`, Georgian `Ⴝ` vs Latin `S`. 29 of 66 script pairs produced zero matches, confirming that most distant scripts are visually distinct.

## Quick start

```bash
npm install

# TR39 confusable pair scoring
npx tsx scripts/build-index.ts          # Render index (~160s, 11,370 PNGs)
npx tsx scripts/score-all-pairs.ts      # Score all pairs (~65s, 235K comparisons)

# Novel confusable discovery
npx tsx scripts/build-candidates.ts          # Candidate set (~23K chars)
npx tsx scripts/build-index.ts --candidates  # Render candidates (~40min, 89K PNGs)
npx tsx scripts/score-candidates.ts          # Score against Latin targets (~15min, 2.9M comparisons)

# Extract high-scoring discoveries from both pipelines
npx tsx scripts/extract-discoveries.ts
```

## Font querying

Query which confusable pairs exist for a specific font. Useful for font designers shipping a new typeface, browser vendors evaluating a system font change, or anyone choosing a display font for security-sensitive contexts like IDN domains.

```bash
npx tsx scripts/query-font.ts --list-fonts                    # 218 fonts in discovery data
npx tsx scripts/query-font.ts "Arial"                         # All pairs for Arial (SSIM >= 0.7)
npx tsx scripts/query-font.ts "Arial" --threshold 0.8         # High-confidence only
npx tsx scripts/query-font.ts "Arial" --compare "Georgia"     # Diff two fonts by SSIM delta
npx tsx scripts/query-font.ts "Arial" --json                  # JSON for downstream processing
```

Font name matching is case-insensitive substring, so `"arial"` matches Arial, Arial Black, and Arial Unicode MS. Compare mode sorts by the biggest SSIM differences first, surfacing exactly which pairs get better or worse when switching fonts.

Requires the discovery files from the scoring pipeline (gitignored, regenerate locally).

## How it works

### Rendering pipeline

1. **build-index** renders source and target characters as 48x48 greyscale PNGs, one per font that natively contains the character. Fontconfig is queried per-character to skip fonts lacking coverage (97% reduction vs brute-force).

2. **score-all-pairs** / **score-candidates** computes SSIM for every valid source/target combination in two modes: same-font (both characters in one font) and cross-font (source in supplemental font, target in standard font).

3. **extract-discoveries** filters to high-scoring pairs (mean SSIM >= 0.7) and writes compact, licenced JSON files.

4. **generate-weights** combines all discoveries into `confusable-weights.json` with per-pair same-font/cross-font statistics, danger (max SSIM), stableDanger (p95 SSIM), and cost (1 - stableDanger).

### Design choices

- **Greyscale rendering.** [Gupta et al. 2023 ("GlyphNet")](https://arxiv.org/abs/2306.10392) found greyscale outperforms colour for glyph comparison.
- **No image augmentation.** Flipping/rotating characters creates unrealistic glyphs.
- **SSIM over learned embeddings.** Deterministic, reproducible, no training data or GPU required.
- **Fontconfig-targeted rendering.** Only render characters in fonts that actually contain them.

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

## Output

### Committed (CC-BY-4.0)

| File | Description |
|------|-------------|
| `data/output/confusable-discoveries.json` | 110 TR39 pairs with high SSIM (>= 0.7) or pixel-identical |
| `data/output/candidate-discoveries.json` | 793 novel pairs not in TR39, mean SSIM >= 0.7 |
| `data/output/confusable-weights.json` | 1,397 weighted edges for namespace-guard integration |

### Generated (gitignored, run pipeline to regenerate)

| File | Description |
|------|-------------|
| `data/output/render-index/` | 11,370 render PNGs + index.json |
| `data/output/candidate-index/` | 89,478 render PNGs + index.json |
| `data/output/confusable-scores.json` | Full scored results (63 MB) |
| `data/output/candidate-scores.json` | Full scored results (573 MB) |
| `data/output/report-stats.txt` | Detailed statistics for REPORT.md |

## Progress

- [x] TR39 validation (1,418 pairs, 230 fonts, technical report)
- [x] Novel confusable discovery (793 high-scoring pairs from 23,317 candidates)
- [x] CJK/Hangul verification (122,862 logographic characters, 69 high-scoring pairs found, confirms M2 exclusion was broadly correct)
- [x] Glyph reuse detection, identifier property annotations, weighted edge computation, namespace-guard integration
- [x] Cross-script confusable scanning (12 ICANN scripts, 23.6M pairs scored, 563 discoveries)
- [x] Per-font querying and font comparison
- [ ] Multi-character confusables (`rn` vs `m`, `cl` vs `d`). Shelved: SSIM cannot weight categorical features like dots (`ni` scores 0.86 against `m` because the dot is a handful of pixels, while humans treat it as an instant disambiguator). Revisit with a perceptual metric that weights distinctive features.

## Related

- [namespace-guard](https://github.com/paultendo/namespace-guard) (v0.16.0+) consumes `confusable-weights.json` for measured visual risk scoring via `confusableDistance({ weights })`
- [REPORT.md](REPORT.md): full technical report (12 sections, per-font analysis, appendices)

### Blog posts

Write-ups on [paultendo.github.io](https://paultendo.github.io) covering the findings and methodology behind this project:

- [I rendered 1,418 Unicode confusable pairs across 230 fonts. Most aren't confusable to the eye.](https://paultendo.github.io/posts/confusable-vision-visual-similarity/) — TR39 validation results and the case for measured confidence scores
- [793 Unicode characters look like Latin letters but aren't (yet) in confusables.txt](https://paultendo.github.io/posts/confusable-vision-novel-discoveries/) — novel discovery pipeline and the highest-scoring finds
- [28 CJK and Hangul characters look like Latin letters](https://paultendo.github.io/posts/confusable-vision-cjk-hangul-scan/) — verifying the CJK/Hangul exclusion from the main scan
- [248 cross-script confusable pairs that no standard covers](https://paultendo.github.io/posts/confusable-vision-cross-script/) — cross-script scanning across 12 ICANN scripts
- [148x faster: rebuilding a Unicode scanning pipeline for cross-script scale](https://paultendo.github.io/posts/confusable-vision-pipeline-148x/) — WASM SSIM workers, pure JS resize, and the optimisation path to 23.6M comparisons
- [When shape similarity lies: size-ratio artifacts in confusable detection](https://paultendo.github.io/posts/confusable-vision-size-ratio/) — why normalisation choices matter and how size-ratio filtering reduces false positives
- [The new DDoS: Unicode confusables can't fool LLMs, but they can 5x your API bill](https://paultendo.github.io/posts/confusable-vision-llm-attack-tests/) — testing confusable attacks against GPT-4o, Claude, Gemini, and Llama

### Background

Posts covering the broader problem space that motivated this project:

- [A threat model for Unicode identifier spoofing](https://paultendo.github.io/posts/unicode-identifier-threat-model/) — attack taxonomy for package names, domains, and source code identifiers
- [Making Unicode risk measurable](https://paultendo.github.io/posts/making-unicode-risk-measurable/) — why binary confusable lists aren't enough and what a scored approach looks like
- [Your LLM reads Unicode codepoints, not glyphs. That's an attack surface.](https://paultendo.github.io/posts/confusable-llm-attack-vectors/) — how confusables interact with tokenisation and code review by LLMs
- [Who does confusable detection actually protect?](https://paultendo.github.io/posts/anglocentric-confusable-detection/) — the anglocentric bias in TR39 and what it means for non-Latin users
- [Unicode ships one confusable map. You need two.](https://paultendo.github.io/posts/confusable-detection-without-nfkc/) — the NFKC/TR39 divergence that started this project
- [confusables.txt and NFKC disagree on 31 characters](https://paultendo.github.io/posts/unicode-confusables-nfkc-conflict/) — the 31 composability vectors that confusable-vision was originally built to resolve

## Licence

- **Code** (src/, scripts/): MIT
- **Generated data** (data/output/): [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Free to use, share, and adapt for any purpose including commercial, with attribution.
- **Attribution**: Paul Wood FRSA (@paultendo), confusable-vision
