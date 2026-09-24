"""
build-tld-rules.py

Which characters each TLD's registry accepts at the second level, for every delegated TLD. Writes
data/input/tld-rules.json, which the release (registrableAt), the IDN view and d0ma1n's registrability check read.

Sources, in order of precedence:
  1. data/input/tld-overrides.json: hand-checked corrections, each with its source.
  2. The IANA Repository of IDN Practices (https://www.iana.org/domains/idn-tables): the latest version of every
     table a registry has lodged. A label must fit one table (registries take one language or script tag per name).
  3. data/input/cctld-idn-rules.json: country-code registries that have not lodged tables with IANA, researched from each
     registry's own policy, with its source. Country-code registries are not obliged to lodge tables.
  4. A generic TLD with no lodged tables is ASCII-only: the ICANN registry agreement (Specification 6, section 1.4)
     lets a registry offer IDNs only once its tables are in the IANA repository.
  5. A country-code TLD with a Latin (ASCII) name whose rules are still unknown is assumed ASCII-only (listed as such),
     unless its registry says it takes IDNs. IDN country codes (xn--) with unknown rules are left out: unknown.

Usage:
  python3 scripts/build-tld-rules.py <cache-dir> [--fetch]

<cache-dir> holds listing.html, rootdb.html, tlds.txt and tables/; --fetch downloads them first.
"""

import concurrent.futures, datetime, json, os, re, sys, urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
NS = "{urn:ietf:params:xml:ns:lgr-1.0}"
UA = {"User-Agent": "confusable-vision build-tld-rules (https://github.com/paultendo/confusable-vision)"}
IANA = "https://www.iana.org"


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def fetch(cache):
    os.makedirs(os.path.join(cache, "tables"), exist_ok=True)
    for name, url in [("listing.html", IANA + "/domains/idn-tables"), ("rootdb.html", IANA + "/domains/root/db"),
                      ("tlds.txt", "https://data.iana.org/TLD/tlds-alpha-by-domain.txt")]:
        open(os.path.join(cache, name), "wb").write(get(url))
    paths = sorted({r["path"] for r in latest_rows(cache)})

    def one(path):
        dest = os.path.join(cache, "tables", os.path.basename(path))
        if not os.path.exists(dest):
            open(dest, "wb").write(get(IANA + path))

    with concurrent.futures.ThreadPoolExecutor(6) as pool:
        list(pool.map(one, paths))


def listing_rows(cache):
    html = open(os.path.join(cache, "listing.html"), encoding="utf-8").read()
    rows = []
    for m in re.finditer(r'<tr data-idn-domain="([^"]+)">(.*?)</tr>', html, re.S):
        body = m.group(2)
        href = re.search(r'href="(/domains/idn-tables/tables/[^"]+)"', body)
        if not href:
            continue
        name = re.search(r"<span>(.*?)</span>", body, re.S)
        kind = re.search(r"\b(Language|Script)\s*</span>", body)
        ver = re.search(r'tag\.svg" alt="">\s*v?([^\s<]+)', body)
        date = re.search(r'cal\.svg" alt="">\s*([0-9-]+)', body)
        rows.append({"tld": m.group(1).lstrip(".").lower(), "tag": (name.group(1).strip() if name else "",
                     kind.group(1) if kind else ""), "path": href.group(1),
                     "version": ver.group(1) if ver else "", "date": date.group(1) if date else ""})
    return rows


def latest_rows(cache):
    """The newest version of each (TLD, language or script) table; older versions stay listed at IANA."""
    def key(r):
        nums = [int(x) if x.isdigit() else 0 for x in r["version"].split(".")]
        return (nums, r["date"])
    best = {}
    for r in listing_rows(cache):
        k = (r["tld"], r["tag"])
        if k not in best or key(r) > key(best[k]):
            best[k] = r
    return list(best.values())


def root_types(cache):
    html = open(os.path.join(cache, "rootdb.html"), encoding="utf-8").read()
    rows = re.findall(r'<a href="/domains/root/db/([^"]+)\.html">[^<]*</a></span></td>\s*<td>([^<]*)</td>', html)
    return {ascii_tld(t): typ.strip() for t, typ in rows}


def ascii_tld(t):
    t = t.lower().lstrip(".")
    return t if t.isascii() else "xn--" + t.encode("punycode").decode()


def repertoire(path):
    """Code points a table lists as part of its repertoire (a code point that appears only as a variant is left out)."""
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
    return {c for c in cps if 0x7F < c < 0x110000}


def parse_chars(spec):
    """'U+00E0 U+00E1..U+00E5' (or bare hex) into code points."""
    cps = set()
    for m in re.finditer(r"(?:U\+)?([0-9A-Fa-f]{4,6})(?:\s*(?:\.\.|-|–)\s*(?:U\+)?([0-9A-Fa-f]{4,6}))?", spec or ""):
        a = int(m.group(1), 16)
        cps.update(range(a, int(m.group(2), 16) + 1 if m.group(2) else a + 1))
    return {c for c in cps if c > 0x7F}


def cjk(c):
    return 0x3400 <= c <= 0x9FFF or 0xAC00 <= c <= 0xD7AF or 0xF900 <= c <= 0xFAFF or c >= 0x20000


