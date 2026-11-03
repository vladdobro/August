"""Shared file walker: honours .gitignore via git, with a parser fallback."""
from __future__ import annotations

import fnmatch
import os
import shutil
import subprocess
from typing import List, Optional, Sequence, Tuple

MODE = {"value": "off"}
SKIP_DIRS = frozenset({"node_modules", "target", "dist", "build", ".git", "__pycache__", ".praxis"})


def _git_files(root: str) -> Optional[List[str]]:
    if not shutil.which("git"):
        return None
    try:
        chk = subprocess.run(["git", "-C", root, "rev-parse", "--is-inside-work-tree"],
                             capture_output=True, text=True, check=False, timeout=60)
        if chk.stdout.strip() != "true":
            return None
        res = subprocess.run(["git", "-C", root, "ls-files", "-z", "--cached", "--others",
                              "--exclude-standard"], capture_output=True, check=False, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode != 0:
        return None
    out = res.stdout.decode("utf-8", errors="replace")
    return [p for p in out.split("\0") if p and os.path.isfile(os.path.join(root, p))]


def _load_rules(directory: str) -> List[Tuple[str, bool, bool, bool]]:
    rules = []
    try:
        with open(os.path.join(directory, ".gitignore"), encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return rules
    for line in lines:
        line = line.rstrip()
        if not line or line.startswith("#"):
            continue
        neg = line.startswith("!")
        if neg:
            line = line[1:]
        dir_only = line.endswith("/")
        line = line.rstrip("/")
        anchored = line.startswith("/") or "/" in line
        line = line.lstrip("/")
        while line.startswith("**/"):
            line = line[3:]
            anchored = "/" in line
        if line:
            rules.append((line, neg, dir_only, anchored))
    return rules


def _ignored(rel_to_rules: str, is_dir: bool, rules) -> Optional[bool]:
    result = None
    base = rel_to_rules.rsplit("/", 1)[-1]
    for pat, neg, dir_only, anchored in rules:
        if dir_only and not is_dir:
            continue
        target = rel_to_rules if anchored else base
        if fnmatch.fnmatchcase(target, pat):
            result = not neg
    return result


def _excluded(rel: str, excludes: Sequence[str]) -> bool:
    for pat in excludes:
        pat = pat.replace("\\", "/").rstrip("/")
        if not pat:
            continue
        if fnmatch.fnmatchcase(rel, pat) or fnmatch.fnmatchcase(rel, pat + "/*") \
                or fnmatch.fnmatchcase(rel, pat + "/**"):
            return True
    return False


def _walk(root: str, use_gitignore: bool) -> List[str]:
    found: List[str] = []
    rules_by_dir = {}
    for cur, dirs, files in os.walk(root):
        rel_dir = os.path.relpath(cur, root).replace(os.sep, "/")
        rel_dir = "" if rel_dir == "." else rel_dir
        if use_gitignore:
            rules_by_dir[rel_dir] = _load_rules(cur)

        def is_ignored(name: str, is_dir: bool) -> bool:
            verdict = None
            parts = rel_dir.split("/") if rel_dir else []
            for i in range(len(parts) + 1):
                scope = "/".join(parts[:i])
                rules = rules_by_dir.get(scope)
                if not rules:
                    continue
                sub = "/".join(parts[i:] + [name])
                v = _ignored(sub, is_dir, rules)
                if v is not None:
                    verdict = v
            return bool(verdict)

        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not (use_gitignore and is_ignored(d, True)))
        for name in files:
            if use_gitignore and is_ignored(name, False):
                continue
            found.append((rel_dir + "/" + name) if rel_dir else name)
    return found


def iter_files(root: str, use_gitignore: bool = True, excludes: Sequence[str] = ()) -> List[str]:
    files = _git_files(root) if use_gitignore else None
    MODE["value"] = "off" if not use_gitignore else ("git" if files is not None else "parser")
    if files is None:
        files = _walk(root, use_gitignore)
    out = []
    for p in files:
        p = p.replace("\\", "/")
        if any(seg in SKIP_DIRS for seg in p.split("/")) or _excluded(p, excludes):
            continue
        out.append(p)
    return sorted(set(out))


def read_text(root: str, rel: str, max_bytes: int = 2_000_000) -> Optional[str]:
    path = os.path.join(root, rel)
    try:
        if os.path.getsize(path) > max_bytes:
            return None
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError:
        return None
    if b"\0" in data[:8192]:
        return None
    return data.decode("utf-8", errors="replace")
