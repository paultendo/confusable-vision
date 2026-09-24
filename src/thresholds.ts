/**
 * Suggested thresholds for release 2 lookalikes, from the tests in docs/metric-calibration.md. Used by the IDN view,
 * the namespace-guard weights and the Unicode submission.
 */
export const SAME_FONT = { minFonts: 3, minShare: 0.05 };
/** Across fonts the held-out test kept 17 of 23 TR39 lookalikes with no false match at 0.1. */
export const ACROSS_FONTS = { minCombinations: 3, minShare: 0.1 };

/**
 * Whether a release lookalike passes. Within one font the font count is capped at the number of text fonts that render
 * both characters, so a pair only one or two fonts can draw (Hangul jamo against Han, say) is judged on those fonts.
 */
export function passes(l: { method: string; textFontsAlike?: number; textFontsRenderingBoth?: number; textShare?: number;
  alike?: number; share?: number }): boolean {
  if (l.method === "same font") {
    const need = Math.min(SAME_FONT.minFonts, l.textFontsRenderingBoth ?? 0);
    return need > 0 && (l.textFontsAlike ?? 0) >= need && (l.textShare ?? 0) >= SAME_FONT.minShare;
  }
  return (l.alike ?? 0) >= ACROSS_FONTS.minCombinations && (l.share ?? 0) >= ACROSS_FONTS.minShare;
}
