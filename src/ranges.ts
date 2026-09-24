import fs from "node:fs";

/**
 * A Unicode data file of "XXXX..YYYY ; value" lines as a lookup by binary search. Scanning every range for each code
 * point (Scripts.txt has about 2,200) was the slow part of scoring hundreds of thousands of pairs.
 */
export function rangeLookup(filePath: string): (cp: number) => string | undefined {
  const ranges: [number, number, string][] = [];
  for (const raw of fs.readFileSync(filePath, "utf8").split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const [range, value] = line.split(";").map((s) => s.trim());
    const [a, b] = range!.split("..");
    ranges.push([parseInt(a!, 16), parseInt(b ?? a!, 16), value!.split(/\s+/).join(" ")]);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  return (cp) => {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid]!;
      if (cp < r[0]) hi = mid - 1;
      else if (cp > r[1]) lo = mid + 1;
      else return r[2];
    }
    return undefined;
  };
}
