/**
 * build-unicode-submission.ts
 *
 * Proposed additions to Unicode confusables data, in the layout of unicodetools'
 * data/security/dev/data/source/formatted-*.txt (as requested by the Unicode Properties and Algorithms Working Group),
 * from the release 2 scoring (rescore-pairs.ts).
 *
 * A pair is proposed when:
 *   - both characters are letters or digits (general category L or N);
 *   - confusables.txt (data/input, the current release) does not already give them the same skeleton;
 *   - they look alike at the same size in running text: alike (release 2 distance below 0.5, size gate passed) in at
 *     least MIN_FONTS text fonts and in at least MIN_SHARE of the text fonts that render both characters (display,
 *     handwriting and symbol faces, src/display-fonts.ts, are left out of both counts).
 *
 * One of the two must be in no class today (it maps to nothing and nothing maps to it), so the line adds it to the
 * other's class ("prototype ; character"). Pairs whose characters already belong to two different classes would merge
 * those classes, which is the working group's call; they are listed separately and not proposed.
 *
 * Writes data/output/unicode-submission/:
 *   formatted-rayspace.txt   the proposed lines
 *   measurements.tsv         the same lines, in the same order, with the measurements behind each
 *   class-merges.tsv         pairs that would merge existing classes
 *
 * Cross-font pairs (score-cross-font.ts: a fallback-font character against Latin in a common text font) are merged in
 * with the same rules, their share being the fraction of font combinations where the character is at least as close
 * to the target as the target is to itself in another typeface.
 *
 * Usage:
 *   npx tsx scripts/build-unicode-submission.ts [rescored-pairs.jsonl] [cross-font-pairs.jsonl]
 */

import fs from "node:fs";
import path from "node:path";
import { DISPLAY_FONTS } from "../src/display-fonts.js";
import { SAME_FONT, ACROSS_FONTS, passes } from "../src/thresholds.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const rescoredPath = process.argv[2] ?? path.join(ROOT, "data/output/rescored-pairs.jsonl");
const crossFontPath = process.argv[3] ?? path.join(ROOT, "data/output/cross-font-pairs.jsonl");
const outDir = path.join(ROOT, "data/output/unicode-submission");
const MIN_FONTS = SAME_FONT.minFonts;
const MIN_SHARE = SAME_FONT.minShare;
const MIN_SHARE_ACROSS_FONTS = ACROSS_FONTS.minShare;

const hexOf = (cp: number) => cp.toString(16).toUpperCase().padStart(4, "0");

/** TR39 skeleton of one character: NFD, map each code point through confusables.txt, NFD again (as hex, space-separated). */
function skeletonOf(cp: number, map: Map<number, string>): string {
  const mapped = [...String.fromCodePoint(cp).normalize("NFD")]
    .map((ch) => map.get(ch.codePointAt(0)!) ?? hexOf(ch.codePointAt(0)!)).join(" ");
  const text = mapped.split(" ").map((h) => String.fromCodePoint(parseInt(h, 16))).join("").normalize("NFD");
  return [...text].map((ch) => hexOf(ch.codePointAt(0)!)).join(" ");
}

