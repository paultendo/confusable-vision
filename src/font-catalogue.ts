/**
 * font-catalogue.ts
 *
 * Which fonts are measured, and which face of each. Earlier runs took the fonts from the signature bank (those that
 * draw the letter a, which left out every script-only font) and loaded face 0 of a collection, which for several
 * families is not the regular weight: STSong was measured as Songti SC Black, Hiragino Sans as W6, Avenir Next and
 * PT Mono as Bold, Heiti SC as Heiti TC Medium, STIXGeneral as Bold Italic.
 *
 * Here every font file in the platform's font folders (and data/fonts/, and fonts added through side banks) is read,
 * faces are grouped by typographic family name (name ID 16, else 1), and each family's face is the one a browser draws
 * body text in, by CSS font matching for font-weight 400, font-style normal, font-stretch normal: upright faces first,
 * then the width nearest normal, then weight 400 if present, else 500, else the nearest lighter, else the nearest
 * heavier. For fonts macOS has installed, the weights and widths are Core Text's (scripts/resolve-faces.swift), which
 * is what a browser on a Mac matches against: Core Text calls Heiti SC Light the regular weight where the font's OS/2
 * table says Medium. Fonts macOS does not know (data/fonts/, side banks) are chosen by their OS/2 table. Families whose
 * names start with "." are system-internal and left out, except the system UI font and its script companions (.SF NS
 * as "System Font", .SF Arabic, .SF Hebrew, .SF Georgian, .SF Armenian as "System Font Arabic" and so on): Core Text's
 * UI cascade draws those scripts in them, in menus, dialogs and Safari's address bar.
 *
 * The catalogue is written to data/output/font-catalogue.json with the macOS version, so a run records which files it
 * measured.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as fontkit from "fontkit";
import { sideBankFonts } from "./bank-load.js";
import { ctFace, type CoreTextRoute } from "./coretext.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CATALOGUE = path.join(ROOT, "data/output/font-catalogue.json");

export interface Face {
  chosenBy?: "Core Text" | "OS/2" | "macOS fallback";
  /** Faces fontkit cannot read (hvgl glyphs, hidden UI cuts), opened through Core Text's fallback: src/coretext.ts */
  coreText?: CoreTextRoute;
  /** For faces macOS falls back to: which of ui, sans, serif (scripts/platform-fallback.swift) and how many code points */
  fallbackFor?: Record<string, number>;
  family: string;
  file: string;
  postscriptName: string;
  weight: number;
  width: number;
  italic: boolean;
  /** fontkit can read this face's outlines (glyf, CFF or CFF2) */
  outlines?: boolean;
}

/** Hidden macOS UI families measured, under public names. */
const UI_FACES: Record<string, string> = {
  ".SF NS": "System Font", ".SF Arabic": "System Font Arabic", ".SF Hebrew": "System Font Hebrew",
  ".SF Georgian": "System Font Georgian", ".SF Armenian": "System Font Armenian",
};

const DIRS = ["/System/Library/Fonts", "/Library/Fonts", path.join(ROOT, "data/fonts")];
const ASSETS = "/System/Library/AssetsV2";
/** Files that map (nearly) all of Unicode to placeholder glyphs. */
const SKIP_FILES = /LastResort/i;

function fontFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ttf|otf|ttc)$/i.test(e.name) && !SKIP_FILES.test(e.name)) out.push(p);
    }
  };
  for (const d of DIRS) walk(d);
  // Apple's downloaded fonts (PingFang, and whatever else this Mac has fetched)
  if (fs.existsSync(ASSETS)) for (const d of fs.readdirSync(ASSETS)) if (/Font/.test(d)) walk(path.join(ASSETS, d));
  return out;
}

function facesOf(file: string, includeHidden = false): Face[] {
  let f: any;
  try { f = fontkit.openSync(file); } catch { return []; }
  const faces = f.fonts ?? [f];
  return faces.flatMap((face: any) => {
    try {
      const os2 = face["OS/2"];
      let family: string = face.getName?.("preferredFamily") || face.familyName;
      if (!family) return [];
      if (family.startsWith(".")) {
        // The system UI font and its script companions (what menus, dialogs and Safari's address bar draw in) are
        // kept; other hidden families are interface duplicates of public ones
        if (family in UI_FACES) family = UI_FACES[family]!;
        else if (!includeHidden) return [];
      }
      const italic = !!(os2 && os2.fsSelection && (os2.fsSelection.italic || os2.fsSelection.oblique)) ||
        /italic|oblique/i.test(face.subfamilyName ?? "") || (face.italicAngle ?? 0) !== 0;
      const tables = face.directory?.tables ?? {};
      const outlines = !!(tables.glyf || tables["CFF "] || tables.CFF2);
      return [{ family, file, postscriptName: face.postscriptName, weight: os2?.usWeightClass ?? 400, width: os2?.usWidthClass ?? 5, italic, outlines }];
    } catch { return []; }
  });
}

