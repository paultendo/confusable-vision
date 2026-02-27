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
  /** Raw ink width in the 64x64 canvas (before normalisation). Null if blank. */
  inkWidth?: number | null;
  /** Raw ink height in the 64x64 canvas (before normalisation). Null if blank. */
  inkHeight?: number | null;
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

// --- Glyph reuse types (detect-glyph-reuse.ts) ---

/** Result of glyph-ID check for one font comparison */
export interface GlyphReuseCheck {
  font: string;
  fontPath: string;
  sourceGlyphId: number | null;
  targetGlyphId: number | null;
  /** True when both codepoints map to the same non-.notdef glyph ID */
  glyphReuse: boolean;
}

/** Summary of glyph-reuse analysis for one pair */
export interface GlyphReuseSummary {
  source: string;
  sourceCodepoint: string;
  target: string;
  /** Number of same-font comparisons with SSIM >= 0.999 that were checked */
  checkedCount: number;
  /** Number of fonts where glyph IDs match (intentional reuse) */
  glyphReuseCount: number;
  /** Number of fonts where glyph IDs differ (raster coincidence) */
  rasterCoincidenceCount: number;
  /** True if any font shows glyph reuse */
  glyphReuse: boolean;
  fonts: GlyphReuseCheck[];
}

// --- Identifier property types (annotate-properties.ts) ---

/** Unicode identifier properties for a single codepoint */
export interface IdentifierProperties {
  /** UAX #31 XID_Start (can begin an identifier) */
  xidStart: boolean;
  /** UAX #31 XID_Continue (can continue an identifier) */
  xidContinue: boolean;
  /** IDNA 2008 PVALID (valid in internationalized domain names) */
  idnaPvalid: boolean;
  /** TR39 Identifier_Status = Allowed */
  tr39Allowed: boolean;
}

// --- Weighted edge types (generate-weights.ts) ---

/** Computed weight for a single confusable pair edge */
export interface ConfusableEdgeWeight {
  source: string;
  sourceCodepoint: string;
  target: string;
  sameMax: number;
  sameP95: number;
  sameMean: number;
  sameN: number;
  crossMax: number;
  crossP95: number;
  crossMean: number;
  crossN: number;
  /** max(sameMax, crossMax) - attacker perspective */
  danger: number;
  /** p95 across ALL comparisons - defender perspective */
  stableDanger: number;
  /** 1 - stableDanger, clamped [0, 1] */
  cost: number;
  /** True if font cmap reveals intentional glyph reuse */
  glyphReuse: boolean;
  /** Source is valid in UAX #31 identifiers (XID_Continue) */
  xidContinue: boolean;
  /** Source is valid at start of UAX #31 identifiers (XID_Start) */
  xidStart: boolean;
  /** Source is PVALID in IDNA 2008 */
  idnaPvalid: boolean;
  /** Source is TR39 Identifier_Status = Allowed */
  tr39Allowed: boolean;
  /** Whether pair exists in Unicode TR39 confusables.txt */
  inTr39: boolean;
  /** Font set used for scoring */
  fontSetId: string;
}

/** Top-level output for confusable-weights.json */
export interface ConfusableWeightsOutput {
  meta: {
    generatedAt: string;
    pairCount: number;
    tr39PairCount: number;
    novelPairCount: number;
    crossScriptPairCount: number;
    fontSetId: string;
    licence: string;
    attribution: string;
  };
  edges: ConfusableEdgeWeight[];
}

// --- Milestone 4 types (multi-character confusables) ---

/** A multi-character sequence candidate (e.g. "rn") */
export interface MulticharCandidate {
  sequence: string;
  chars: string[];
  length: number;
}

/** Full result for one multi-character pair (e.g. "rn" vs "m") */
export interface MulticharPairResult {
  source: string;
  sourceChars: string[];
  target: string;
  fonts: PairFontResult[];
  summary: PairSummary;
}

// --- Milestone 5 types (cross-script confusables) ---

/** Result for one cross-script character pair */
export interface CrossScriptPairResult {
  charA: string;
  codepointA: string;
  scriptA: string;
  charB: string;
  codepointB: string;
  scriptB: string;
  fonts: PairFontResult[];
  summary: PairSummary;
}

/** Top-level output for a single cross-script score file */
export interface CrossScriptScoreOutput {
  meta: {
    generatedAt: string;
    scriptA: string;
    scriptB: string;
    charsA: number;
    charsB: number;
    totalPairs: number;
    ssimComputed: number;
    ssimSkipped: number;
    widthRatioSkipped: number;
    pHashThreshold: number;
    widthRatioMax: number;
    licence: string;
    attribution: string;
  };
  distribution: {
    high: number;
    medium: number;
    low: number;
    noData: number;
    total: number;
  };
  pairs: CrossScriptPairResult[];
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
