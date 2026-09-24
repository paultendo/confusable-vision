import os from "node:os";
import { Worker } from "node:worker_threads";
import type { PathSegment } from "./types.js";

export type Signature = { counts: number[]; positions: number[]; angles: number[]; pingDistances: number[]; pingMax: number[] };

/** Signatures on every core but one: computing them one glyph at a time was the slow part of building a bank. */
export class SignaturePool {
  private workers: Worker[] = [];
  private pending = new Map<number, (s: Signature) => void>();
  private next = 0;

  constructor(size = Math.max(1, os.cpus().length - 1)) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./signature-worker.mjs", import.meta.url));
      w.on("message", (m: any) => {
        const done = this.pending.get(m.id);
        if (done) { this.pending.delete(m.id); done(m); }
      });
      w.on("error", (e) => console.error("signature worker:", e.message));
      this.workers.push(w);
    }
  }

  compute(segments: PathSegment[], frame?: { minX: number; minY: number; maxX: number; maxY: number },
    numAngles = 36, raysPerAngle = 50, gridSize = 128): Promise<Signature> {
    return new Promise((resolve) => {
      const id = this.next++;
      this.pending.set(id, resolve);
      this.workers[id % this.workers.length]!.postMessage({ id, segments, frame, numAngles, raysPerAngle, gridSize });
    });
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
