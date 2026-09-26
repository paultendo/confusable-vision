/**
 * build-release.ts
 *
 * The confusable-vision dataset as a versioned release, in a stable shape, so downstream tools pin a version and apply
 * their own rule instead of adapting to each output file. Release 3 is built from one exhaustive run (score-all.ts
 * --scope all --cross --sequences) and the in-place stage over it (in-place.ts). Release 2 (2026.09.24 and .25) is
 * built by this script as it was in git before release 3.
 *
 *   characters.jsonl.gz  every code point measured, with its Unicode, TR39, IDNA2008 and registry properties
 *   lookalikes.jsonl.gz  every pair found alike in at least one font or font combination, within one font or across
 *                        fonts, with the counts behind it and, within one font, the distances in each font
 *   sequences.jsonl.gz   characters found alike to a two-character ASCII sequence (ǁ and ll, Ы and bl), within one font
 *                        or across fonts
 *   in-place.jsonl.gz    every candidate lookalike of an ASCII letter, digit or two-letter sequence, set between
 *                        neighbours in five common fonts at text size, with the verdict in each
 *   DATASET.md           the fields, the populations compared, what an absent pair means, and the thresholds
 *   SHA256SUMS
 *
 * Usage:
 *   npx tsx scripts/build-release.ts <YYYY.MM.DD> [--run all-pairs-v8]
 *
 * Output: data/release/<version>/
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { domainToUnicode } from "node:url";
import { gzipSync } from "node:zlib";
import { rangeLookup } from "../src/ranges.js";
import { passes } from "../src/thresholds.js";

const ROOT = join(import.meta.dirname, "..");
const version = process.argv[2];
if (!version || !/^\d{4}\.\d{2}\.\d{2}$/.test(version)) {
  console.error("usage: npx tsx scripts/build-release.ts <YYYY.MM.DD> [--run all-pairs-v8]");
  process.exit(2);
}
const RUN = process.argv.includes("--run") ? process.argv[process.argv.indexOf("--run") + 1]! : "all-pairs-v8";
const outDir = join(ROOT, "data/release", version);
const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
const out = (suffix: string) => `data/output/${RUN}.${suffix}`;
const jsonl = (file: string) =>
  readFileSync(join(ROOT, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

function rangeProperty(file: string): { get: (cp: number) => string | undefined; date?: string } {
  const text = readFileSync(join(ROOT, file), "utf8");
  return { get: rangeLookup(join(ROOT, file)), date: text.match(/^# Date: (\S+)/m)?.[1] };
}

/** Where each code point can be registered, from data/input/tld-rules.json (scripts/build-tld-rules.py): a TLD takes a
 * character when one of its registry's tables lists it. ASCII letters, digits and hyphen are registrable everywhere. */
function registrable() {
  const data = JSON.parse(readFileSync(join(ROOT, "data/input/tld-rules.json"), "utf8"));
  const tables: Set<number>[] = (data.tables as string[]).map((t) => {
    const set = new Set<number>();
    for (const part of t.split(" ")) {
      if (!part || part === "CJK") continue;
      const [a, b] = part.split("..");
      for (let cp = parseInt(a!, 16); cp <= parseInt(b ?? a!, 16); cp++) set.add(cp);
    }
    return set;
  });
  const cjkTables = new Set((data.tables as string[]).flatMap((t, i) => (t.startsWith("CJK") ? [i] : [])));
  const cjk = (cp: number) => (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) || cp >= 0x20000;
  const rules = Object.entries(data.rules as Record<string, number[] | "ascii">);
  const ascii = (cp: number) => (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x30 && cp <= 0x39) || cp === 0x2d;
  const tld = (t: string) => "." + (t.startsWith("xn--") ? domainToUnicode(t) : t);
  const names = rules.map(([t]) => tld(t));
  return {
    at: (cp: number) => rules.flatMap(([, r], k) => ascii(cp) ||
      (r !== "ascii" && r.some((i) => (cjk(cp) ? cjkTables.has(i) : tables[i]!.has(cp)))) ? [names[k]!] : []),
    tlds: names, fetched: data.fetched as string,
  };
}