def encode(cps):
    """Ranges as hex; CJK ideographs and Hangul syllables collapse to one 'CJK' flag to keep the bundle small."""
    han = any(cjk(c) for c in cps)
    out, run = [], None
    for c in sorted(c for c in cps if not cjk(c)):
        if run and c == run[1] + 1:
            run[1] = c
        else:
            run = [c, c]
            out.append(run)
    parts = [f"{a:X}" if a == b else f"{a:X}..{b:X}" for a, b in out]
    return " ".join((["CJK"] if han else []) + parts)


def decode(encoded):
    cps = set()
    for part in encoded.split():
        if part != "CJK":
            a, _, b = part.partition("..")
            cps.update(range(int(a, 16), int(b or a, 16) + 1))
    return cps


def main():
    cache = sys.argv[1]
    if "--fetch" in sys.argv:
        fetch(cache)
    delegated = [ascii_tld(l.strip()) for l in open(os.path.join(cache, "tlds.txt")) if l.strip() and not l.startswith("#")]
    types = root_types(cache)
    rows = latest_rows(cache)

    tables, index = [], {}

    def intern(cps):
        s = encode(cps)
        if s not in index:
            index[s] = len(tables)
            tables.append(s)
        return index[s]

    rules, sources, parse_cache = {}, {}, {}
    by_tld = {}
    for r in rows:
        by_tld.setdefault(ascii_tld(r["tld"]), []).append(r)
    for tld, trs in by_tld.items():
        ids = set()
        for r in trs:
            path = os.path.join(cache, "tables", os.path.basename(r["path"]))
            if not os.path.exists(path):
                raise SystemExit(f"missing table {path}; run with --fetch")
            if path not in parse_cache:
                parse_cache[path] = repertoire(path)
            if parse_cache[path]:
                ids.add(intern(parse_cache[path]))
        rules[tld] = sorted(ids) if ids else "ascii"

    research = json.load(open(os.path.join(ROOT, "data", "input", "cctld-idn-rules.json")))
    for e in research:
        tld = ascii_tld(e["tld"])
        if tld in rules:
            continue
        if e["confidence"] == "low":
            continue  # registrar pages only: wrongly calling a TLD ASCII-only would hide its lookalikes
        if e["idn"] in ("no", "unused"):
            rules[tld] = "ascii"
        elif e["idn"] == "yes" and e.get("chars"):
            # A list is several alternative tables (a label fits one), e.g. .mo's Portuguese and Chinese
            specs = e["chars"] if isinstance(e["chars"], list) else [e["chars"]]
            rules[tld] = sorted({intern(parse_chars(spec)) for spec in specs})
        else:
            continue  # unknown, or IDNs accepted but the exact list is not published: leave to the profile
        sources[tld] = e["source"] if isinstance(e["source"], str) else " ".join(e["source"])

    for tld in delegated:
        if tld not in rules and types.get(tld) in ("generic", "sponsored", "generic-restricted", "infrastructure"):
            rules[tld] = "ascii"

    # A country-code TLD with a Latin (ASCII) name whose rules are still unknown is assumed ASCII-only: most such
    # registries are. IDN country codes (xn--) exist for non-ASCII names, so those stay unknown.
    # Registries that say they take IDNs but publish no list are not assumed ASCII: that would hide their lookalikes.
    says_idn = {ascii_tld(e["tld"]) for e in research if e["idn"] == "yes"}
    assumed = sorted(t for t in delegated if t not in rules and not t.startswith("xn--") and t not in says_idn)
    for tld in assumed:
        rules[tld] = "ascii"

    for o in json.load(open(os.path.join(ROOT, "data", "input", "tld-overrides.json"))):
        tld = ascii_tld(o["tld"])
        if "chars" in o:
            rules[tld] = [intern(parse_chars(o["chars"]))] if o["chars"] else "ascii"
        elif "keep_tables_with" in o:
            keep = parse_chars(o["keep_tables_with"])
            rules[tld] = [i for i in rules[tld] if keep & decode(tables[i])]
        sources[tld] = o["source"]

    rules = {t: rules[t] for t in sorted(rules) if t in delegated}
    fetched = datetime.date.fromtimestamp(os.path.getmtime(os.path.join(cache, "listing.html"))).isoformat()
    out = {
        "description": "Which characters each TLD's registry accepts at the second level. tables: each distinct "
                       "repertoire as hex code point ranges beyond ASCII ('CJK' stands for the ideographs and Hangul "
                       "syllables a table lists). rules: a TLD (ASCII form) to the tables a label must fit one of, or "
                       "'ascii'. A delegated TLD missing from rules is unknown. ASCII letters, digits and hyphen are "
                       "registrable everywhere.",
        "sources": ["https://www.iana.org/domains/idn-tables", "https://www.iana.org/domains/root/db",
                    "data/input/cctld-idn-rules.json", "data/input/tld-overrides.json"],
        "fetched": fetched,
        "tables": tables,
        "rules": rules,
        "assumedAscii": [t for t in assumed if rules.get(t) == "ascii"],
        "ruleSources": sources,
    }
    dest = os.path.join(ROOT, "data", "input", "tld-rules.json")
    with open(dest, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    counts = {"tables": sum(1 for v in rules.values() if v != "ascii"), "ascii": sum(1 for v in rules.values() if v == "ascii")}
    print(dest, f"{len(tables)} distinct tables;", counts, f"assumed ASCII: {len(out['assumedAscii'])};",
          f"unknown: {len([t for t in delegated if t not in rules])}", f"{os.path.getsize(dest) // 1024} KB")

main()