/** CSS font matching for weight 400, normal style and stretch. */
function pick(faces: Face[]): Face {
  const upright = faces.some((f) => !f.italic) ? faces.filter((f) => !f.italic) : faces;
  const bestWidth = Math.min(...upright.map((f) => Math.abs(f.width - 5)));
  const normal = upright.filter((f) => Math.abs(f.width - 5) === bestWidth);
  const rank = (w: number): [number, number] =>
    w === 400 ? [0, 0] : w === 500 ? [1, 0] : w < 400 ? [2, 400 - w] : [3, w - 400];
  return normal.sort((a, b) => {
    const [ra, da] = rank(a.weight), [rb, db] = rank(b.weight);
    return ra - rb || da - db || a.postscriptName.localeCompare(b.postscriptName);
  })[0]!;
}

/**
 * Families not measured, with the reason. Symbol and dingbat fonts map letters to pictures; bitmap and emoji fonts have
 * no outlines; the STIX size variants hold only large operators. The near-duplicates repeat another measured family's
 * glyphs (a regional or JIS-edition twin, or a monospaced copy), so counting both would count one design twice
 * towards "alike in at least 3 text fonts".
 */
export const EXCLUDED_FONTS: Record<string, string> = {
  ...Object.fromEntries(["Symbol", "Webdings", "Wingdings", "Wingdings 2", "Wingdings 3", "Zapf Dingbats", "Bodoni Ornaments",
    "Apple Symbols"].map((f) => [f, "symbol font"])),
  ...Object.fromEntries(["Apple Color Emoji", "GB18030 Bitmap"].map((f) => [f, "no outlines"])),
  ...Object.fromEntries(["STIXSizeOneSym", "STIXSizeTwoSym", "STIXSizeThreeSym", "STIXSizeFourSym", "STIXSizeFiveSym",
    "STIXVariants", "STIXNonUnicode", "STIXIntegralsD", "STIXIntegralsSm", "STIXIntegralsUp", "STIXIntegralsUpD",
    "STIXIntegralsUpSm"].map((f) => [f, "STIX size or variant font"])),
  ...Object.fromEntries(["Noto Sans Mono CJK HK", "Noto Sans Mono CJK JP", "Noto Sans Mono CJK KR", "Noto Sans Mono CJK SC",
    "Noto Sans Mono CJK TC"].map((f) => [f, "monospaced copy of Noto Sans CJK"])),
  "PingFang MO": "same glyphs as PingFang HK",
  "Hiragino Kaku Gothic Pro": "JIS edition twin of Hiragino Kaku Gothic ProN",
  "Hiragino Kaku Gothic StdN": "JIS edition twin of Hiragino Kaku Gothic Std",
  "Hiragino Maru Gothic ProN": "JIS edition twin of Hiragino Maru Gothic Pro",
  "Hiragino Mincho ProN": "JIS edition twin of Hiragino Mincho Pro",
};

/** The families a run measures: every catalogued family that draws a letter or digit, less EXCLUDED_FONTS. */
export function measuredFamilies(): string[] {
  return [...fontCatalogue().keys()].filter((f) => !(f in EXCLUDED_FONTS)).filter((f) => {
    const font = loadFace(f);
    if (!font) return false;
    try { return [...font.characterSet].some((c: number) => /[\p{L}\p{N}]/u.test(String.fromCodePoint(c))); } catch { return false; }
  });
}

let catalogue: Map<string, Face> | undefined;

