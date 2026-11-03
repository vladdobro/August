"""Comment Scanner CLI: reports inline comments as token sinks. Read-only."""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comment_lexer import language_for, scan_comments  # noqa: E402
from file_walker import MODE, iter_files, read_text  # noqa: E402

TYPES = ("single-line", "multi-line", "doc", "marker")
MARKERS = ("TODO", "FIXME", "HACK", "XXX")


def own_excludes(root: str) -> list:
    skill_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        rel = os.path.relpath(skill_dir, os.path.abspath(root)).replace(os.sep, "/")
    except ValueError:
        return []
    if rel.startswith("..") or rel == ".":
        return []
    return [rel, rel + "/*"]


def preview(text: str) -> str:
    t = re.sub(r"\s+", " ", text).strip()
    return t[:80] + "…" if len(t) > 80 else t


def collect(root: str, args) -> list:
    files = iter_files(root, not args.no_gitignore, list(args.exclude) + own_excludes(root))
    result = []
    for rel in files:
        lang = language_for(rel)
        if not lang:
            continue
        text = read_text(root, rel)
        if text is None:
            continue
        found = scan_comments(text, lang, rel)
        if args.markers_only:
            found = [c for c in found if c.kind == "marker"]
        elif args.type:
            found = [c for c in found if c.kind in args.type]
        result.append((rel, lang, found))
    return result


def file_stats(rel, lang, comments) -> dict:
    counts = {t: 0 for t in TYPES}
    lines = chars = 0
    items = []
    for c in comments:
        counts[c.kind] += 1
        n = c.end_line - c.start_line + 1
        lines += n
        chars += len(c.text)
        items.append({"start_line": c.start_line, "end_line": c.end_line, "type": c.kind,
                      "style": c.style, "marker": c.marker, "keep": c.keep,
                      "preview": preview(c.text), "chars": len(c.text)})
    return {"path": rel, "language": lang,
            "nextjs_config": bool(re.match(r"next\.config\.", rel.rsplit("/", 1)[-1])),
            "counts": counts, "total": len(comments), "lines": lines, "chars": chars,
            "est_tokens": math.ceil(chars / 4), "comments": items}


def totals(stats) -> dict:
    by_type = {t: sum(f["counts"][t] for f in stats) for t in TYPES}
    by_marker = {m: 0 for m in MARKERS}
    keep = {"directive": 0, "license": 0}
    for f in stats:
        for c in f["comments"]:
            if c["marker"]:
                by_marker[c["marker"]] += 1
            if c["keep"]:
                keep[c["keep"]] += 1
    chars = sum(f["chars"] for f in stats)
    return {"comments": sum(f["total"] for f in stats), "lines": sum(f["lines"] for f in stats),
            "chars": chars, "est_tokens": math.ceil(chars / 4), "by_type": by_type,
            "by_marker": by_marker, "keep": keep}


def esc(s: str) -> str:
    return s.replace("|", "\\|")


def render_markdown(root, scanned, stats, tot, max_items) -> str:
    with_c = [f for f in stats if f["total"]]
    o = ["# Comment Scanner report",
         "Root: %s · Files scanned: %d · Files with comments: %d · gitignore: %s"
         % (root, scanned, len(with_c), MODE["value"]), "", "## Project totals", "",
         "| Metric | Value |", "|---|---|",
         "| Total comments | %d |" % tot["comments"], "| Comment lines | %d |" % tot["lines"],
         "| Comment chars | %d |" % tot["chars"], "| Est. tokens (chars/4) | %d |" % tot["est_tokens"]]
    for t in TYPES:
        o.append("| %s | %d |" % (t, tot["by_type"][t]))
    o.append("| keep (directive/license) | %d/%d |" % (tot["keep"]["directive"], tot["keep"]["license"]))
    if any(tot["by_marker"].values()):
        o += ["", "## Markers", "", "| Marker | Count |", "|---|---|"]
        o += ["| %s | %d |" % (m, n) for m, n in tot["by_marker"].items()]
    o += ["", "## Per file", "", "| File | Comments | Single | Multi | Doc | Marker | Lines | Est. tokens |",
          "|---|---|---|---|---|---|---|---|"]
    for f in sorted(with_c, key=lambda x: (-x["est_tokens"], x["path"])):
        c = f["counts"]
        name = esc(f["path"]) + (" (Next.js config)" if f["nextjs_config"] else "")
        o.append("| %s | %d | %d | %d | %d | %d | %d | %d |" % (
            name, f["total"], c["single-line"], c["multi-line"], c["doc"], c["marker"],
            f["lines"], f["est_tokens"]))
    rows = [(f["path"], c) for f in with_c for c in f["comments"]]
    total = len(rows)
    shown = rows if max_items == 0 else rows[:max_items]
    o += ["", "## Comments (first %d of %d)" % (len(shown), total), "",
          "| File | Lines | Type | Style | Keep | Preview |", "|---|---|---|---|---|---|"]
    for path, c in shown:
        ln = str(c["start_line"]) if c["start_line"] == c["end_line"] else "%d-%d" % (c["start_line"], c["end_line"])
        typ = c["type"] + (" " + c["marker"] if c["marker"] else "")
        o.append("| %s | %s | %s | %s | %s | %s |" % (esc(path), ln, typ, esc(c["style"]), c["keep"], esc(c["preview"])))
    if len(shown) < total:
        o += ["", "_Showing first %d of %d comments. Use --max-items 0 for all, or --format json._" % (len(shown), total)]
    return "\n".join(o) + "\n"


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Scan code comments and estimate their token cost.")
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--format", choices=("markdown", "json"), default="markdown")
    ap.add_argument("--max-items", type=int, default=200)
    ap.add_argument("--type", action="append", choices=TYPES, default=[])
    ap.add_argument("--markers-only", action="store_true")
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--no-gitignore", action="store_true")
    args = ap.parse_args()
    if not os.path.isdir(args.root):
        print("error: not a directory: %s" % args.root, file=sys.stderr)
        return 2
    root = os.path.abspath(args.root)
    collected = collect(root, args)
    stats = [file_stats(*x) for x in collected]
    tot = totals(stats)
    if args.format == "json":
        print(json.dumps({"root": root.replace(os.sep, "/"), "gitignore": MODE["value"],
                          "files_scanned": len(collected), "totals": tot,
                          "files": [f for f in stats if f["total"]]}, indent=2, ensure_ascii=False))
    else:
        print(render_markdown(root.replace(os.sep, "/"), len(collected), stats, tot, args.max_items), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
