# confusable-vision

Empirical glyph similarity scoring using vector-outline raycasting. Renders Unicode confusable character pairs across 245 system fonts, measures structural similarity from font outlines directly (no rasterization), and produces scored JSON artifacts with per-font continuous distance scores.

Key results from 52.6 million single-char and 190 million multi-char comparisons across 22,581 characters and 12 writing systems:

- **249,976 unique single-char confusable pairs** across 245 fonts, 12 scripts, 66 cross-script pairs. 764,395 total font-level discoveries.
- **2,524,275 unique multi-char (bigram) confusable pairs** including rn/m across 95 fonts (33 below distance 0.40) and oy/Cyrillic uk across 16 fonts.
- **Per-font continuous distance scores**, not binary lists. Each pair has a measured ray distance per font, giving font-aware confidence for downstream security tooling.
- **305% more discoveries than SDF**, 29% faster. The enriched five-layer ray signature is a strict superset of SDF findings; SDF-exclusive pairs did not replicate under manual review.

The output feeds directly into [namespace-guard](https://github.com/paultendo/namespace-guard) for runtime confusable detection in package names, domain names, and identifiers.

## How it works

RaySpace casts parallel rays through font outlines at 36 angles and captures five layers of information per glyph: crossing counts, crossing positions, crossing angles, ping distances (stroke width at each crossing), and ping max (counter width between crossings). This produces a compact signature per character per font. Two signatures are compared with a weighted L1 distance across all five layers.

A three-stage filter cascade makes exhaustive comparison tractable:

1. **Advance width filter** (15% tolerance) eliminates pairs with different character widths. Removes 63% of candidates.
2. **Ray comparison** (threshold 2.0, tightened to 1.0 for large script pairs). Removes another 33%.
3. Only 3.3% of candidates survive to become discoveries.

The signature bank (294,646 entries across 245 fonts) is precomputed once. Discovery then runs as single-threaded arithmetic on the bank, completing 52.6 million pair comparisons in 31 minutes with no worker threads or GPU.

## Quick start

```bash
npm install

# 1. Build the ray signature bank (prerequisite, ~24 min)
npx tsx scripts/build-signature-bank.ts

# 2. Single-char discovery (22,581 chars, 12 scripts, ~36 min)
npx tsx scripts/discover-singlechar-sdf.ts --scorer=ray

# 3. Multi-char (bigram) discovery (676 bigrams, ~63 min)
npx tsx scripts/discover-multichar-sdf.ts --scorer=ray

# 4. Score known TR39 multi-char confusables (~5 min)
npx tsx scripts/score-multichar-sdf.ts --scorer=ray
```

<details>
<summary>Legacy SSIM pipeline</summary>

The original SSIM-based pipeline scored 26.5 million comparisons across 230 fonts. It remains functional but is superseded by RaySpace for all discovery and scoring tasks.

```bash
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

</details>

## What it found

### Top confusable pairs (single-char, mean distance < 0.10)

| Source | Target | Scripts | Mean | Fonts | Zeros |
|---|---|---|---|---|---|
| w U+0077 | ԝ U+051D | Latin-Cyrillic | 0.000 | 19 | 19 |
| j U+006A | ϳ U+03F3 | Latin-Greek | 0.013 | 21 | 18 |
| i U+0069 | і U+0456 | Latin-Cyrillic | 0.018 | 62 | 50 |
| s U+0073 | ѕ U+0455 | Latin-Cyrillic | 0.018 | 62 | 46 |
| c U+0063 | с U+0441 | Latin-Cyrillic | 0.019 | 61 | 45 |
| o U+006F | о U+043E | Latin-Cyrillic | 0.020 | 61 | 44 |
| j U+006A | ј U+0458 | Latin-Cyrillic | 0.021 | 60 | 48 |
| x U+0078 | х U+0445 | Latin-Cyrillic | 0.023 | 59 | 50 |
| p U+0070 | р U+0440 | Latin-Cyrillic | 0.024 | 61 | 46 |
| e U+0065 | е U+0435 | Latin-Cyrillic | 0.032 | 61 | 44 |
| a U+0061 | а U+0430 | Latin-Cyrillic | 0.042 | 61 | 45 |

"Zeros" = fonts where the outlines produce bit-identical ray signatures (distance 0.000). Latin w/Cyrillic ԝ is identical in all 19 fonts that contain both glyphs.

### Cross-script breakthroughs (single-char)

| Source | Target | Scripts | Mean | Fonts |
|---|---|---|---|---|
| ο U+03BF | ჿ U+10FF | Greek-Georgian | 0.057 | 2 |
| ヘ U+30D8 | へ U+3078 | Katakana-Hiragana | 0.122 | 11 |
| 丶 U+4E36 | ヽ U+30FD | Han-Katakana | 0.125 | 9 |
| 二 U+4E8C | ニ U+30CB | Han-Katakana | 0.249 | 11 |
| 口 U+53E3 | ロ U+30ED | Han-Katakana | 0.268 | 11 |

Georgian Coda (U+10FF) forms a four-way confusable ring with Latin o, Cyrillic o, and Greek omicron, all below distance 0.08.

### Multi-char headline results

| Bigram | Target | Mean | Fonts | Notes |
|---|---|---|---|---|
| ll | ॥ U+0965 (Devanagari double danda) | 0.176 | 8 | Cross-script |
| oy | ѹ U+0479 (Cyrillic uk) | 0.322 | 16 | Novel cross-script bigram confusable |
| rn | m U+006D | 0.531 | 95 | 33 fonts below 0.40 |
| bl | ы U+044B (Cyrillic yeru) | 0.797 | 49 | Cross-script |

The **oy/Cyrillic uk** discovery is the standout novel finding: the Latin bigram "oy" is visually identical to the Cyrillic digraph letter uk (ѹ) at distance 0.000 in Helvetica and 0.0005 in Arial Unicode MS.

### Threshold calibration

| Mean threshold | Single-char unique pairs | Multi-char unique pairs |
|---|---|---|
| < 0.50 | 138 | 13 |
| < 1.00 | 4,174 | 1,631 |
| < 1.50 | 59,700 | (noise) |
| < 2.00 | 249,976 | 2,524,275 |

Three recommended operating tiers:

- **Strict (< 0.50)**: 138 single-char pairs, near-zero false positives. Suitable for automated blocking (IDN registration, package name validation) where false positives have real cost.
- **Standard (< 1.00)**: 4,174 single-char pairs, good balance of coverage and precision. Suitable for flagging and manual review in security tooling.
- **Exploratory (< 2.00)**: Full discovery set. Contains noise at the upper end but useful for research, font auditing, and building training sets.

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

## Output

### Committed (CC-BY-4.0)

| File | Description |
|------|-------------|
| `data/output/confusable-discoveries.json` | 110 TR39 pairs with high SSIM (>= 0.7) or pixel-identical |
| `data/output/candidate-discoveries.json` | 793 novel pairs not in TR39, mean SSIM >= 0.7 |
| `data/output/confusable-weights.json` | 1,397 weighted edges for namespace-guard integration |
| `data/output/cross-script-discoveries.json` | 563 cross-script confusable pairs |
| `data/output/cross-script-summary.json` | Cross-script summary by script pair |
| `data/output/multichar-discoveries.json` | Multi-char confusable discoveries |

### Generated (gitignored, run pipeline to regenerate)

| File | Description |
|------|-------------|
| `data/output/render-index/` | Render PNGs + index (SSIM pipeline) |
| `data/output/singlechar-sdf-scores.jsonl` | Single-char RaySpace scores |
| `data/output/multichar-rayspace-scores.jsonl` | Multi-char RaySpace scores |
| `data/output/signature-bank/` | Ray signature bank (294,646 entries, 7.9GB compressed) |

## Progress

- [x] TR39 validation (1,418 pairs, 230 fonts, SSIM pipeline)
- [x] Novel confusable discovery (793 high-scoring pairs from 23,317 candidates, SSIM)
- [x] Cross-script confusable scanning (12 ICANN scripts, 23.6M pairs, 563 discoveries, SSIM)
- [x] Per-font querying and font comparison
- [x] RaySpace five-layer vector-outline scorer (replaces SDF and SSIM for discovery)
- [x] Single-char RaySpace discovery (249,976 unique pairs, 245 fonts, 12 scripts)
- [x] Multi-char RaySpace discovery (2,524,275 unique bigram pairs, 245 fonts)
- [x] Cross-script discovery with RaySpace (305% more pairs than SDF, strict superset)
- [x] Produce `confusable-weights-v2.json` with per-pair distributional records: mean, p50, p90, font count, zero-distance count, zero fraction, and recommended tier (strict/standard/exploratory). RaySpace distances replace SSIM. 4,174 pairs at standard threshold.
- [ ] Binary signature bank format (reduce 273s load time to seconds)
- [ ] Score arbitrary fonts by path without re-running full pipeline

## Related

- [namespace-guard](https://github.com/paultendo/namespace-guard) (v0.16.0+) consumes `confusable-weights.json` for measured visual risk scoring via `confusableDistance({ weights })`
- [REPORT.md](REPORT.md): full technical report from the SSIM pipeline (12 sections, per-font analysis, appendices)

### Blog posts

Write-ups on [paultendo.github.io](https://paultendo.github.io) covering the findings and methodology behind this project:

**RaySpace methodology and findings:**
- [RaySpace: measuring glyph similarity with vector-outline raycasting](https://paultendo.github.io/posts/rayspace-methodology/)
- [From CT scanners to confusable characters: the prior art behind RaySpace](https://paultendo.github.io/posts/rayspace-prior-art/)
- [Multi-character confusables: when rn becomes m](https://paultendo.github.io/posts/multichar-confusables/)
- [250,000 confusable pairs. 102 that matter for domain names.](https://paultendo.github.io/posts/idn-relevance/)

**SSIM pipeline findings:**
- [I rendered 1,418 Unicode confusable pairs across 230 fonts. Most aren't confusable to the eye.](https://paultendo.github.io/posts/confusable-vision-visual-similarity/)
- [793 Unicode characters look like Latin letters but aren't (yet) in confusables.txt](https://paultendo.github.io/posts/confusable-vision-novel-discoveries/)
- [28 CJK and Hangul characters look like Latin letters](https://paultendo.github.io/posts/confusable-vision-cjk-hangul-scan/)
- [248 cross-script confusable pairs that no standard covers](https://paultendo.github.io/posts/confusable-vision-cross-script/)
- [148x faster: rebuilding a Unicode scanning pipeline for cross-script scale](https://paultendo.github.io/posts/confusable-vision-pipeline-148x/)
- [When shape similarity lies: size-ratio artifacts in confusable detection](https://paultendo.github.io/posts/confusable-vision-size-ratio/)
- [The new DDoS: Unicode confusables can't fool LLMs, but they can 5x your API bill](https://paultendo.github.io/posts/confusable-vision-llm-attack-tests/)

### Background

Posts covering the broader problem space that motivated this project:

- [A threat model for Unicode identifier spoofing](https://paultendo.github.io/posts/unicode-identifier-threat-model/)
- [Making Unicode risk measurable](https://paultendo.github.io/posts/making-unicode-risk-measurable/)
- [Your LLM reads Unicode codepoints, not glyphs. That's an attack surface.](https://paultendo.github.io/posts/confusable-llm-attack-vectors/)
- [Who does confusable detection actually protect?](https://paultendo.github.io/posts/anglocentric-confusable-detection/)
- [Unicode ships one confusable map. You need two.](https://paultendo.github.io/posts/confusable-detection-without-nfkc/)
- [confusables.txt and NFKC disagree on 31 characters](https://paultendo.github.io/posts/unicode-confusables-nfkc-conflict/)

## Licence

- **Code** (src/, scripts/): MIT
- **Generated data** (data/output/): [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). Free to use, share, and adapt for any purpose including commercial, with attribution.
- **Attribution**: Paul Wood FRSA (@paultendo), confusable-vision
