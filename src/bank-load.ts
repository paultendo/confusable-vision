import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import type { CompactBankTarget } from "./signature-bank.js";

const OUTPUT = path.resolve(import.meta.dirname, "../data/output");

/** The main signature bank plus any side banks (signature-bank-<font>.jsonl.gz, from add-font-to-bank.ts). */
export function bankFiles(): string[] {
  const side = fs.readdirSync(OUTPUT).filter((f) => /^signature-bank-.+\.jsonl\.gz$/.test(f)).map((f) => path.join(OUTPUT, f));
  // CV_BANK points at a local copy of the main bank when the archive drive is not reliably mounted
  return [process.env.CV_BANK ?? path.join(OUTPUT, "signature-bank.jsonl.gz"), ...side];
}

/** Signatures for the given code points, by font, from every bank. Lines for other code points are not parsed. */
export async function loadBankFor(cps: Set<number>): Promise<Map<number, Map<string, CompactBankTarget>>> {
  const out = new Map<number, Map<string, CompactBankTarget>>();
  for (const file of bankFiles()) {
    const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      const m = line.match(/^\{"type":"entry","cp":"([0-9A-Fa-f]+)"/);
      if (!m) continue;
      const cp = parseInt(m[1]!, 16);
      if (!cps.has(cp)) continue;
      let fonts = out.get(cp);
      if (!fonts) out.set(cp, (fonts = new Map()));
      for (const e of JSON.parse(line).entries) {
        const t: CompactBankTarget = { advanceWidth: e.advanceWidth, counts: Uint8Array.from(e.counts) };
        if (e.positions) t.positions = Uint8Array.from(e.positions);
        if (e.angles) t.angles = Uint8Array.from(e.angles);
        if (e.pingDistances) t.pingDistances = Uint8Array.from(e.pingDistances);
        if (e.pingMax) t.pingMax = Uint8Array.from(e.pingMax);
        fonts.set(e.font, t);
      }
    }
  }
  return out;
}

/** Fonts added through side banks: family to font file, from each side bank's meta line. */
export function sideBankFonts(): Map<string, string> {
  const map = new Map<string, string>();
  const registry = path.join(OUTPUT, "side-bank-fonts.json");
  if (fs.existsSync(registry)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(registry, "utf8")))) map.set(k, v as string);
  return map;
}