function main() {
  const idType = rangeProperty("data/input/IdentifierType.txt");
  const idna = rangeProperty("data/input/IdnaMappingTable.txt");
  const scripts = rangeProperty("data/input/Scripts.txt");
  const confusablesDate = readFileSync(join(ROOT, "data/input/confusables.txt"), "utf8").match(/^# Date: (.+)$/m)?.[1]?.trim();
  const reg = registrable();
  const unicodeData = new Map<number, { name: string; gc: string }>();
  for (const line of readFileSync(join(ROOT, "data/input/UnicodeData.txt"), "utf8").split("\n")) {
    const f = line.split(";");
    if (f.length > 2) unicodeData.set(parseInt(f[0]!, 16), { name: f[1]!, gc: f[2]! });
  }

  // Within one font: every pair alike in at least one font, with the distances there ([shape, baseline-anchored])
  const lookalikes: Record<string, any>[] = [];
  for (const m of jsonl(out("jsonl"))) {
    const alike = m.alike as Record<string, [number, number]>;
    const fonts = Object.keys(alike);
    lookalikes.push({
      a: m.a, b: m.b, method: "same font",
      textFontsRenderingBoth: m.textFontsRenderingBoth, textFontsAlike: m.textFontsAlike, textShare: m.textShare,
      fontsRenderingBoth: m.fontsRenderingBoth, fontsAlike: m.fontsAlike, share: m.share,
      meanDistanceWhereAlike: fonts.length ? r4(fonts.reduce((s, f) => s + alike[f]![0], 0) / fonts.length) : null,
      fontsAtZero: fonts.filter((f) => alike[f]![0] === 0 && alike[f]![1] === 0).length,
      alikeIn: fonts, distances: alike,
    });
  }
  // Across fonts: a character in its own font against an ASCII letter or digit in a page font that lacks it
  for (const c of jsonl(out("cross.jsonl"))) {
    if (!c.alike) continue;
    lookalikes.push({ a: c.x, b: c.t, method: "across fonts", combinations: c.combos, alike: c.alike, share: c.share,
      minDistance: c.minDistance, alikeIn: c.alikeIn, macosActual: c.macosActual });
  }
  lookalikes.sort((p, q) => (p.a + p.b + p.method).localeCompare(q.a + q.b + q.method));

  // A character against a two-character ASCII sequence, as the font sets the sequence
  const sequences: Record<string, any>[] = [];
  for (const m of jsonl(out("seq.jsonl"))) {
    sequences.push({ a: m.a, b: m.b, method: "same font",
      textFontsRenderingBoth: m.textFontsRenderingBoth, textFontsAlike: m.textFontsAlike, textShare: m.textShare,
      fontsRenderingBoth: m.fontsRenderingBoth, fontsAlike: m.fontsAlike, share: m.share,
      alikeIn: Object.keys(m.alike), distances: m.alike });
  }
  for (const c of jsonl(out("seq-cross.jsonl"))) {
    if (!c.alike) continue;
    sequences.push({ a: c.x, b: c.t, method: "across fonts", combinations: c.combos, alike: c.alike, share: c.share,
      minDistance: c.minDistance, alikeIn: c.alikeIn });
  }
  sequences.sort((p, q) => (p.a + p.b + p.method).localeCompare(q.a + q.b + q.method));

  // In place: one row per candidate, with each context's verdict at 1x and 2x
  const byCandidate = new Map<string, any[]>();
  // Plus the ASCII lookalikes Unicode lists (1 and l, 0 and O, m and rn), checked the same way (data/input/ascii-known.txt:
  // in-place.ts --pairs data/input/ascii-known.txt --how "Unicode (ASCII)" --out data/output/<run>.ascii.in-place.jsonl)
  const asciiRows = existsSync(join(ROOT, out("ascii.in-place.jsonl"))) ? jsonl(out("ascii.in-place.jsonl")) : [];
  for (const r of [...jsonl(out("in-place.jsonl")), ...asciiRows]) {
    const k = `${r.x}\u0000${r.t}`;
    (byCandidate.get(k) ?? byCandidate.set(k, []).get(k)!).push(r);
  }
  const verdict = (d: any) => d.inPlace ? "strict" : d.inPlaceBroad ? "broad" : d.designs?.length ? "design" : "no";
  const rank = { strict: 3, broad: 2, design: 1, no: 0 } as Record<string, number>;
  const inPlace: Record<string, any>[] = [];
  const tierCounts: Record<string, number> = { strict: 0, broad: 0, design: 0, no: 0 };
  for (const rows of byCandidate.values()) {
    const { x, t, how } = rows[0];
    const contexts = rows.map((r) => r.byDisplay ? {
      context: r.context, faces: String(r.faces).split(","), distance: r.distance, anchor: r.anchor, anchorBroad: r.anchorBroad,
      ink: r.ink, gaps: r.gaps, reordered: r.reordered,
      ...(r.letterDistances ? { letterDistances: r.letterDistances } : {}),
      dpr1: { verdict: verdict(r.byDisplay[1]), ...(r.byDisplay[1].designs?.length ? { designs: r.byDisplay[1].designs } : {}), failed: r.byDisplay[1].failed },
      dpr2: { verdict: verdict(r.byDisplay[2]), ...(r.byDisplay[2].designs?.length ? { designs: r.byDisplay[2].designs } : {}), failed: r.byDisplay[2].failed },
    } : { context: r.context, note: r.note ?? "not laid out" });
    const tier = rows.filter((r) => r.byDisplay).flatMap((r) => [verdict(r.byDisplay[1]), verdict(r.byDisplay[2])])
      .reduce((best, v) => (rank[v]! > rank[best]! ? v : best), "no");
    tierCounts[tier]!++;
    inPlace.push({ a: hex(x.codePointAt(0)!), b: t, found: how, tier, contexts });
  }
  inPlace.sort((p, q) => (p.a + p.b).localeCompare(q.a + q.b));

  // Characters: every code point a font was measured on, and every code point in a row
  const cps = new Set<number>();
  for (const list of Object.values(JSON.parse(readFileSync(join(ROOT, out("chars.json")), "utf8"))) as number[][]) for (const cp of list) cps.add(cp);
  for (const l of lookalikes) { cps.add(parseInt(l.a.slice(2), 16)); cps.add(parseInt(l.b.slice(2), 16)); }
  for (const l of [...sequences, ...inPlace]) cps.add(parseInt(l.a.slice(2), 16));
  const charRows = [...cps].sort((a, b) => a - b).map((cp) => JSON.stringify({
    codepoint: hex(cp), char: String.fromCodePoint(cp), name: unicodeData.get(cp)?.name ?? "",
    script: scripts.get(cp) ?? "Unknown", generalCategory: unicodeData.get(cp)?.gc ?? "",
    identifierType: idType.get(cp) ?? "Not_Character", idna2008: idna.get(cp)?.split(" ")[0] ?? "unknown",
    registrableAt: reg.at(cp),
  }));

  mkdirSync(outDir, { recursive: true });
  const files: Record<string, Buffer> = {
    "characters.jsonl.gz": gzipSync(charRows.join("\n") + "\n", { level: 9 }),
    "lookalikes.jsonl.gz": gzipSync(lookalikes.map((l) => JSON.stringify(l)).join("\n") + "\n", { level: 9 }),
    "sequences.jsonl.gz": gzipSync(sequences.map((l) => JSON.stringify(l)).join("\n") + "\n", { level: 9 }),
    "in-place.jsonl.gz": gzipSync(inPlace.map((l) => JSON.stringify(l)).join("\n") + "\n", { level: 9 }),
  };
  const sameFont = lookalikes.filter((l) => l.method === "same font");
  const across = lookalikes.filter((l) => l.method === "across fonts");
  const fonts = Object.keys(JSON.parse(readFileSync(join(ROOT, out("chars.json")), "utf8"))).length;
  files["DATASET.md"] = Buffer.from(card({
    version, fonts, characters: charRows.length, sameFont: sameFont.length, acrossFonts: across.length,
    sameFontPassing: sameFont.filter((l) => passes(l as Parameters<typeof passes>[0])).length,
    acrossPassing: across.filter((l) => passes(l as Parameters<typeof passes>[0])).length,
    sequences: sequences.length, inPlace: inPlace.length, tierCounts, reg, idTypeDate: idType.date, confusablesDate,
  }));
  const sums: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(outDir, name), body);
    sums.push(`${createHash("sha256").update(body).digest("hex")}  ${name}`);
  }
  writeFileSync(join(outDir, "SHA256SUMS"), sums.join("\n") + "\n");
  console.log(`${outDir}: ${charRows.length} characters; ${sameFont.length} same-font and ${across.length} cross-font lookalikes; ` +
    `${sequences.length} sequences; ${inPlace.length} in place (strict ${tierCounts.strict}, broad ${tierCounts.broad}, design ${tierCounts.design})`);
}

