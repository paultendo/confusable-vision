/**
 * coretext.ts
 *
 * Faces fontkit cannot read, opened through Core Text (scripts/ct-outlines.swift, compiled to data/output/bin). Apple's
 * interface cuts of PingFang store their glyphs in the hvgl table, which fontkit does not parse, and hidden UI faces
 * cannot be opened by name at all (Core Text substitutes Times), so they are opened the way macOS reaches them: as
 * the face Core Text falls back to for a sample character from the UI font, Helvetica or Times.
 *
 * ctFace() returns an object with the parts of fontkit's font interface the pipeline uses (characterSet, unitsPerEm,
 * ascent, descent, glyphForCodePoint with path commands and advance), so extractGlyphPath and the audit need no
 * changes. Checked against fontkit on ordinary fonts: Arial (2,213 glyphs) and Hiragino Sans (4,000) give identical
 * segments; composite glyphs in Helvetica Neue come back with contours in another order, and their signatures match
 * fontkit's exactly for 323 of 333 and within 0.0071 for the rest.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "scripts/ct-outlines.swift");
const BINARY = path.join(ROOT, "data/output/bin/ct-outlines");

export interface CoreTextRoute { role: "ui" | "sans" | "serif"; sample: string }

function binary(): string {
  if (!fs.existsSync(BINARY) || fs.statSync(BINARY).mtimeMs < fs.statSync(SOURCE).mtimeMs) {
    fs.mkdirSync(path.dirname(BINARY), { recursive: true });
    execFileSync("swiftc", ["-O", SOURCE, "-o", BINARY], { stdio: "inherit" });
  }
  return BINARY;
}

const COMMANDS: Record<string, [string, number]> = { M: ["moveTo", 2], L: ["lineTo", 2], Q: ["quadraticCurveTo", 4], C: ["bezierCurveTo", 6], Z: ["closePath", 0] };

/** Core Text's path text ("M x y L x y ... Z") as fontkit-style commands. */
export function parseCommands(text: string): { command: string; args: number[] }[] {
  const t = text.split(" ").filter(Boolean);
  const out: { command: string; args: number[] }[] = [];
  for (let i = 0; i < t.length;) {
    const [command, n] = COMMANDS[t[i++]!]!;
    out.push({ command, args: t.slice(i, i + n).map(Number) });
    i += n;
  }
  return out;
}

const faces = new Map<string, any>();

/** A Core Text face, reached by falling back from the role's font for the sample code point, as a fontkit-like font. */
export function ctFace(route: CoreTextRoute): any {
  const key = `${route.role}|${route.sample}`;
  if (faces.has(key)) return faces.get(key);
  const via = ["--via", route.role, route.sample];
  const info = execFileSync(binary(), [...via, "--info"], { maxBuffer: 1 << 26 }).toString().trim().split("\n");
  const [, postscriptName, upm, ascent, descent] = info[0]!.split("\t");
  const characterSet = info[1]!.split(" ").filter(Boolean).map((h) => parseInt(h, 16));
  let glyphs: Map<number, { id: number; advanceWidth: number; path: { commands: any[]; toSVG: () => string } }> | undefined;
  const load = () => {
    glyphs = new Map();
    const out = execFileSync(binary(), via, { input: characterSet.map((c) => c.toString(16)).join("\n") + "\n", maxBuffer: 1 << 30 })
      .toString().trim().split("\n").slice(1);
    const ids = new Map<string, number>();
    for (const line of out) {
      const [h, adv, cmds = ""] = line.split("\t");
      // Identical outlines share an id, as a font's shared glyphs would
      const id = ids.get(cmds) ?? ids.set(cmds, ids.size + 1).get(cmds)!;
      glyphs.set(parseInt(h!, 16), { id, advanceWidth: Number(adv), path: { commands: parseCommands(cmds), toSVG: () => cmds } });
    }
  };
  const font = {
    postscriptName, coreText: route, characterSet,
    unitsPerEm: Number(upm), ascent: Number(ascent), descent: -Number(descent),
    glyphForCodePoint(cp: number) {
      if (!glyphs) load();
      return glyphs!.get(cp) ?? { id: 0, advanceWidth: 0, path: { commands: [], toSVG: () => "" } };
    },
    get _glyphs() { return glyphs; },
    set _glyphs(_: any) { /* the pipeline clears fontkit's cache; this one is needed again */ },
  };
  faces.set(key, font);
  return font;
}
