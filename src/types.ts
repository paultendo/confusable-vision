/** A single divergence vector from composability-vectors.json */
export interface ComposabilityVector {
  char: string;
  codePoint: string;
  tr39: string;
  nfkc: string;
}

/** A font entry with its availability status */
export interface FontEntry {
  family: string;
  path: string;
  category: 'standard' | 'math' | 'symbol' | 'noto' | 'script';
  available: boolean;
}

/** Result from renderCharacter: PNG + raw pixels for fallback comparison */
export interface RenderResult {
  pngBuffer: Buffer;
  rawPixels: Buffer;
}

/** Result of normalising a rendered glyph */
export interface NormalisedResult {
  pngBuffer: Buffer;
  rawPixels: Buffer;
  width: number;
  height: number;
}

/** SSIM + pHash comparison scores for a single pair */
export interface PairComparison {
  ssim: number;
  pHash: number;
}

/**
 * How a character was rendered for a given font.
 * - "native": the requested font contains the glyph
 * - "fallback": the OS substituted a different font (pixels match a known fallback)
 * - "notdef": nothing rendered (blank canvas or replacement character)
 */
export type RenderStatus = 'native' | 'fallback' | 'notdef';

/** Per-font result for one vector */
export interface FontResult {
  font: string;
  tr39: PairComparison | null;
  nfkc: PairComparison | null;
  sourceRenderStatus: RenderStatus;
  /** Which fallback font actually produced the pixels, if status is "fallback" */
  sourceFallbackFont: string | null;
}

/** Summary statistics for one vector across all fonts */
export interface VectorSummary {
  tr39MeanSsim: number | null;
  nfkcMeanSsim: number | null;
  tr39MeanPHash: number | null;
  nfkcMeanPHash: number | null;
  validFontCount: number;
  nativeFontCount: number;
  fallbackFontCount: number;
  verdict: 'tr39' | 'nfkc' | 'equal' | 'insufficient_data';
}

/** Full result for one vector */
export interface VectorResult {
  codePoint: string;
  char: string;
  tr39Target: string;
  nfkcTarget: string;
  fonts: FontResult[];
  summary: VectorSummary;
}

/** Global summary across all vectors */
export interface GlobalSummary {
  tr39Wins: number;
  nfkcWins: number;
  ties: number;
  insufficientData: number;
  totalVectors: number;
}

/** Top-level output JSON structure (milestone 1) */
export interface OutputData {
  meta: {
    generatedAt: string;
    fontsAvailable: number;
    fontsTotal: number;
    vectorCount: number;
    platform: string;
    licence: string;
    attribution: string;
  };
  vectors: VectorResult[];
  globalSummary: GlobalSummary;
}

// --- Render index types (build-index.ts output, score-all-pairs.ts input) ---

/** One rendered character in one font, stored in the render index */
export interface IndexRenderEntry {
  font: string;
  category: 'standard' | 'math' | 'symbol' | 'noto' | 'script';
  pHash: string; // 16-char hex string encoding a 64-bit hash
  renderStatus: RenderStatus;
  fallbackFont: string | null;
  png: string; // filename relative to renders/ directory
}

/** Serialised render index written by build-index.ts */
export interface RenderIndex {
  meta: {
    generatedAt: string;
    platform: string;
    renderSize: number;
    fontsAvailable: number;
    fontsTotal: number;
    standardFonts: string[];
    sourceCharCount: number;
    targetCharCount: number;
    totalRenders: number;
  };
  /** Source character renders, keyed by character */
  sources: Record<string, IndexRenderEntry[]>;
  /** Target character renders (standard fonts only), keyed by character */
  targets: Record<string, IndexRenderEntry[]>;
}

// --- Milestone 1b types ---

/** A single confusable pair from confusable-pairs.json */
export interface ConfusablePair {
  source: string;
  sourceCodepoint: string;
  target: string;
}

/**
 * Per-comparison score for one confusable pair.
 * Records the font used for each side of the comparison:
 * - Same-font: sourceFont === targetFont (e.g. both in Arial for Cyrillic)
 * - Cross-font: sourceFont !== targetFont (e.g. Noto Sans Tifinagh vs Arial)
 *
 * Cross-font comparisons capture the realistic browser scenario: the OS renders
 * the exotic source character in a supplemental font while the target stays in
 * the page's standard font. The attacker doesn't control this pairing.
 */
export interface PairFontResult {
  sourceFont: string;
  targetFont: string;
  ssim: number | null;
  pHash: number | null;
  sourceRenderStatus: RenderStatus;
  sourceFallbackFont: string | null;
  /** True if SSIM was skipped because pHash prefilter scored too low */
  ssimSkipped: boolean;
}

/** Summary for one confusable pair across all fonts */
export interface PairSummary {
  meanSsim: number | null;
  meanPHash: number | null;
  nativeFontCount: number;
  fallbackFontCount: number;
  notdefFontCount: number;
  validFontCount: number;
}

/** Full result for one confusable pair */
export interface ConfusablePairResult {
  source: string;
  sourceCodepoint: string;
  target: string;
  fonts: PairFontResult[];
  summary: PairSummary;
}

/** Top-level output for milestone 1b */
export interface ScoreAllPairsOutput {
  meta: {
    generatedAt: string;
    fontsAvailable: number;
    fontsTotal: number;
    pairCount: number;
    platform: string;
    licence: string;
    attribution: string;
    pHashPrefilterThreshold: number;
  };
  pairs: ConfusablePairResult[];
  distribution: {
    high: number;   // SSIM >= 0.7
    medium: number; // 0.3 <= SSIM < 0.7
    low: number;    // SSIM < 0.3
    noData: number; // no valid renders
    total: number;
  };
}
