/**
 * Type definitions for the score worker thread.
 * The actual worker is ssim-worker.js (plain JS).
 */

import type { InkBounds } from './normalise-image.js';

/** Work item sent to workers: raw decoded data for normalise + ink + SSIM. */
export interface NormWorkItem {
  /** Index in the original work array (for result ordering). */
  idx: number;
  /** Source decoded greyscale pixels. */
  pixelsA: Buffer;
  /** Source image width. */
  widthA: number;
  /** Source image height. */
  heightA: number;
  /** Source ink bounding box (null if blank). */
  boundsA: InkBounds | null;
  /** Target decoded greyscale pixels. */
  pixelsB: Buffer;
  /** Target image width. */
  widthB: number;
  /** Target image height. */
  heightB: number;
  /** Target ink bounding box (null if blank). */
  boundsB: InkBounds | null;
  /** Minimum ink coverage threshold. */
  inkCoverageMin: number;
}

/** Result from worker: SSIM score or ink-skip indication. */
export interface NormWorkResult {
  idx: number;
  ssim: number | null;
  inkSkipped: boolean;
}
