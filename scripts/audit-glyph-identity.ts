/**
 * audit-glyph-identity.ts
 *
 * A recall test that owes nothing to Unicode's confusables list. When a font draws two code points with the same glyph
 * (one glyph ID for both, or two glyph IDs with byte-identical outlines), the two characters are identical in that
 * font, so any correct measurement must find them alike there. This finds every such pair among the release's measured
 * characters in the release's fonts, then checks each one against the release: is the pair a lookalike, and is that
 * font among the fonts it is alike in?
 *
 * Pairs are split by whether the release compared them at all (its populations: characters of different scripts, or
 * one of them an ASCII letter or digit), since a pair outside them is out of scope rather than missed.
 *
 * Usage:
 *   CV_BANK=... npx tsx scripts/audit-glyph-identity.ts [release-dir]
 *   CV_BANK=... npx tsx scripts/audit-glyph-identity.ts --pairs data/output/exhaustive-pairs.jsonl   (check a scoring run
 *     instead of a release: every pair is then in scope, and the run must find all of them)
 *   CV_BANK=... npx tsx scripts/audit-glyph-identity.ts --pairs data/output/all-pairs-nonhan.jsonl
 *     --chars data/output/all-pairs-nonhan.chars.json   (score-all.ts runs: each font's characters are the ones the run
 *     says it compared in that font, taken from the font's own character map, so the audit does not inherit the
 *     release's list; any identical pair among a font's letters and digits that the run missed is counted)
 *
 * Output: data/output/glyph-identity-audit.json, and a summary on stderr
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { DISPLAY_FONTS } from "../src/display-fonts.js";
import { loadBankFor } from "../src/bank-load.js";
import { loadFont } from "../src/glyph-path.js";
import { loadFace, measuredFamilies } from "../src/font-catalogue.js";
import { systemFontPaths } from "../src/glyph-box.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const pairsArg = process.argv.includes("--pairs") ? process.argv[process.argv.indexOf("--pairs") + 1]! : undefined;
const charsArg = process.argv.includes("--chars") ? process.argv[process.argv.indexOf("--chars") + 1]! : undefined;
const runChars: Record<string, number[]> | undefined = charsArg ? JSON.parse(fs.readFileSync(charsArg, "utf8")) : undefined;
const releaseDir = (!pairsArg && process.argv[2]) || path.join(ROOT, "data/release", fs.readdirSync(path.join(ROOT, "data/release")).sort().at(-1)!);
const jsonl = (buf: Buffer) => buf.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function main() {
  const characters = jsonl(gunzipSync(fs.readFileSync(path.join(releaseDir, "characters.jsonl.gz"))));
  const byCp = new Map<number, { script: string; char: string }>(characters.map((c: any) => [parseInt(c.codepoint.slice(2), 16), c]));
  // Checking a scoring run: the same characters score-exhaustive.ts compares (the ASCII letters and digits, and every
  // uppercase form), so a capital pair the run missed is counted as missed rather than left out of the audit
  if (pairsArg) {
    for (const ch of "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") byCp.set(ch.codePointAt(0)!, { script: "", char: ch });
    for (const cp of [...byCp.keys()]) {
      const up = String.fromCodePoint(cp).toUpperCase();
      if ([...up].length === 1 && up.codePointAt(0) !== cp && !byCp.has(up.codePointAt(0)!)) byCp.set(up.codePointAt(0)!, { script: "", char: up });
    }
  }
  const alikeIn = new Map<string, Set<string>>();
  const rows = pairsArg ? jsonl(fs.readFileSync(pairsArg)) : jsonl(gunzipSync(fs.readFileSync(path.join(releaseDir, "lookalikes.jsonl.gz"))));
  for (const l of rows) {
    if (l.method !== "same font") continue;
    const [a, b] = [parseInt(l.a.slice(2), 16), parseInt(l.b.slice(2), 16)].sort((x, y) => x - y);
    alikeIn.set(`${a}|${b}`, new Set(pairsArg ? Object.keys(l.alike) : l.alikeIn));
    // A scoring run's characters may go beyond the release's (capitals): include them in the audit
    if (pairsArg) for (const cp of [a, b]) if (!byCp.has(cp)) byCp.set(cp, { script: "", char: String.fromCodePoint(cp) });
  }

  // The release's fonts, as the bank measured them (the letter a is in every text font)
  // With --chars (score-all.ts runs), the run's fonts from the font catalogue, each in the face the run loaded; otherwise
  // the bank's fonts (cached in bank-fonts.json; reading them from the bank means reading all 7.8 GB), in face 0
  const cache = path.join(ROOT, "data/output/bank-fonts.json");
  const paths = systemFontPaths();
  const fonts = runChars ? measuredFamilies().filter((f) => !DISPLAY_FONTS.has(f)).sort()
    : (fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8")) as string[] : [...(await loadBankFor(new Set([0x61]))).get(0x61)!.keys()])
      .filter((f) => paths.has(f) && !DISPLAY_FONTS.has(f)).sort();
  // A font the run did not compare at all is a miss for all its identical pairs, not a font to skip
  if (runChars) for (const f of fonts) if (!runChars[f]) console.error(`run has no characters for ${f}`);
  console.error(`${byCp.size} measured characters, ${fonts.length} text fonts`);

  const isHan = (cp: number) => /\p{Script=Han}/u.test(String.fromCodePoint(cp));
  const ascii = (cp: number) => /[a-z0-9]/i.test(String.fromCodePoint(cp)) && cp < 0x80;
  const inScope = (a: number, b: number) => {
    if (runChars) return true;
    if (pairsArg) return !isHan(a) && !isHan(b);
    const sa = byCp.get(a)?.script, sb = byCp.get(b)?.script;
    return ascii(a) || ascii(b) || (!!sa && !!sb && sa !== sb);
  };

  type Found = { a: string; b: string; font: string; how: "same glyph" | "same outline"; inScope: boolean; inRelease: boolean; alikeInFont: boolean };
  const found: Found[] = [];
  for (const family of fonts) {
    const font = runChars ? loadFace(family) : loadFont(paths.get(family)!);
    if (!font) continue;
    const byGlyph = new Map<number, number[]>(), byOutline = new Map<string, number[]>();
    for (const cp of runChars ? (runChars[family] ?? []) : byCp.keys()) {
      let g;
      try { g = font.glyphForCodePoint(cp); } catch { continue; }
      if (!g || g.id === 0) continue;
      (byGlyph.get(g.id) ?? byGlyph.set(g.id, []).get(g.id)!).push(cp);
      let svg = "";
      try { svg = g.path?.toSVG?.() ?? ""; } catch { /* no outline */ }
      if (svg.length > 8) {
        const h = createHash("sha1").update(svg).digest("hex");
        (byOutline.get(h) ?? byOutline.set(h, []).get(h)!).push(cp);
      }
    }
    const seen = new Set<string>();
    const emit = (cps: number[], how: Found["how"]) => {
      for (let i = 0; i < cps.length; i++) for (let j = i + 1; j < cps.length; j++) {
        const [a, b] = [cps[i]!, cps[j]!].sort((x, y) => x - y);
        const key = `${a}|${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rel = alikeIn.get(key);
        found.push({ a: `U+${a.toString(16).toUpperCase().padStart(4, "0")}`, b: `U+${b.toString(16).toUpperCase().padStart(4, "0")}`, font: family, how,
          inScope: inScope(a, b), inRelease: !!rel, alikeInFont: !!rel?.has(family) });
      }
    };
    if (font._glyphs) font._glyphs = []; // fontkit's glyph cache: large for CJK fonts, not needed again
    for (const cps of byGlyph.values()) if (cps.length > 1) emit(cps, "same glyph");
    for (const cps of byOutline.values()) if (cps.length > 1) emit(cps, "same outline");
  }

  const pairs = new Map<string, Found[]>();
  for (const f of found) (pairs.get(`${f.a}|${f.b}`) ?? pairs.set(`${f.a}|${f.b}`, []).get(`${f.a}|${f.b}`)!).push(f);
  const scoped = [...pairs.values()].filter((fs) => fs[0]!.inScope);
  const fontLevel = found.filter((f) => f.inScope);
  const missedFontLevel = fontLevel.filter((f) => !f.alikeInFont);
  const pairMissing = scoped.filter((fs) => !fs[0]!.inRelease);
  const pairPartial = scoped.filter((fs) => fs[0]!.inRelease && fs.some((f) => !f.alikeInFont));
  const s = (n: number, d: number) => `${n}/${d} (${d ? Math.round((100 * n) / d) : 0}%)`;
  console.error(`identical pairs in text fonts: ${pairs.size} (${scoped.length} inside the release's comparison populations)`);
  console.error(`font-level: release finds ${s(fontLevel.length - missedFontLevel.length, fontLevel.length)} of the (pair, font) cases where the two are identical`);
  console.error(`pair-level: ${pairMissing.length} identical pairs are absent from the release; ${pairPartial.length} are present but missing some fonts where they are identical`);
  fs.writeFileSync(path.join(ROOT, pairsArg ? "data/output/glyph-identity-audit-run.json" : "data/output/glyph-identity-audit.json"), JSON.stringify({
    release: pairsArg ?? path.basename(releaseDir), fonts: fonts.length,
    summary: { pairs: pairs.size, inScope: scoped.length, fontLevel: fontLevel.length, missedFontLevel: missedFontLevel.length, pairMissing: pairMissing.length, pairPartial: pairPartial.length },
    missing: pairMissing.map((fs) => ({ a: fs[0]!.a, b: fs[0]!.b, fonts: fs.map((f) => `${f.font} (${f.how})`) })),
    partial: pairPartial.map((fs) => ({ a: fs[0]!.a, b: fs[0]!.b, missedIn: fs.filter((f) => !f.alikeInFont).map((f) => `${f.font} (${f.how})`) })),
  }, null, 1));
}

main();
