/**
 * signature-bank.ts
 *
 * Shared utilities for building, reading, and querying the signature bank.
 * The bank precomputes ray signatures across all IDNA PVALID codepoints
 * and available fonts, stored as gzipped JSONL.
 *
 * Format: line 1 is a BankMetaLine, subsequent lines are BankEntryLine
 * (one per codepoint, containing all font entries for that codepoint).
 */

import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type {
  BankEntryLine,
  BankMetaLine,
  BankEntry,
  TopologicalSignature,
  AngleSignature,
} from './types.js';

/**
 * Parse IdnaMappingTable.txt and return all PVALID codepoints.
 * PVALID = entries with status "valid" in UTS #46 format.
 * Returns sorted array of codepoint numbers.
 */
export interface ParseIdnOptions {
  /** Include codepoints with IDNA status "mapped" (e.g. uppercase A-Z, which map to lowercase).
   *  Useful for font identification and trademark comparison where uppercase glyph shapes matter. */
  includeMapped?: boolean;
}

export function parseIdnCodepoints(filePath: string, options?: ParseIdnOptions): number[] {
  const { includeMapped = false } = options ?? {};
  const text = fs.readFileSync(filePath, 'utf-8');
  const result: number[] = [];
  const validStatuses = new Set(['valid']);
  if (includeMapped) validStatuses.add('mapped');

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(';');
    if (parts.length < 2) continue;

    const status = parts[1]!.trim().split('#')[0]!.trim();
    if (!validStatuses.has(status)) continue;

    const range = parts[0]!.trim();
    if (range.includes('..')) {
      const [startHex, endHex] = range.split('..');
      const start = parseInt(startHex!, 16);
      const end = parseInt(endHex!, 16);
      for (let cp = start; cp <= end; cp++) {
        result.push(cp);
      }
    } else {
      result.push(parseInt(range, 16));
    }
  }

  result.sort((a, b) => a - b);
  return result;
}

/**
 * Flatten a TopologicalSignature into a compact counts array.
 * Layout: counts[angleIdx * raysPerAngle + rayIdx]
 */
export function signatureToCompact(
  sig: TopologicalSignature,
  numAngles: number,
  raysPerAngle: number,
): number[] {
  const counts = new Array<number>(numAngles * raysPerAngle);
  for (let a = 0; a < numAngles; a++) {
    const rays = sig.angles[a]!.rays;
    for (let r = 0; r < raysPerAngle; r++) {
      counts[a * raysPerAngle + r] = Math.min(255, rays[r]!.intersectionCount);
    }
  }
  return counts;
}

/**
 * Reconstitute a TopologicalSignature from a compact counts array.
 * Rebuilds the intersection histogram from counts.
 */
export function compactToSignature(
  counts: number[],
  numAngles: number,
  raysPerAngle: number,
): TopologicalSignature {
  const angles: AngleSignature[] = [];
  const histogram = new Map<number, number>();

  for (let a = 0; a < numAngles; a++) {
    const angle = (a * Math.PI) / numAngles;
    const rays = [];
    for (let r = 0; r < raysPerAngle; r++) {
      const count = counts[a * raysPerAngle + r]!;
      rays.push({ offset: r, intersectionCount: count });
      histogram.set(count, (histogram.get(count) ?? 0) + 1);
    }
    angles.push({ angle, rays });
  }

  return { angles, intersectionHistogram: histogram };
}

/**
 * Stream-read a gzipped JSONL bank file, invoking callback per entry line.
 * Skips the meta header line. Does not load the full file into memory.
 */
export async function streamBank(
  filePath: string,
  callback: (entry: BankEntryLine) => void,
): Promise<BankMetaLine | null> {
  const gunzip = createGunzip();
  const stream = createReadStream(filePath).pipe(gunzip);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let meta: BankMetaLine | null = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    if (parsed.type === 'meta') {
      meta = parsed as BankMetaLine;
    } else if (parsed.type === 'entry') {
      callback(parsed as BankEntryLine);
    }
  }

  return meta;
}

