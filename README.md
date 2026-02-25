# confusable-vision

Offline tool that renders Unicode confusable character pairs across multiple fonts, measures visual similarity using SSIM and pHash, and outputs scored JSON artifacts.

## Why

Unicode TR39 defines confusable character mappings for anti-spoofing, but NFKC normalisation sometimes maps the same character to a *different* target. There are 31 known cases where they disagree. Which mapping is visually correct? This tool answers that empirically by rendering both candidates and measuring similarity.

The output feeds into [namespace-guard](https://github.com/paultendo/namespace-guard)'s risk scoring (see [#1](https://github.com/paultendo/namespace-guard/issues/1)).

## GlyphNet prior art

Gupta et al. 2023 ([arxiv.org/abs/2306.10392](https://arxiv.org/abs/2306.10392)) explored deep learning for domain-level homoglyph detection. Several of their empirical findings informed our approach:

- **Greyscale outperforms colour** for glyph comparison (extreme contrast preserves edges)
- **No image augmentation** for glyph tasks (flipping/rotating creates unrealistic shapes)
- **ImageNet transfer learning fails** for glyphs (VGG16/ResNet scored 63-67%), validating simpler SSIM/pHash metrics
- **Different scope**: they do domain-level binary classification; we do character-level pairwise scoring

No GlyphNet code is incorporated (GPL licence ambiguity in their repository).

## Quick start

```bash
npm install
npx tsx scripts/render-pairs.ts                # JSON output only
npx tsx scripts/render-pairs.ts --save-renders  # Also save visual audit PNGs
```

## Font requirements

The tool uses system fonts found at runtime. On macOS, it checks for:

- **Standard fonts**: Arial, Verdana, Trebuchet MS, Tahoma, Geneva, Georgia, Times New Roman, Courier New, Monaco, Impact
- **Math/symbol fonts**: STIX Two Math, Apple Symbols (needed for SMP Mathematical Alphanumeric Symbols at U+1D4xx/U+1D7xx)

26 of the 31 vectors are SMP characters that only render in math/symbol fonts. Standard web fonts will show .notdef (missing glyph) for those.

Free fonts (e.g. Noto Sans, DejaVu) can be added to the `fonts/` directory in future.

## Output format

`data/output/divergence-vectors-similarity.json`:

```json
{
  "meta": {
    "generatedAt": "2026-02-25T...",
    "fontsAvailable": 12,
    "vectorCount": 31
  },
  "vectors": [
    {
      "codePoint": "U+017F",
      "char": "\u017f",
      "tr39Target": "f",
      "nfkcTarget": "s",
      "fonts": [
        {
          "font": "Arial",
          "tr39": { "ssim": 0.42, "pHash": 0.61 },
          "nfkc": { "ssim": 0.38, "pHash": 0.55 }
        }
      ],
      "summary": {
        "tr39MeanSsim": 0.45,
        "nfkcMeanSsim": 0.40,
        "tr39MeanPHash": 0.63,
        "nfkcMeanPHash": 0.58,
        "verdict": "tr39"
      }
    }
  ],
  "globalSummary": {
    "tr39Wins": 20,
    "nfkcWins": 5,
    "ties": 6
  }
}
```

With `--save-renders`, triptych PNGs are saved to `data/output/renders/` for visual audit.

## Planned milestones

1. **Milestone 1** (current) -- Validate approach against 31 NFKC/TR39 divergence vectors
2. **Milestone 1b** -- Expand to full confusables.txt (~4,500 entries), produce weighted confusable map
3. **Milestone 2** -- Discover novel confusable pairs not in TR39 by rendering identifier-safe Unicode vs Latin targets
4. **Milestone 2b** -- Cross-script validation for Cyrillic, Greek, Armenian, Georgian
5. **Milestone 3** -- Distil all output into confusable-weights.json for namespace-guard integration

## Licence

MIT
