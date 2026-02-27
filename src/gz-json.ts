/**
 * Helpers for reading and writing gzipped JSON files.
 *
 * Writers use streaming gzip so the full JSON string never lives in memory.
 * Readers support both sync (small files) and line-by-line async (large files).
 */

import fs from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createGunzip, gunzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Writer: streaming gzip
// ---------------------------------------------------------------------------

export interface GzWriter {
  /** Write a string chunk (queued into the gzip stream). */
  write(data: string): void;
  /** Flush and close. Must await before the file is complete. */
  close(): Promise<void>;
}

/**
 * Open a streaming gzip writer. Call `.write(str)` for each chunk,
 * then `await .close()` when done.
 *
 * Uses gzip level 6 (good balance of speed and ratio for JSON).
 */
export function createGzWriter(filePath: string): GzWriter {
  const gzip = createGzip({ level: 6 });
  const file = createWriteStream(filePath);
  gzip.pipe(file);

  return {
    write(data: string) {
      gzip.write(data);
    },
    async close() {
      gzip.end();
      await new Promise<void>((resolve, reject) => {
        file.on('finish', resolve);
        file.on('error', reject);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Reader: small files (sync)
// ---------------------------------------------------------------------------

/**
 * Read a .json.gz file into memory and parse it.
 * Only use for files that fit comfortably in memory (< ~200 MB uncompressed).
 */
export function readJsonGz<T = unknown>(filePath: string): T {
  const compressed = fs.readFileSync(filePath);
  const json = gunzipSync(compressed).toString('utf-8');
  return JSON.parse(json) as T;
}

// ---------------------------------------------------------------------------
// Reader: large files (line-by-line async)
// ---------------------------------------------------------------------------

/**
 * Create a readline interface over a .json.gz file.
 * Use with `for await (const line of rl)` to process line-by-line
 * without loading the full file into memory.
 */
export function createGzLineReader(filePath: string) {
  const gunzip = createGunzip();
  const input = createReadStream(filePath);
  return createInterface({
    input: input.pipe(gunzip),
    crlfDelay: Infinity,
  });
}