/**
 * Stream-read the bank, collecting only entries for the requested codepoints.
 * Returns a Map keyed by codepoint number.
 */
export async function loadBankForCodepoints(
  filePath: string,
  codepoints: Set<number>,
): Promise<Map<number, BankEntry[]>> {
  const result = new Map<number, BankEntry[]>();

  await streamBank(filePath, (entry) => {
    const cp = parseInt(entry.cp, 16);
    if (codepoints.has(cp)) {
      result.set(cp, entry.entries);
    }
  });

  return result;
}

/**
 * Count existing entry lines in an uncompressed JSONL file for resume support.
 * Returns 0 if the file doesn't exist.
 */
export function countBankLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let count = 0;
  return new Promise<number>((resolve) => {
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'entry') count++;
      } catch {
        // skip malformed lines
      }
    });
    rl.on('close', () => resolve(count));
    rl.on('error', () => resolve(count));
  }) as unknown as number;
}

/**
 * Async version of countBankLines that properly returns a Promise.
 */
export async function countBankLinesAsync(filePath: string): Promise<number> {
  if (!fs.existsSync(filePath)) return 0;

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'entry') count++;
    } catch {
      // skip malformed lines
    }
  }

  return count;
}

/**
 * Collect existing codepoints from an uncompressed JSONL file for resume.
 * Returns a Set of hex codepoint strings (e.g. "0061").
 */
/**
 * Compare two flat count arrays directly without creating TopologicalSignature objects.
 * Mirrors the compareSignatures() algorithm (0.4 * chi-squared histogram + 0.6 * positional).
 * At 133K target comparisons, avoiding 30KB object allocation per comparison is essential.
 *
 * Layout: counts[angleIdx * raysPerAngle + rayIdx]
 */
export function compareCountArrays(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  numAngles: number,
  raysPerAngle: number,
): number {
  const total = numAngles * raysPerAngle;

  // 1. Build histograms from flat arrays
  const histA = new Map<number, number>();
  const histB = new Map<number, number>();

  for (let i = 0; i < total; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    histA.set(va, (histA.get(va) ?? 0) + 1);
    histB.set(vb, (histB.get(vb) ?? 0) + 1);
  }

  // Chi-squared distance on normalised histograms
  const allKeys = new Set([...histA.keys(), ...histB.keys()]);
  let histogramDistance = 0;

  if (total > 0) {
    for (const k of allKeys) {
      const va = (histA.get(k) ?? 0) / total;
      const vb = (histB.get(k) ?? 0) / total;
      const sum = va + vb;
      if (sum > 0) {
        histogramDistance += (va - vb) * (va - vb) / sum;
      }
    }
  }

  // 2. Positional distance (MSE of intersection counts per angle)
  let positionalDistance = 0;

  if (numAngles > 0 && raysPerAngle > 0) {
    for (let ai = 0; ai < numAngles; ai++) {
      let angleDiff = 0;
      const base = ai * raysPerAngle;
      for (let ri = 0; ri < raysPerAngle; ri++) {
        const diff = a[base + ri]! - b[base + ri]!;
        angleDiff += diff * diff;
      }
      positionalDistance += angleDiff / raysPerAngle;
    }
    positionalDistance /= numAngles;
  }

  return 0.4 * histogramDistance + 0.6 * positionalDistance;
}

/**
 * Compare two enriched signatures (counts + positions).
 * Per-ray distance uses sorted intersection positions for fine-grained comparison.
 * Cross-angle aggregation uses 0.5 * mean + 0.5 * max to prevent dilution of
 * localised differences (e.g. dot on 'i' visible at one angle range).
 *
 * Falls back to compareCountArrays() if either side lacks positions.
 *
 * Position layout: positions are concatenated in angle-major, ray-minor order,
 * with sum(counts[0..i-1]) positions before ray i's positions.
 */