function card(x: { version: string; fonts: number; characters: number; sameFont: number; acrossFonts: number;
  sameFontPassing: number; acrossPassing: number; sequences: number; inPlace: number; tierCounts: Record<string, number>;
  reg: { tlds: string[]; fetched: string }; idTypeDate?: string; confusablesDate?: string }): string {
  const n = (v: number) => v.toLocaleString("en-GB");
  return `# confusable-vision lookalikes, release ${x.version}

Which Unicode characters look like which, measured from the fonts' outlines. Each glyph is measured by RaySpace (rays
cast through its outline, 36 angles, 50 rays each, 128px grid) twice: once in its own box, for shape, and once in a
fixed frame on the baseline, so the size and position a glyph has in running text count. The lookalikes of ASCII
letters, digits and two-letter sequences are then checked in place: set between neighbouring letters in common fonts
at the size people read them, and compared with pairs everyone accepts as alike (0 and O, 1 and l, I and l).

Licence: CC-BY-4.0. Attribution: confusable-vision, Paul Wood FRSA (@paultendo).

This release replaces release 2 (2026.09.24 and 2026.09.25), which compared only the pairs and fonts earlier runs had
compared: see Changes.

## Files

| File | Rows | One row per |
|---|---|---|
| \`characters.jsonl.gz\` | ${n(x.characters)} | code point measured |
| \`lookalikes.jsonl.gz\` | ${n(x.sameFont + x.acrossFonts)} | pair alike in at least one font or combination: ${n(x.sameFont)} within one font (${n(x.sameFontPassing)} pass the suggested thresholds), ${n(x.acrossFonts)} across fonts (${n(x.acrossPassing)} pass) |
| \`sequences.jsonl.gz\` | ${n(x.sequences)} | character alike to a two-character ASCII sequence |
| \`in-place.jsonl.gz\` | ${n(x.inPlace)} | candidate lookalike of an ASCII letter, digit or sequence, checked in place: strict ${n(x.tierCounts.strict!)}, broad ${n(x.tierCounts.broad!)}, design ${n(x.tierCounts.design!)}, not alike ${n(x.tierCounts.no!)} |

\`SHA256SUMS\` covers all five. Pin the release by its version.

### characters.jsonl.gz

| Field | Meaning |
|---|---|
| \`codepoint\`, \`char\`, \`name\`, \`script\`, \`generalCategory\` | the character, from the Unicode Character Database |
| \`identifierType\` | TR39 Identifier_Type (IdentifierType.txt dated ${x.idTypeDate ?? "unknown"}) |
| \`idna2008\` | status in the IDNA mapping table: \`valid\`, \`mapped\`, \`disallowed\` and so on |
| \`registrableAt\` | TLDs whose registry accepts it at the second level, out of all ${x.reg.tlds.length} with known rules (data/input/tld-rules.json: IANA IDN tables fetched ${x.reg.fetched}, the ICANN rule for generic TLDs without tables, and researched country-code policies). Lowercase ASCII letters and digits count everywhere |

### lookalikes.jsonl.gz

Every row has \`a\`, \`b\` (code points; look them up in \`characters\`), \`method\` and \`alikeIn\`.

**\`method: "same font"\`**: the two characters compared within each font that draws both. A font counts as alike
when the shape distance is below 0.5 and the baseline-anchored distance below 0.2 (the lower of the distance with the
glyphs centred on their advance and centred on their ink).

| Field | Meaning |
|---|---|
| \`textFontsRenderingBoth\`, \`textFontsAlike\`, \`textShare\` | over text fonts, leaving out handwriting, display and symbol faces |
| \`fontsRenderingBoth\`, \`fontsAlike\`, \`share\` | over all fonts |
| \`meanDistanceWhereAlike\`, \`fontsAtZero\` | the mean shape distance where alike, and the fonts where both distances are 0 |
| \`alikeIn\`, \`distances\` | those fonts, and in each the shape and baseline-anchored distances |

**\`method: "across fonts"\`**: \`a\` in its own font (the fallback a browser would use) against the ASCII letter or
digit \`b\` in a page font that lacks \`a\`. A combination counts when \`b\` is the nearest ASCII letter or digit to \`a\`,
and \`a\` is at least as close to \`b\` as \`b\` is to itself in the upper quartile of the other page fonts, in shape and
in size, with a distance of at most 0.98. The bar depends only on the page fonts, so adding
fonts to the survey does not move it.

| Field | Meaning |
|---|---|
| \`combinations\`, \`alike\`, \`share\` | font combinations compared, alike, and the fraction |
| \`minDistance\` | the closest combination |
| \`alikeIn\` | up to six combinations, as "fallback font vs page font distance" |
| \`macosActual\` | the same test with the fallback font macOS actually uses |

### sequences.jsonl.gz

\`a\` is a code point and \`b\` a two-character ASCII sequence, as a string. Every sequence of two ASCII letters or
digits (3,844) is set as the font sets it, with its kerning and ligatures (Core Text; HarfBuzz sets them identically
apart from the system font's tracking), and compared like a character. Within one font, the same fields as
lookalikes; across fonts, a sequence is held to the stricter bar of its two letters.

### in-place.jsonl.gz

Every lookalike of an ASCII letter, digit or two-letter sequence found by the measurements above (as a candidate,
whether or not it passes the thresholds) is set between neighbouring letters (\`pa_nel\`, \`20_5\`) as Core Text draws
it, with the platform's font fallback, in five contexts: the system font at 13 px, and Helvetica, Arial, Times New
Roman and Georgia at 16 px, each at a device pixel ratio of 1 and 2. Nothing is rescaled: the lookalike is compared
where it lands in the line.

| Field | Meaning |
|---|---|
| \`a\`, \`b\` | the character (code point) and the letter, digit or sequence it was tested against |
| \`found\` | which measurement proposed it: \`same font\`, \`across fonts\`, a sequence, or \`Unicode (ASCII)\` for the ASCII pairs confusables.txt lists (1 and l, 0 and O, m and rn), checked the same way |
| \`tier\` | the best verdict in any context: \`strict\`, \`broad\`, \`design\` or \`no\` |
| \`contexts[]\` | per context: \`faces\` used, \`distance\` and the bars (\`anchor\`, \`anchorBroad\`), \`ink\` (top, bottom and width against the letter's, em), \`gaps\` to the neighbours, \`reordered\`, and \`dpr1\`, \`dpr2\`: \`verdict\`, the checks that \`failed\`, and for \`design\` the fonts whose letter it matches |

Verdicts:

- **strict**: as alike as the median of the accepted pairs (0/O, 1/l, I/l) in that context, each counted only where
  the context draws it at the same size and position; and passes every check below.
- **broad**: as alike as the least alike accepted pair, with one corner allowed to differ and no slant check.
- **design**: not strict against this font's letter, but alike to the letter as another common font draws it, scaled
  to this letter's height and baseline (a barred J in a line whose J has no bar).

Checks, on the lookalike and the letter rasterised at 4 times the device resolution: the same number of pieces and
holes once gaps narrower than a device pixel close; counters square or round alike, and in the same place and of
about the same size; the spacing to the neighbours (within 0.12 em); the ink's top, bottom (0.12 em) and width (0.2
em); the neighbours not reordered (right-to-left characters pull digits round them); stroke weight (within a ratio of
1.25); the shape of each side (mirrored or straight against curved); how far the ink reaches into each corner (0.06
em); slant; a stem in the middle (Y against V); and a bar crossing a stem (Ŧ against T). A two-letter sequence is
checked letter by letter, each letter's share of the lookalike against that letter.

## What was compared, and what an absent pair means

${n(x.fonts)} fonts: every family on macOS (including the ones in AssetsV2, such as PingFang), Roboto, Noto Sans, Noto Serif,
Noto Sans CJK and DejaVu, each in the face a browser uses for body text.

- Within one font: every pair of letters and digits (General_Category L or N) the font draws, Han and Hangul included.
- Across fonts: every letter and digit of every text font against the 62 ASCII letters and digits of each of 26 page
  fonts that lacks it.
- Sequences: every character of each font against the 3,844 two-character ASCII sequences as that font sets them,
  and across fonts against the sequences of the page fonts.
- In place: every candidate lookalike of an ASCII letter, digit or sequence from those measurements.

A pair inside these populations that is absent was compared and not found alike. Pairs of two non-ASCII characters in
different fonts were not compared.

## Suggested thresholds

For a yes or no on an ASCII lookalike, use the in-place \`tier\`: \`strict\` for reports and submissions, \`broad\` (or
\`design\`) for defences, where a missed lookalike costs more than an extra entry. For other pairs, the tests in
docs/metric-calibration.md support: within one font, alike in at least 3 text fonts (or in all of them, when fewer than
3 draw both) and at least 5% of the text fonts drawing both; across fonts, alike in at least 3 combinations and at
least 10% of them. \`src/thresholds.ts\` implements this.

Reference data: Unicode confusables.txt ${x.confusablesDate ?? ""} (for comparison only; the measurements do not use it).

## Changes

- ${x.version}: release 3. Release 2 compared only the pairs and fonts earlier runs had compared, and missed most
  letters (Yi, Canadian Aboriginal, Ethiopic, the Indic scripts and others), the script-only fonts, and the right face
  of several font collections. This release compares every letter and digit each font draws, in ${n(x.fonts)} fonts. Also:
  overlapping contours (as in variable fonts) measured as the union of their strokes; the cross-font bar set by the
  upper quartile of the page fonts; two-letter sequences as the font sets them; and the in-place check.
- 2026.09.25: \`registrableAt\` covers every TLD with known registry rules, not ten.
- 2026.09.24: release 2. Size and baseline, linear shape differences, shares over text fonts, Roboto, and comparisons
  across fonts.
`;
}

main();
