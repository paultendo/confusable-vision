# score-multichar.ts optimisation log

## Context

`score-multichar.ts` (Milestone 4) scores 3,844 multi-character sequences against 62 single-char targets across ~74 fonts. The inner loop calls `normalisePair()` + `computeSsim()` for every pHash-passing pair -- roughly 3,400-4,400 SSIM computations per sequence, all originally serial.

**Before:** 1.75 seqs/min, ~36 hours total on a 14-core M-series Mac.
**After:** 6.6-7.2 seqs/min, ~8.5 hours total. **~4x speedup.**

## What was slow

Each `normalisePair(pngA, pngB)` call ran 7 sharp/libvips operations:

1. `decodeGrey(pngA)` -- sharp pipeline: PNG decode to raw greyscale
2. `decodeGrey(pngB)` -- same for target
3. `sharp(pngA).greyscale().extract(...)` -- crop source from PNG
4. `sharp(pngB).greyscale().extract(...)` -- crop target from PNG
5. Source `applyScale`: `sharp(cropped).resize().extend().png()` -- resize + pad + PNG encode
6. Source raw: `sharp(resized).greyscale().raw()` -- decode PNG back to raw pixels
7. Target `applyScale` + raw -- same two steps for target

With ~4,000 pairs per sequence and all of them serial (`await` in a for loop), the 14-core machine was stuck at 142% CPU (one core + some libvips threading).

## Optimisations applied

### 1. Pre-cache target decode + ink bounds

Targets never change across sequences. `decodeGrey()` + `findInkBounds()` for each target/font combo is computed once at startup and stored in a `Map<string, DecodedGreyWithBounds>` (4,583 entries, ~24s to build).

This eliminates operation #2 from the hot loop entirely.

### 2. Pre-cache source decode + ink bounds per sequence

Within a single sequence, each source (one per font, ~74 total) is compared against up to 62 targets. The original code called `decodeGrey(src.rawPng)` for every pair -- 62 redundant decodes per source font.

Now source decodes are cached in a per-sequence `Map<string, DecodedGreyWithBounds>` built once before the target loop. This eliminates operation #1 from the hot loop.

### 3. Pure JS pixel cropping

The original code used `sharp(png).greyscale().extract(...)` to crop -- a full sharp pipeline that re-decodes the PNG. Since we already have raw greyscale pixels from the decode cache, we can crop with a simple row-copy loop:

```ts
function cropGreyPixels(pixels, srcWidth, left, top, width, height) {
  const out = Buffer.allocUnsafe(width * height);
  for (let y = 0; y < height; y++) {
    pixels.copy(out, y * width, (top + y) * srcWidth + left, (top + y) * srcWidth + left + width);
  }
  return out;
}
```

This eliminates operations #3 and #4. Buffer.copy on 48px-wide rows is effectively free compared to a sharp pipeline.

### 4. Raw-in/raw-out sharp pipeline (skip PNG roundtrip)

The original `applyScale` encoded to PNG, then decoded back to raw pixels for SSIM. Since `computeSsim()` only reads `rawPixels` (never `pngBuffer`), we can feed raw greyscale pixels directly into sharp and output raw:

```ts
sharp(croppedPixels, { raw: { width: cropW, height: cropH, channels: 1 } })
  .resize(scaledW, scaledH, { fit: 'fill' })
  .extend({ ... })
  .raw()
  .toBuffer();
```

This collapses operations #5+#6 (and #7 for target) from two sharp pipelines each into one. `pngBuffer` is set to `Buffer.alloc(0)` since nothing reads it.

**Net result: 7 sharp operations per pair reduced to 2** (one resize+extend+raw per side).

### 5. Batched concurrency with Promise.all

All pHash-passing pairs for one sequence are collected into a work array, then processed in batches of 12 via `Promise.all`. This lets libvips run multiple resize pipelines concurrently.

```ts
for (let b = 0; b < work.length; b += CONCURRENCY) {
  const batch = work.slice(b, b + CONCURRENCY);
  const results = await Promise.all(batch.map(async (item) => {
    const [srcNorm, tgtNorm] = await normalisePairCached(item.cachedA, item.cachedB);
    return { ...item, ssimScore: computeSsim(srcNorm, tgtNorm) };
  }));
}
```

CONCURRENCY=12 was chosen to match available cores without overwhelming the thread pool.

### 6. Pre-built target font lookup maps

Replaced `targets.find(t => t.entry.font === src.entry.font)` (O(74) linear scan, called ~4,600 times per sequence) with a pre-built `Map<string, Map<string, DecodedRender>>` keyed by target character then font name. Minor but free.

### 7. UV_THREADPOOL_SIZE=16

Node's default libuv thread pool is 4 threads. With 12 concurrent sharp operations, they compete for 4 slots. Setting `UV_THREADPOOL_SIZE=16` as a **shell environment variable** (not `process.env` -- that's too late when tsx's loader has already initialized the pool) lets libvips actually use the available cores.

```bash
UV_THREADPOOL_SIZE=16 npx tsx scripts/score-multichar.ts
```

## What did NOT help

### Concurrency alone (v1 attempt)

The first version only cached targets and still called `normalisePairCached(pngA, cachedB, pngBRaw)` which decoded the source PNG fresh every time and used sharp for cropping. Despite 600% CPU utilisation, throughput was *worse* than the original (1.2 seqs/min vs 1.75) due to thread pool contention from too many heavy sharp pipelines competing.

The lesson: reducing the work per item matters more than parallelising expensive items. Going from 7 to 2 sharp ops per pair gave a bigger win than concurrency alone.

### process.env.UV_THREADPOOL_SIZE (set in JS)

Setting this at the top of the script (before imports) did not reliably work with tsx. The loader initialises the libuv thread pool before the user script runs. Must be set as a shell env var.

## What was NOT changed (by design)

- **pHash threshold (0.5):** Raising it loses high-SSIM pairs. Data quality over speed.
- **Worker threads for SSIM:** The greyscale-to-RGBA conversion + ssim.js math is fast for 48x48 images (~0.02ms). Message-passing overhead would dominate.
- **Cross-sequence parallelism:** Would break the simple per-sequence progress/resume model.
- **Greyscale SSIM bypass:** Would require importing ssim.js internals. Fragile for minimal gain.

## Files modified

- `scripts/score-multichar.ts` -- concurrency, font maps, source/target caching, UV_THREADPOOL_SIZE
- `src/normalise-image.ts` -- exported `InkBounds`, `DecodedGreyWithBounds`, `decodeAndFindBounds()`, `normalisePairCached()`, `cropGreyPixels()`, `normaliseFromCached()`

## Verification

The run is resumable (progress.jsonl). SSIM scores should be identical to the serial version since all changes are structural. Spot-check by comparing a few entries from before/after the optimisation boundary in progress.jsonl.