/** Every family and its regular face; built once and cached in data/output/font-catalogue.json. */
export function fontCatalogue(rebuild = false): Map<string, Face> {
  if (catalogue && !rebuild) return catalogue;
  if (!rebuild && fs.existsSync(CATALOGUE)) {
    catalogue = new Map(Object.entries(JSON.parse(fs.readFileSync(CATALOGUE, "utf8")).families as Record<string, Face>));
    return catalogue;
  }
  const byFamily = new Map<string, Face[]>();
  for (const file of fontFiles()) for (const face of facesOf(file)) {
    (byFamily.get(face.family) ?? byFamily.set(face.family, []).get(face.family)!).push(face);
  }
  // Fonts added through side banks (Roboto) are measured from the file that was added
  for (const [family, file] of sideBankFonts()) {
    const faces = facesOf(file).map((f) => ({ ...f, family }));
    if (faces.length) byFamily.set(family, faces);
  }
  // Core Text's choice for installed families, where it names a face in a file this catalogue read
  const scanned = new Set([...byFamily.values()].flat().map((f) => `${f.file}|${f.postscriptName}`));
  const sideBank = new Set(sideBankFonts().keys());
  const coreText = new Map<string, { ps: string; file: string }>();
  try {
    const out = execFileSync("swift", [path.join(ROOT, "scripts/resolve-faces.swift")],
      { input: [...byFamily.keys()].filter((f) => !f.startsWith("System Font") && !sideBank.has(f)).join("\n") + "\n", maxBuffer: 1 << 24 }).toString();
    for (const line of out.trim().split("\n")) {
      const [family, , ps, , file] = line.split("\t");
      if (ps && ps !== "-" && scanned.has(`${file}|${ps}`)) coreText.set(family!, { ps, file: file! });
    }
  } catch { /* not macOS, or no Swift: OS/2 for everything */ }
  catalogue = new Map([...byFamily].sort(([a], [b]) => a.localeCompare(b)).map(([fam, faces]) => {
    const ct = coreText.get(fam);
    const chosen = ct ? faces.find((f) => f.postscriptName === ct.ps && f.file === ct.file) : undefined;
    return [fam, { ...(chosen ?? pick(faces)), chosenBy: chosen ? "Core Text" : "OS/2" } as Face];
  }));
  // The faces macOS actually draws each character in when the requested font lacks it (data/output/
  // platform-fallback-macos.tsv), for the UI font and for Helvetica and Times pages. Where one is already a family's
  // chosen face it is marked; otherwise it is added under its PostScript name: many are hidden interface cuts
  // (.PingFangUITextSC draws Han in the UI, .AppleSDGothicNeoI Hangul). Faces from outside the system folders (fonts
  // this machine's user installed) and LastResort (no font has the character) are not a stock Mac's and are skipped.
  const fallback = path.join(ROOT, "data/output/platform-fallback-macos.tsv");
  if (fs.existsSync(fallback)) {
    const uses = new Map<string, Record<string, number>>();
    const sample = new Map<string, CoreTextRoute>();
    for (const line of fs.readFileSync(fallback, "utf8").trim().split("\n")) {
      const cols = line.split("\t");
      (["ui", "sans", "serif"] as const).forEach((role, i) => {
        const [ps, file] = [cols[1 + 2 * i]!, cols[2 + 2 * i]!];
        if (ps === "-" || !file.startsWith("/System/") || /LastResort/.test(file)) return;
        const k = `${file}|${ps}`, u = uses.get(k) ?? {};
        u[role] = (u[role] ?? 0) + 1;
        uses.set(k, u);
        if (!sample.has(k)) sample.set(k, { role, sample: cols[0]! });
      });
    }
    const byFace = new Map([...catalogue].map(([fam, f]) => [`${f.file}|${f.postscriptName}`, fam]));
    for (const [k, roles] of uses) {
      const [file, ps] = [k.slice(0, k.lastIndexOf("|")), k.slice(k.lastIndexOf("|") + 1)];
      const fam = byFace.get(k);
      if (fam) { catalogue.get(fam)!.fallbackFor = roles; continue; }
      const name = `${ps.replace(/^\./, "")} (macOS fallback)`;
      const face = facesOf(file, true).find((f) => f.postscriptName === ps && f.outlines);
      // fontkit when it reads this exact face; otherwise Core Text, reached the way macOS reaches it
      catalogue.set(name, face ? { ...face, family: name, chosenBy: "macOS fallback", fallbackFor: roles }
        : { family: name, file, postscriptName: ps, weight: 400, width: 5, italic: false, chosenBy: "macOS fallback", fallbackFor: roles, coreText: sample.get(k)! });
    }
    catalogue = new Map([...catalogue].sort(([a], [b]) => a.localeCompare(b)));
  }
  let macos = "";
  try { macos = execFileSync("sw_vers", ["-productVersion"]).toString().trim(); } catch { /* not macOS */ }
  fs.writeFileSync(CATALOGUE, JSON.stringify({ built: new Date().toISOString(), platform: `${os.platform()} ${macos}`,
    families: Object.fromEntries(catalogue) }, null, 1));
  return catalogue;
}

const loaded = new Map<string, any>();
export const TEXT_OPSZ = 16;

/** The family's regular face, opened with fontkit (the named face of a collection). */
export function loadFace(family: string): any | null {
  if (loaded.has(family)) return loaded.get(family);
  const face = fontCatalogue().get(family);
  let font: any = null;
  if (face?.coreText) {
    try { font = ctFace(face.coreText); } catch { font = null; }
  } else if (face) {
    try {
      font = fontkit.openSync(face.file) as any;
      if (font?.fonts) font = font.fonts.find((f: any) => f.postscriptName === face.postscriptName) ?? null;
      // Variable fonts with an optical-size axis (the San Francisco faces, default opsz 28, the Display cut) are
      // instanced at text size: CSS font-optical-sizing sets opsz to the size in px, 16 for body text, clamped to the
      // axis (17 for San Francisco, its Text cut)
      const opsz = font?.variationAxes?.opsz;
      if (opsz) font = font.getVariation({ opsz: Math.min(opsz.max, Math.max(opsz.min, TEXT_OPSZ)) });
    } catch { font = null; }
  }
  loaded.set(family, font);
  return font;
}