export function compareEnrichedArrays(
  countsA: ArrayLike<number>,
  positionsA: ArrayLike<number> | undefined,
  countsB: ArrayLike<number>,
  positionsB: ArrayLike<number> | undefined,
  numAngles: number,
  raysPerAngle: number,
  anglesA?: ArrayLike<number>,
  anglesB?: ArrayLike<number>,
  pingDistA?: ArrayLike<number>,
  pingDistB?: ArrayLike<number>,
  pingMaxA?: ArrayLike<number>,
  pingMaxB?: ArrayLike<number>,
): number {
  // Fallback to count-only comparison if positions unavailable
  if (!positionsA || !positionsB || positionsA.length === 0 || positionsB.length === 0) {
    return compareCountArrays(countsA, countsB, numAngles, raysPerAngle);
  }

  const total = numAngles * raysPerAngle;

  // Item 5: branchless -- substitute zero arrays for absent layers.
  // Weight is 0.0 for absent layers, so MSE of zeros contributes nothing.
  // This eliminates per-hit-pair branches in the innermost loop.
  const hasAngles = anglesA != null && anglesB != null && anglesA.length > 0 && anglesB.length > 0;
  const hasPings = pingDistA != null && pingDistB != null && pingDistA.length > 0 && pingDistB.length > 0;
  const hasPingMax = pingMaxA != null && pingMaxB != null && pingMaxA.length > 0 && pingMaxB.length > 0;

  const ANG_WEIGHT = hasAngles ? 0.3 : 0.0;
  const PING_WEIGHT = hasPings ? 0.3 : 0.0;
  const PING_MAX_WEIGHT = hasPingMax ? 0.3 : 0.0;

  // Substitute zero arrays so inner loop reads unconditionally (no branches).
  // When weight is 0.0, the reads are wasted work but cheaper than branch mispredictions
  // at scale (millions of comparisons in discovery scripts).
  const _angA = hasAngles ? anglesA! : positionsA;
  const _angB = hasAngles ? anglesB! : positionsB;
  const _pdA = hasPings ? pingDistA! : positionsA;
  const _pdB = hasPings ? pingDistB! : positionsB;
  const _pmA = hasPingMax ? pingMaxA! : positionsA;
  const _pmB = hasPingMax ? pingMaxB! : positionsB;

  // Walk through positions/angles/pings arrays in sync with counts
  let posOffsetA = 0;
  let posOffsetB = 0;

  let meanSum = 0;
  let maxAngleDist = 0;

  for (let ai = 0; ai < numAngles; ai++) {
    let angleSum = 0;
    const base = ai * raysPerAngle;

    for (let ri = 0; ri < raysPerAngle; ri++) {
      const idx = base + ri;
      const cA = idx < total ? countsA[idx]! : 0;
      const cB = idx < total ? countsB[idx]! : 0;

      let rayDist = 0;

      if (cA === 0 && cB === 0) {
        // Both miss: distance = 0 (skip)
      } else if (cA === cB) {
        // Same count > 0: MSE of sorted positions + angles + pings
        let posMSE = 0;
        let angMSE = 0;
        let pingMSE = 0;
        let pmaxMSE = 0;
        for (let p = 0; p < cA; p++) {
          const off = posOffsetA + p;
          const offB = posOffsetB + p;

          const posDiff = (positionsA[off]! - positionsB[offB]!) / 255;
          posMSE += posDiff * posDiff;

          const angDiff = (_angA[off]! - _angB[offB]!) / 255;
          angMSE += angDiff * angDiff;

          const pingDiff = (_pdA[off]! - _pdB[offB]!) / 255;
          pingMSE += pingDiff * pingDiff;

          const pmDiff = (_pmA[off]! - _pmB[offB]!) / 255;
          pmaxMSE += pmDiff * pmDiff;
        }
        const invC = 1 / cA;
        rayDist = posMSE * invC + ANG_WEIGHT * angMSE * invC + PING_WEIGHT * pingMSE * invC + PING_MAX_WEIGHT * pmaxMSE * invC;
      } else {
        // Different counts: match first min(cA, cB), penalty for unmatched
        const matched = Math.min(cA, cB);
        const unmatched = Math.abs(cA - cB);
        let posMSE = 0;
        let angMSE = 0;
        let pingMSE = 0;
        let pmaxMSE = 0;
        for (let p = 0; p < matched; p++) {
          const off = posOffsetA + p;
          const offB = posOffsetB + p;

          const posDiff = (positionsA[off]! - positionsB[offB]!) / 255;
          posMSE += posDiff * posDiff;

          const angDiff = (_angA[off]! - _angB[offB]!) / 255;
          angMSE += angDiff * angDiff;

          const pingDiff = (_pdA[off]! - _pdB[offB]!) / 255;
          pingMSE += pingDiff * pingDiff;

          const pmDiff = (_pmA[off]! - _pmB[offB]!) / 255;
          pmaxMSE += pmDiff * pmDiff;
        }
        const invM = matched > 0 ? 1 / matched : 0;
        const matchedDist = posMSE * invM + ANG_WEIGHT * angMSE * invM + PING_WEIGHT * pingMSE * invM + PING_MAX_WEIGHT * pmaxMSE * invM;
        rayDist = matchedDist + unmatched * 1.0;
      }

      angleSum += rayDist;
      posOffsetA += cA;
      posOffsetB += cB;
    }

    const angleMean = raysPerAngle > 0 ? angleSum / raysPerAngle : 0;
    meanSum += angleMean;
    if (angleMean > maxAngleDist) maxAngleDist = angleMean;
  }

  const globalMean = numAngles > 0 ? meanSum / numAngles : 0;
  return 0.5 * globalMean + 0.5 * maxAngleDist;
}

