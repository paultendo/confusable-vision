NO EM DASHES PLEASE!

# confusable-vision

Offline tool that renders Unicode confusable character pairs across multiple fonts, measures visual similarity (SSIM + pHash), and outputs scored JSON artifacts. The goal is empirical, font-aware confusable confidence scoring.

## Relation to namespace-guard

This repo exists because of [paultendo/namespace-guard#1](https://github.com/paultendo/namespace-guard/issues/1). namespace-guard (v0.15.1) already ships two confusable maps for anti-spoofing, but the confidence weights are hand-tuned. confusable-vision generates those weights empirically by rendering characters and measuring visual similarity.

The 31 composability vectors in `data/input/composability-vectors.json` are cases where TR39 confusable mappings and NFKC normalisation disagree on a target. For example, U+017F (ſ) maps to "f" under TR39 but "s" under NFKC. This tool renders both candidates beside the source and measures which is actually closer visually.

Milestone 3 will produce `confusable-weights.json` for direct integration into namespace-guard.

## GlyphNet prior art (reference only, no code)

Gupta et al. 2023 ([arxiv.org/abs/2306.10392](https://arxiv.org/abs/2306.10392)) explored deep learning for domain-level homoglyph detection. Their empirical findings informed several design choices here:

- **Greyscale outperforms colour** for glyph comparison (extreme contrast preserves edge detail through resize)
- **48x48 normalised images** are sufficient for SSIM/pHash (they used 256x256 for CNN feature extraction)
- **No image augmentation** (flipping/rotating characters creates unrealistic glyphs)
- **ImageNet transfer learning fails** for glyphs (VGG16/ResNet scored 63-67%), which validates our simpler SSIM/pHash approach
- **Different scope**: they do domain-level binary classification; we do character-level pairwise scoring
- **References dnstwist** for homoglyph generation (useful for milestone 2 cross-referencing)

No GlyphNet code is incorporated. Their repo has a licence contradiction (README says MIT, LICENSE file is GPL-3.0). We filed [Akshat4112/Glyphnet#6](https://github.com/Akshat4112/Glyphnet/issues/6) about it.

## Commands

```bash
npm run render-pairs          # Run milestone 1 analysis (JSON output only)
npm run render-pairs:save     # Also save visual audit triptych PNGs
npx tsx scripts/render-pairs.ts --save-renders   # Equivalent to above
```

## Project structure

```
confusable-vision/
  src/
    types.ts                 # Shared interfaces (9 exports)
    fonts.ts                 # Font list, availability check, registerFont()
    renderer.ts              # 64x64 canvas rendering + .notdef detection
    normalise-image.ts       # Crop/centre/resize/greyscale via sharp (to 48x48)
    compare.ts               # SSIM (ssim.js) + pHash (custom, ~30 lines)
  scripts/
    render-pairs.ts          # Milestone 1 main orchestrator (working)
    score-all-pairs.ts       # Stub: milestone 1b
    discover-novel.ts        # Stub: milestone 2
    validate-scripts.ts      # Stub: milestone 2b
    generate-weights.ts      # Stub: milestone 3
  data/
    input/
      composability-vectors.json   # 31 vectors copied from namespace-guard
    output/                        # Generated, gitignored
      divergence-vectors-similarity.json
      renders/                     # Triptych PNGs (with --save-renders)
  fonts/                           # For future free font downloads (Noto, DejaVu)
  package.json / tsconfig.json / LICENSE / README.md / .gitignore
```

## Architecture and data flow

```
composability-vectors.json
        |
        v
  render-pairs.ts (orchestrator)
        |
        +--> fonts.ts         initFonts() registers 12 system fonts with node-canvas
        |
        +--> renderer.ts      renderCharacter() produces 64x64 PNG + raw pixels per char/font
        |                     returns null if font lacks glyph (.notdef detection)
        |                     detectFallback() compares raw pixels against known fallback fonts
        |
        +--> normalise-image.ts   normaliseImage() converts to greyscale, trims,
        |                         resizes to 48x48 with white background
        |
        +--> compare.ts       compareImages() returns { ssim, pHash } scores
        |
        v
  divergence-vectors-similarity.json   (+ optional triptych PNGs)
```

## Key algorithms

### Three render states (renderer.ts)
Each character/font combination is classified into one of three states:

1. **native** -- the requested font contains the glyph and rendered it directly
2. **fallback** -- the OS silently substituted a different font (e.g. macOS substitutes Apple Symbols when Arial lacks a math symbol). Detected by comparing raw pixels against pre-rendered reference images from known fallback fonts (math/symbol category). The output records which fallback font produced the pixels.
3. **notdef** -- nothing rendered. Detected by comparing against (a) a blank white canvas and (b) the Unicode replacement character U+FFFD in the same font. If pixel-identical to either, the font lacks the glyph entirely.

All three states stay in the output. Fallback data is valid -- it represents what platform users actually see. The metadata tells you which font produced the pixels so you can distinguish "Arial natively renders this" from "macOS substituted Apple Symbols when the app specified Arial."

### Normalisation pipeline (normalise-image.ts)
1. Convert to greyscale (GlyphNet finding: greyscale preserves edges better)
2. Trim whitespace (sharp trim, threshold 10)
3. Resize to 48x48 with `fit: contain` and white background padding
4. Extract raw greyscale pixel buffer for comparison

If trimming fails (blank/near-blank image), returns an all-white 48x48 image gracefully.

### SSIM (compare.ts)
Uses the `ssim.js` library. Since ssim.js requires RGBA input, greyscale pixels are expanded (R=G=B=grey, A=255). Returns the `mssim` value, which ranges roughly from -1 to 1 (1 = identical). Negative values indicate strong structural dissimilarity.

### pHash (compare.ts)
Custom implementation (~30 lines, no external dependency beyond sharp for resize):
1. Resize greyscale image to 8x8 using sharp
2. Compute mean pixel value across all 64 pixels
3. Build 64-bit hash as a BigInt: bit i is 1 if pixel[i] > mean
4. Similarity = `1 - hammingDistance(hashA, hashB) / 64` (0 to 1 scale)

### Verdict logic (render-pairs.ts)
For each vector, SSIM scores are averaged across all fonts where the source glyph rendered successfully. The verdict is:
- `"tr39"` if tr39MeanSsim > nfkcMeanSsim + 0.05
- `"nfkc"` if nfkcMeanSsim > tr39MeanSsim + 0.05
- `"equal"` if |delta| < 0.05
- `"insufficient_data"` if no fonts could render the source character

## Font configuration

12 fonts, hardcoded to macOS system paths:

**Standard (10):** Arial, Verdana, Trebuchet MS, Tahoma, Geneva, Georgia, Times New Roman, Courier New, Monaco, Impact -- all in `/System/Library/Fonts/` or `/System/Library/Fonts/Supplemental/`

**Math/Symbol (2):** STIX Two Math (`.otf`), Apple Symbols (`.ttf`) -- needed for the 26 SMP Mathematical Alphanumeric Symbols vectors (U+1D4xx, U+1D7xx range)

Note: macOS font fallback means SMP characters often render via system math fonts even when a standard font like Arial is requested. The tool measures what users would actually see, which is correct behaviour.

To add fonts for Linux/CI: place `.ttf`/`.otf` files in `fonts/` and add entries to the `FONT_DEFINITIONS` array in `src/fonts.ts`. The `initFonts()` function handles checking availability and skipping missing fonts gracefully.

## Output JSON schema

```typescript
interface OutputData {
  meta: {
    generatedAt: string;       // ISO timestamp
    fontsAvailable: number;    // e.g. 12
    fontsTotal: number;        // e.g. 12
    vectorCount: number;       // e.g. 31
  };
  vectors: Array<{
    codePoint: string;         // "U+017F"
    char: string;              // the actual character
    tr39Target: string;        // TR39 confusable target
    nfkcTarget: string;        // NFKC normalisation target
    fonts: Array<{
      font: string;            // "Arial"
      tr39: { ssim: number; pHash: number } | null;
      nfkc: { ssim: number; pHash: number } | null;
      sourceNotdef: boolean;
    }>;
    summary: {
      tr39MeanSsim: number | null;
      nfkcMeanSsim: number | null;
      tr39MeanPHash: number | null;
      nfkcMeanPHash: number | null;
      validFontCount: number;
      verdict: 'tr39' | 'nfkc' | 'equal' | 'insufficient_data';
    };
  }>;
  globalSummary: {
    tr39Wins: number;
    nfkcWins: number;
    ties: number;
    insufficientData: number;
    totalVectors: number;
  };
}
```

## Milestone 1 results (current)

31 vectors, 12 fonts, 372 comparisons (platform: macOS arm64):
- TR39 wins: 7 (TR39 mapping is visually closer)
- NFKC wins: 5 (NFKC mapping is visually closer)
- Ties: 19 (delta < 0.05, both mappings equally plausible)
- Insufficient data: 0

Render status breakdown:
- U+017F (ſ, long s): 12 native, 0 fallback -- BMP, all fonts have it. Clean data.
- BMP characters (U+2160, U+FF29): 3-7 native, varies by font coverage
- SMP Mathematical Alphanumeric (U+1D4xx, U+1D7xx): 2 native (STIX Two Math + Apple Symbols), 10 fallback via Apple Symbols
- The 10 "fallback" renders for SMP characters are what macOS users actually see. Valid platform-specific data, not noise.

Strongest signals: U+017F (ſ) strongly favours TR39 "f" (SSIM 0.66 vs 0.05). Mathematical digit zeros (U+1D7E2, U+1D7EC) strongly favour NFKC "0" over TR39 "o".

## Planned milestones

1. **Milestone 1** (done) -- 31 divergence vectors, validate approach
2. **Milestone 1b** (`score-all-pairs.ts`) -- full confusables.txt (~4,500 entries), weighted confusable map
3. **Milestone 2** (`discover-novel.ts`) -- render identifier-safe Unicode vs Latin, find unlisted confusable pairs; cross-reference dnstwist; consider multi-character confusables
4. **Milestone 2b** (`validate-scripts.ts`) -- cross-script validation (Cyrillic, Greek, Armenian, Georgian vs Latin)
5. **Milestone 3** (`generate-weights.ts`) -- distil everything into `confusable-weights.json` for namespace-guard

## Tech stack

- **TypeScript** with strict mode, ES2022 target, ESNext modules
- **canvas** (node-canvas v3) -- server-side 2D rendering with `registerFont()` for system fonts
- **sharp** (v0.34) -- image processing: greyscale, trim, resize, raw pixel extraction
- **ssim.js** (v3.5) -- structural similarity index measurement
- **tsx** (v4.21) -- TypeScript script execution (dev dependency)

Note: canvas and sharp both bundle native binaries. On macOS arm64 they install prebuilt binaries automatically. On Linux you may need `build-essential`, `libcairo2-dev`, `libpango1.0-dev`, `libjpeg-dev`, `libgif-dev`, `librsvg2-dev` for canvas.

## Hard rules

- Offline data generation tool only -- nothing runs at request time
- Deterministic output given the same fonts and Unicode data
- TypeScript/Node.js only (no Python)
- Greyscale rendering, no image augmentation (validated by GlyphNet)
- pHash implemented directly with sharp (~30 lines), no external perceptual hashing library
- Log everything to stdout for auditability
- No GPL code incorporation (GlyphNet is reference-only)
- Free fonts can be committed to `fonts/`; system fonts loaded by path, never committed
- `--save-renders` flag for visual audit PNGs (not generated by default)
- `data/output/` is gitignored -- regenerate with `npm run render-pairs`

## Conventions

- ES module imports with `.js` extensions (required by ESNext module resolution)
- Async functions for anything touching sharp (returns Promises)
- Synchronous canvas rendering (node-canvas API is sync)
- `null` return from `renderCharacter()` means .notdef (font lacks glyph)
- `null` in comparison results means one side could not be rendered
- Console logging with bracketed prefixes: `[font]`, `[FontName]`, phase numbers `[1/4]`
- Filenames use underscores and braces for triptych PNGs: `U017F_{Arial}.png`
- BigInt used for 64-bit pHash values; JSON serialiser has a custom replacer to handle this

## Known limitations

- Font paths are macOS-specific (adaptation needed for Linux/Windows/CI)
- SSIM can return negative values for very dissimilar glyphs (this is mathematically valid, not a bug)
- The 0.05 verdict threshold is a starting heuristic; may need tuning as more data comes in from milestone 1b
- No tests yet -- output is verified by visual inspection of triptych PNGs and JSON spot-checks

## Author

Paul Wood FRSA (@paultendo)
Building [namespace-guard](https://github.com/paultendo/namespace-guard) and related Unicode safety tooling.
