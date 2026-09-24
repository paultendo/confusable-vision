"""
build-idn-registrable.py

Which code points each TLD's registry accepts at the second level, from the IANA Repository of IDN Practices
(https://www.iana.org/domains/idn-tables). Writes data/input/idn-registrable.json: for each TLD, the code point
ranges its tables list as part of the repertoire (a code point that appears only as a variant is left out), with the
table files used. ASCII letters, digits and hyphen are registrable everywhere and are not listed.

Usage:
  python3 scripts/build-idn-registrable.py <tables-dir> <rows.json> [fetched-date]

<tables-dir> holds the table files as IANA serves them (https://www.iana.org/domains/idn-tables/tables/<file>).
<rows.json> is the repository listing as [tld, language-or-script, path, type, registry, date] rows.
"""

import json, os, re, sys
import xml.etree.ElementTree as ET

# .eu is left out: its IANA tables include Cyrillic and Greek, but EURid accepts only Latin under .eu itself
# (Cyrillic names go under .ею and Greek under .ευ).
TLDS = [".com", ".net", ".org", ".info", ".co", ".biz", ".xyz", ".app", ".dev", ".jp"]
NS = "{urn:ietf:params:xml:ns:lgr-1.0}"


def repertoire(path):
    text = open(path, encoding="utf-8", errors="replace").read()
    cps = set()
    if path.endswith(".xml"):
        root = ET.fromstring(text.encode("utf-8"))
        for ch in root.iter(NS + "char"):
            cp = ch.get("cp").split()
            if len(cp) != 1:
                continue  # sequences are not single code points
            outside = "Not part of repertoire" in (ch.get("comment") or "") or any(
                v.get("type") == "out-of-repertoire-var" and v.get("cp") == ch.get("cp") for v in ch.findall(NS + "var"))
            if not outside:
                cps.add(int(cp[0], 16))
        for m in re.finditer(r'<range[^>]*first-cp="([0-9A-Fa-f]+)"[^>]*last-cp="([0-9A-Fa-f]+)"', text):
            cps.update(range(int(m.group(1), 16), int(m.group(2), 16) + 1))
    else:
        for m in re.finditer(r"U\+([0-9A-Fa-f]{4,6})(?:\s*(?:-|\.\.)\s*U\+([0-9A-Fa-f]{4,6}))?", text):
            a = int(m.group(1), 16)
            cps.update(range(a, int(m.group(2), 16) + 1 if m.group(2) else a + 1))
        for m in re.finditer(r"^\s*([0-9A-Fa-f]{4,6})\(", text, re.M):
            cps.add(int(m.group(1), 16))
        for m in re.finditer(r"^\s*([0-9A-Fa-f]{4,6})(?:\.\.([0-9A-Fa-f]{4,6}))?\s*[;#|\s]", text, re.M):
            a = int(m.group(1), 16)
            b = int(m.group(2), 16) if m.group(2) else a
            if b - a < 100000:
                cps.update(range(a, b + 1))
    return {c for c in cps if c > 0x7F and c < 0x110000}


def ranges(cps):
    out, run = [], None
    for c in sorted(cps):
        if run and c == run[1] + 1:
            run[1] = c
        else:
            run = [c, c]
            out.append(run)
    return [f"{a:04X}" if a == b else f"{a:04X}..{b:04X}" for a, b in out]


def main():
    tables_dir, rows_path = sys.argv[1], sys.argv[2]
    fetched = sys.argv[3] if len(sys.argv) > 3 else None
    rows = json.load(open(rows_path))
    out = {
        "description": "Code points each TLD's registry accepts at the second level, from the IANA Repository of IDN "
                       "Practices. Repertoire only (variant-only code points left out); ASCII LDH is registrable "
                       "everywhere and not listed.",
        "source": "https://www.iana.org/domains/idn-tables",
        "fetched": fetched,
        "tlds": {},
    }
    for tld in TLDS:
        files, cps = [], set()
        for r in rows:
            if r[0] != tld:
                continue
            path = os.path.join(tables_dir, os.path.basename(r[2]))
            if not os.path.exists(path):
                raise SystemExit(f"missing table {path} for {tld}")
            files.append(os.path.basename(r[2]))
            cps |= repertoire(path)
        out["tlds"][tld] = {"tables": sorted(files), "ranges": ranges(cps)}
    dest = os.path.join(os.path.dirname(__file__), "..", "data", "input", "idn-registrable.json")
    with open(dest, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(dest, {t: len(v["tables"]) for t, v in out["tlds"].items()})


main()