/**
 * Compact bank entry for per-font indexing. Avoids full BankEntry overhead.
 */
export interface CompactBankTarget {
  advanceWidth: number;
  counts: Uint8Array;
  positions?: Uint8Array;
  angles?: Uint8Array;
  pingDistances?: Uint8Array;
  pingMax?: Uint8Array;
}

/**
 * Stream-read the bank, building a per-font index of all entries.
 * Returns Map<fontFamily, Map<codepointNumber, CompactBankTarget>>.
 *
 * 133K entries * ~1.8KB counts each = ~240MB. Fits in an 8GB heap.
 */
export async function loadFullBankByFont(
  filePath: string,
): Promise<{ meta: BankMetaLine | null; index: Map<string, Map<number, CompactBankTarget>> }> {
  const index = new Map<string, Map<number, CompactBankTarget>>();

  const meta = await streamBank(filePath, (entry) => {
    const cp = parseInt(entry.cp, 16);
    for (const e of entry.entries) {
      let fontMap = index.get(e.font);
      if (!fontMap) {
        fontMap = new Map();
        index.set(e.font, fontMap);
      }
      const target: CompactBankTarget = { advanceWidth: e.advanceWidth, counts: Uint8Array.from(e.counts) };
      if (e.positions) target.positions = Uint8Array.from(e.positions);
      if (e.angles) target.angles = Uint8Array.from(e.angles);
      if (e.pingDistances) target.pingDistances = Uint8Array.from(e.pingDistances);
      if (e.pingMax) target.pingMax = Uint8Array.from(e.pingMax);
      fontMap.set(cp, target);
    }
  });

  return { meta, index };
}

export async function collectExistingCodepoints(filePath: string): Promise<Set<string>> {
  if (!fs.existsSync(filePath)) return new Set();

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  const existing = new Set<string>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'entry') {
        existing.add(parsed.cp);
      }
    } catch {
      // skip malformed lines
    }
  }

  return existing;
}
