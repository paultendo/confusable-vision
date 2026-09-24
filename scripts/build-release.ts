/**
 * build-release.ts
 *
 * The confusable-vision dataset as a versioned release, in a stable shape, so downstream tools pin a version and apply
 * their own rule instead of adapting to each output file. Release 2 measurements only: the March 2026 distances were
 * blind to size and under-counted shape differences (docs/metric-calibration.md), so they are superseded, not shipped.
 *
 *   characters.jsonl.gz  every code point measured, with its Unicode, TR39, IDNA2008 and registry properties
 *   lookalikes.jsonl.gz  every pair found alike, within one font (rescore-pairs.ts) or across fonts
 *                        (score-cross-font.ts), with the counts behind it
 *   DATASET.md           the fields, the populations compared, what an absent pair means, and the thresholds
 *   SHA256SUMS
 *
 * Named selections (such as the IDN-relevant set) are views over these files; see scripts/export-idn-pairs.ts.
 *
 * Usage:
 *   npx tsx scripts/build-release.ts <YYYY.MM.DD>
 *
 * Output: data/release/<version>/
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { domainToUnicode } from "node:url";
import { gzipSync } from "node:zlib";
import { rangeLookup } from "../src/ranges.js";

const ROOT = join(import.meta.dirname, "..");
const version = process.argv[2];
if (!version || !/^\d{4}\.\d{2}\.\d{2}$/.test(version)) {
  console.error("usage: npx tsx scripts/build-release.ts <YYYY.MM.DD>");
  process.exit(2);
}
const outDir = join(ROOT, "data/release", version);
const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
const jsonl = (file: string) =>
  readFileSync(join(ROOT, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

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
  return {
    at: (cp: number) => rules.filter(([, r]) => ascii(cp) ||
      (r !== "ascii" && r.some((i) => (cjk(cp) ? cjkTables.has(i) : tables[i]!.has(cp))))).map(([t]) => tld(t)),
    tlds: rules.map(([t]) => tld(t)), fetched: data.fetched as string,
  };
}

function main() {
  const idType = rangeProperty("data/input/IdentifierType.txt");
  const idna = rangeProperty("data/input/IdnaMappingTable.txt");
  const scripts = rangeProperty("data/input/Scripts.txt");
  const reg = registrable();
  const unicodeData = new Map<number, { name: string; gc: string }>();
  for (const line of readFileSync(join(ROOT, "data/input/UnicodeData.txt"), "utf8").split("\n")) {
    const f = line.split(";");
    if (f.length > 2) unicodeData.set(parseInt(f[0]!, 16), { name: f[1]!, gc: f[2]! });
  }

  // Lookalikes: within one font, then across fonts
  const lookalikes: Record<string, any>[] = [];
  for (const m of jsonl("data/output/rescored-pairs.jsonl")) {
    lookalikes.push({
      a: m.a, b: m.b, method: "same font",
      textFontsRenderingBoth: m.textFontsRenderingBoth, textFontsAlike: m.textFontsAlike, textShare: m.textShare,
      fontsRenderingBoth: m.fontsRenderingBoth, fontsAlike: m.fontsAlike, share: m.share,
      meanDistanceWhereAlike: m.meanDistanceWhereAlike, fontsAtZero: m.fontsAtZero,
      alikeIn: Object.keys(m.alikeFonts),
    });
  }
  for (const c of jsonl("data/output/cross-font-pairs.jsonl")) {
    if (c.alike === 0) continue;
    lookalikes.push({ a: c.x, b: c.t, method: "across fonts", combinations: c.combos, alike: c.alike, share: c.share,
      alikeIn: c.alikeIn });
  }
  lookalikes.sort((p, q) => (p.a + p.b + p.method).localeCompare(q.a + q.b + q.method));

  // Characters: every code point in a lookalike, plus the twelve March script sets (measured, whether or not alike)
  const cps = new Set<number>();
  const sets = JSON.parse(readFileSync(join(ROOT, "data/output/cross-script-sets.json"), "utf8"));
  for (const set of Object.values(sets.scripts) as any[]) for (const c of set.characters) cps.add(parseInt(c.codepoint.slice(2), 16));
  for (const l of lookalikes) { cps.add(parseInt(l.a.slice(2), 16)); cps.add(parseInt(l.b.slice(2), 16)); }
  const charRows = [...cps].sort((a, b) => a - b).map((cp) => JSON.stringify({
    codepoint: hex(cp), char: String.fromCodePoint(cp), name: unicodeData.get(cp)?.name ?? "",
    script: scripts.get(cp) ?? "Unknown", generalCategory: unicodeData.get(cp)?.gc ?? "",
    identifierType: idType.get(cp) ?? "Not_Character", idna2008: idna.get(cp)?.split(" ")[0] ?? "unknown",
    registrableAt: reg.at(cp),
  }));
  const lookRows = lookalikes.map((l) => JSON.stringify(l));

  mkdirSync(outDir, { recursive: true });
  const files: Record<string, Buffer> = {
    "characters.jsonl.gz": gzipSync(charRows.join("\n") + "\n", { level: 9 }),
    "lookalikes.jsonl.gz": gzipSync(lookRows.join("\n") + "\n", { level: 9 }),
  };
  const sameFont = lookalikes.filter((l) => l.method === "same font").length;
  files["DATASET.md"] = Buffer.from(card({ version, characters: charRows.length, sameFont,
    acrossFonts: lookalikes.length - sameFont, reg, idTypeDate: idType.date }));
  const sums: string[] = [];
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(outDir, name), body);
    sums.push(`${createHash("sha256").update(body).digest("hex")}  ${name}`);
  }
  writeFileSync(join(outDir, "SHA256SUMS"), sums.join("\n") + "\n");
  console.log(`${outDir}: ${charRows.length} characters, ${sameFont} same-font and ${lookalikes.length - sameFont} cross-font lookalikes`);
}

function card(x: { version: string; characters: number; sameFont: number; acrossFonts: number;
  reg: { tlds: string[]; fetched: string }; idTypeDate?: string }): string {
  const n = (v: number) => v.toLocaleString("en-GB");
  return `# confusable-vision lookalikes, release ${x.version}

Which Unicode characters look alike, measured by RaySpace: rays cast through each glyph's outline (36 angles, 50 rays
each, 128px grid) and compared twice, once for shape and once anchored to the baseline, so the size and position each
glyph has in running text count. Method and
the tests behind it: docs/metric-calibration.md in the repository.

Licence: CC-BY-4.0. Attribution: confusable-vision, Paul Wood FRSA (@paultendo).

This release replaces the March 2026 measurements, which were blind to size and under-counted shape differences.

## Files

| File | Rows | One row per |
|---|---|---|
| \`characters.jsonl.gz\` | ${n(x.characters)} | code point measured |
| \`lookalikes.jsonl.gz\` | ${n(x.sameFont + x.acrossFonts)} | pair found alike: ${n(x.sameFont)} within one font, ${n(x.acrossFonts)} across fonts |

\`SHA256SUMS\` covers all three. Pin the release by its version.

### characters.jsonl.gz

| Field | Meaning |
|---|---|
| \`codepoint\`, \`char\`, \`name\`, \`script\`, \`generalCategory\` | the character, from the Unicode Character Database |
| \`identifierType\` | TR39 Identifier_Type (IdentifierType.txt dated ${x.idTypeDate ?? "unknown"}) |
| \`idna2008\` | status in the IDNA mapping table: \`valid\`, \`mapped\`, \`disallowed\` and so on |
| \`registrableAt\` | TLDs whose registry accepts it at the second level, out of all ${x.reg.tlds.length} with known rules (data/input/tld-rules.json: IANA IDN tables fetched ${x.reg.fetched}, the ICANN rule for generic TLDs without tables, and researched country-code policies). Lowercase ASCII letters and digits count everywhere |

### lookalikes.jsonl.gz

Every row has \`a\`, \`b\` (code points; look them up in \`characters\`), \`method\` and \`alikeIn\`.

**\`method: "same font"\`**: the two characters compared within each font that renders both. A font counts as alike
when the shape distance (rays across each glyph's own box) is below 0.5 and the baseline-anchored distance (rays
across a fixed em frame, both glyphs at one scale on one baseline) is below 0.2.

| Field | Meaning |
|---|---|
| \`textFontsRenderingBoth\`, \`textFontsAlike\`, \`textShare\` | over text fonts, leaving out handwriting, display and symbol faces |
| \`fontsRenderingBoth\`, \`fontsAlike\`, \`share\` | over all fonts |
| \`meanDistanceWhereAlike\`, \`fontsAtZero\` | the distances in the fonts where it is alike |
| \`alikeIn\` | those fonts |

**\`method: "across fonts"\`**: \`a\` drawn in its own fonts (the fallback a browser would use) against the ASCII
letter or digit \`b\` in a reference text font (Roboto and 20 common faces). A combination counts when \`a\` is at least as
close to \`b\` as \`b\` usually is to itself in another reference font, in shape and in size, \`b\` is the nearest ASCII
letter or digit to it, and the distance is at most 0.98.

| Field | Meaning |
|---|---|
| \`combinations\`, \`alike\`, \`share\` | font combinations compared, alike, and the fraction |
| \`alikeIn\` | up to six of them, as "fallback font vs reference font" |

## What was compared, and what an absent pair means

Fonts: every macOS system font and Roboto (the Android build). Within one font:

- every pair of characters from different scripts among the twelve March script sets (Latin A-Z, a-z, 0-9; Cyrillic;
  Greek; Arabic; Han; Hangul jamo; Katakana; Hiragana; Devanagari; Thai; Georgian; Armenian);
- every letter, mark or number that at least one TLD's registry accepts (data/input/tld-rules.json; except Han, Hangul and kana)
  against the 62 ASCII letters and digits, and those against one another;
- every Roboto letter or digit against every other from a different script, and against the ASCII letters and digits.

Across fonts: every character none of the reference fonts renders, from that registrable set, against the 62 ASCII
letters and digits.

A pair inside these populations that is absent was compared and not found alike. Anything outside them, such as two
non-ASCII characters compared across fonts or same-script pairs within the twelve sets, was not compared.

## Suggested thresholds

The tests in docs/metric-calibration.md support: within one font, alike in at least 3 text fonts (or in all of them,
when fewer than 3 render both) and at least 5% of the text fonts rendering both; across fonts, alike in at least 3
combinations and at least 10% of them. \`src/thresholds.ts\` implements this.

## Views

- **IDN-relevant** (\`scripts/export-idn-pairs.ts\`): lookalikes at those thresholds whose characters can both be
  registered at a common TLD, with where.

## Changes

- 2026.09.25: \`registrableAt\` covers every TLD with known registry rules (data/input/tld-rules.json), not ten. The
  105 letters, marks and numbers only other TLDs accept were compared against the 62 ASCII letters and digits, within
  one font and across fonts; none is alike, so the lookalikes are unchanged.
- 2026.09.24: first release. Release 2 scoring: size and baseline, linear shape differences, shares over text fonts,
  Roboto, and comparisons across fonts.
`;
}

main();
