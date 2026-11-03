"""Test Scanner CLI: reports test files, cases, frameworks and token cost. Read-only."""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from detectors import (SOURCE_EXTS, analyze_test_file, detect_config, is_inline_rust,  # noqa: E402
                       is_test_path, may_be_config, project_default_framework)
from file_walker import MODE, iter_files, read_text  # noqa: E402


def own_excludes(root: str) -> list:
    skill_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        rel = os.path.relpath(skill_dir, os.path.abspath(root)).replace(os.sep, "/")
    except ValueError:
        return []
    if rel.startswith("..") or rel == ".":
        return []
    return [rel, rel + "/*"]


def tokens(chars: int) -> int:
    return math.ceil(chars / 4)


def scan(root: str, args) -> dict:
    files = iter_files(root, not args.no_gitignore, list(args.exclude) + own_excludes(root))
    configs = []
    for rel in files:
        if may_be_config(rel):
            cfg = detect_config(rel, read_text(root, rel))
            if cfg:
                configs.append(cfg)
    default_fw = project_default_framework(configs)
    entries = []
    source_chars = 0
    for rel in files:
        if os.path.splitext(rel)[1] not in SOURCE_EXTS:
            continue
        text = read_text(root, rel)
        if text is None:
            continue
        source_chars += len(text)
        conv = is_test_path(rel)
        if conv:
            kind = "fixtures" if conv == "conftest.py" else (
                "stylesheet" if rel.endswith((".css", ".scss")) else "file")
            chars = len(text)
        else:
            inline = is_inline_rust(rel, text)
            if inline is None:
                continue
            kind, conv, chars = "inline", "#[cfg(test)]", inline
        a = analyze_test_file(rel, text, default_fw)
        entries.append({"path": rel, "kind": kind, "convention": conv, "frameworks": a["frameworks"],
                        "suites": a["suites"], "cases": a["cases"], "assertions": a["assertions"],
                        "fixtures": a["fixtures"], "lines": text.count("\n") + 1 if kind != "inline"
                        else text[len(text) - chars:].count("\n") + 1,
                        "chars": chars, "est_tokens": tokens(chars)})
    fw: dict = {}
    for e in entries:
        for name in e["frameworks"]:
            d = fw.setdefault(name, {"files": 0, "cases": 0})
            d["files"] += 1
            d["cases"] += e["cases"]
    test_chars = sum(e["chars"] for e in entries)
    src_tokens = tokens(source_chars)
    totals = {
        "test_files": sum(1 for e in entries if e["kind"] != "inline"),
        "inline_test_modules": sum(1 for e in entries if e["kind"] == "inline"),
        "suites": sum(e["suites"] for e in entries), "cases": sum(e["cases"] for e in entries),
        "assertions": sum(e["assertions"] for e in entries), "fixtures": sum(e["fixtures"] for e in entries),
        "lines": sum(e["lines"] for e in entries), "est_tokens": tokens(test_chars),
        "source_est_tokens": src_tokens,
        "share_of_source_pct": round(100.0 * tokens(test_chars) / src_tokens, 1) if src_tokens else 0.0,
        "config_files": len(configs)}
    entries.sort(key=lambda e: (-e["est_tokens"], e["path"]))
    return {"root": root.replace(os.sep, "/"), "gitignore": MODE["value"], "files_scanned": len(files),
            "totals": totals, "frameworks": fw, "configs": configs, "files": entries}


def esc(s) -> str:
    return str(s).replace("|", "\\|")


def render_markdown(rep: dict, max_items: int) -> str:
    t = rep["totals"]
    o = ["# Test Scanner report",
         "Root: %s · Files scanned: %d · gitignore: %s" % (rep["root"], rep["files_scanned"], rep["gitignore"]),
         "", "## Project totals", "", "| Metric | Value |", "|---|---|",
         "| Test files | %d |" % t["test_files"], "| Inline test modules (Rust) | %d |" % t["inline_test_modules"],
         "| Test suites | %d |" % t["suites"], "| Test cases | %d |" % t["cases"],
         "| Assertions | %d |" % t["assertions"], "| Fixtures | %d |" % t["fixtures"],
         "| Test lines | %d |" % t["lines"], "| Est. test tokens (chars/4) | %d |" % t["est_tokens"],
         "| Share of source tokens | %s%% |" % t["share_of_source_pct"],
         "| Config files | %d |" % t["config_files"], "", "## Frameworks", "",
         "| Framework | Files | Cases |", "|---|---|---|"]
    for name, d in sorted(rep["frameworks"].items(), key=lambda kv: -kv[1]["files"]):
        o.append("| %s | %d | %d |" % (esc(name), d["files"], d["cases"]))
    o += ["", "## Test config files", "", "| File | Framework | Reason |", "|---|---|---|"]
    for c in rep["configs"]:
        o.append("| %s | %s | %s |" % (esc(c["path"]), esc(c["framework"]), esc(c["reason"])))
    total = len(rep["files"])
    shown = rep["files"] if max_items == 0 else rep["files"][:max_items]
    o += ["", "## Per file (first %d of %d, sorted by est. tokens desc)" % (len(shown), total), "",
          "| File | Kind | Convention | Framework | Suites | Cases | Assertions | Lines | Est. tokens |",
          "|---|---|---|---|---|---|---|---|---|"]
    for e in shown:
        o.append("| %s | %s | %s | %s | %d | %d | %d | %d | %d |" % (
            esc(e["path"]), e["kind"], esc(e["convention"]), esc(", ".join(e["frameworks"])),
            e["suites"], e["cases"], e["assertions"], e["lines"], e["est_tokens"]))
    if len(shown) < total:
        o += ["", "_Showing first %d of %d files. Use --max-items 0 for all, or --format json._" % (len(shown), total)]
    return "\n".join(o) + "\n"


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Scan test files and estimate their token cost.")
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--format", choices=("markdown", "json"), default="markdown")
    ap.add_argument("--max-items", type=int, default=200)
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--no-gitignore", action="store_true")
    args = ap.parse_args()
    if not os.path.isdir(args.root):
        print("error: not a directory: %s" % args.root, file=sys.stderr)
        return 2
    rep = scan(os.path.abspath(args.root), args)
    if args.format == "json":
        print(json.dumps(rep, indent=2, ensure_ascii=False))
    else:
        print(render_markdown(rep, args.max_items), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