function confusables(): { skeleton: (cp: number) => string; classed: (cp: number) => boolean; header: string } {
  const text = fs.readFileSync(path.join(ROOT, "data/input/confusables.txt"), "utf8").replace(/^﻿/, "");
  const map = new Map<number, string>();
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const [src, tgt] = line.split(";").map((s) => s.trim());
    if (src!.includes(" ")) continue;
    map.set(parseInt(src!, 16), tgt!);
  }
  const targets = new Set(map.values());
  const date = text.match(/^# Date: (\d{4}-\d{2}-\d{2})/m)?.[1];
  const version = text.match(/^# Version: ([\d.]+)/m)?.[1];
  const header = `confusables.txt ${version ?? ""} (${date ?? "undated"})`;
  return {
    skeleton: (cp) => skeletonOf(cp, map),
    classed: (cp) => map.has(cp) || targets.has(hexOf(cp)) || skeletonOf(cp, map) !== hexOf(cp),
    header,
  };
}

function unicodeData(): Map<number, { name: string; gc: string }> {
  const out = new Map<number, { name: string; gc: string }>();
  for (const line of fs.readFileSync(path.join(ROOT, "data/input/UnicodeData.txt"), "utf8").split("\n")) {
    const f = line.split(";");
    if (f.length > 2) out.set(parseInt(f[0]!, 16), { name: f[1]!, gc: f[2]! });
  }
  return out;
}

/** Prefer ASCII, then Latin, then the lower code point, as the prototype of a new class. */
function prototypeOrder(a: number, b: number): [number, number] {
  const rank = (cp: number) => (cp < 0x80 ? 0 : cp < 0x250 ? 1 : 2);
  return rank(a) !== rank(b) ? (rank(a) < rank(b) ? [a, b] : [b, a]) : a < b ? [a, b] : [b, a];
}

function main() {
  const { skeleton, classed, header } = confusables();
  const ud = unicodeData();
  const name = (cp: number) => ud.get(cp)?.name ?? `U+${hexOf(cp)}`;
  const chars = (seq: string) => seq.split(" ").map((h) => String.fromCodePoint(parseInt(h, 16))).join("");
  const names = (seq: string) => seq.split(" ").map((h) => name(parseInt(h, 16))).join(", ");
  const letterOrDigit = (cp: number) => /^[LN]/.test(ud.get(cp)?.gc ?? "");

  type Line = { target: string; source: number; m: Record<string, any> };
  const lines: Line[] = [];
  const merges: string[] = [];
  // Both kinds of measurement in one shape: a, b, textFontsAlike, textFontsRenderingBoth, textShare, method
  const measured: Record<string, any>[] = [];
  for (const raw of fs.readFileSync(rescoredPath, "utf8").split("\n")) {
    if (raw) measured.push({ ...JSON.parse(raw), method: "same font" });
  }
  if (fs.existsSync(crossFontPath)) {
    for (const raw of fs.readFileSync(crossFontPath, "utf8").split("\n")) {
      if (!raw) continue;
      const c = JSON.parse(raw);
      measured.push({ a: c.x, b: c.t, alike: c.alike, share: c.share,
        textFontsAlike: c.alike, textFontsRenderingBoth: c.combos, textShare: c.share,
        meanDistanceWhereAlike: null, fontsAtZero: null, alikeFonts: Object.fromEntries(c.alikeIn.map((f: string) => [f, null])),
        method: "across fonts" });
    }
  }
  for (const m of measured) {
    const a = parseInt(m.a.slice(2), 16), b = parseInt(m.b.slice(2), 16);
    if (!letterOrDigit(a) || !letterOrDigit(b)) continue;
    if (!passes(m)) continue;
    const sa = skeleton(a), sb = skeleton(b);
    if (sa === sb) continue;
    const aMapped = classed(a), bMapped = classed(b);
    if (aMapped && bMapped) {
      merges.push([`U+${hexOf(a)}`, String.fromCodePoint(a), `U+${hexOf(b)}`, String.fromCodePoint(b),
        chars(sa), chars(sb), m.textFontsAlike, m.textFontsRenderingBoth, m.textShare, m.meanDistanceWhereAlike ?? "n/a"].join("\t"));
      continue;
    }
    if (bMapped) lines.push({ target: sb, source: a, m });
    else if (aMapped) lines.push({ target: sa, source: b, m });
    else {
      // Neither is mapped: the more common character becomes the prototype
      const [t, s] = prototypeOrder(a, b);
      // If the chosen prototype is itself proposed as the source of another line, the class resolves later
      lines.push({ target: hexOf(t), source: s, m });
    }
  }

  // One line per source character: where a character matches several prototypes, keep its strongest match
  const best = new Map<number, Line>();
  for (const l of lines) {
    const cur = best.get(l.source);
    if (!cur || l.m.textShare > cur.m.textShare || (l.m.textShare === cur.m.textShare && l.m.meanDistanceWhereAlike < cur.m.meanDistanceWhereAlike)) {
      best.set(l.source, l);
    }
  }
  const chosen = [...best.values()].sort((p, q) =>
    p.target.localeCompare(q.target) || q.m.textShare - p.m.textShare || p.source - q.source);

  const today = new Date().toISOString().slice(0, 10);
  const out: string[] = [
    "# formatted-rayspace.txt",
    `# Date: ${today}`,
    "# Proposed confusables from confusable-vision (RaySpace), Paul Wood FRSA. Submitted under the Unicode CLA.",
    `# Each line adds a character that ${header} puts in no class to an existing class, or pairs two such`,
    `# characters. Criteria: both letters or digits; alike at the same size in at least ${MIN_FONTS} text fonts (or all`,
    `# that render both, if fewer) and in at least ${MIN_SHARE * 100}% of them, or across fonts in at least ${MIN_SHARE_ACROSS_FONTS * 100}% of`,
    `# font combinations. Measurements: measurements.tsv.`,
    "#",
  ];
  const tsv = ["target\tsource\ttarget_char\tsource_char\tmethod\talike\tcompared\tshare\tmean_distance_where_alike\tfonts_at_zero\talike_in"];
  let prev = "";
  for (const l of chosen) {
    if (prev && prev !== l.target) out.push("");
    prev = l.target;
    const t = chars(l.target), s = String.fromCodePoint(l.source);
    out.push(`${l.target} ;\t${hexOf(l.source)}\t# ( ${t} ~ ${s} ) ${names(l.target)} ~ ${name(l.source)}`);
    tsv.push([l.target, hexOf(l.source), t, s, l.m.method, l.m.textFontsAlike, l.m.textFontsRenderingBoth, l.m.textShare,
      l.m.meanDistanceWhereAlike ?? "n/a", l.m.fontsAtZero ?? "n/a",
      Object.keys(l.m.alikeFonts).filter((f) => !DISPLAY_FONTS.has(f)).join(", ")].join("\t"));
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "formatted-rayspace.txt"), out.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "measurements.tsv"), tsv.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "class-merges.tsv"),
    ["a\ta_char\tb\tb_char\ta_class\tb_class\ttext_fonts_alike\ttext_fonts_rendering_both\ttext_share\tmean_distance_where_alike", ...merges].join("\n") + "\n");
  console.log(`${chosen.length} proposed lines (${new Set(chosen.map((l) => l.target)).size} classes); ${merges.length} class merges listed separately -> ${outDir}`);
}

main();
