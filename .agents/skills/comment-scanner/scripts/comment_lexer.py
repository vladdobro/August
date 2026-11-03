"""Per-language comment lexer (heuristic: no JS regex literals, no template ${} nesting)."""
from __future__ import annotations

import os
import re
from typing import List, Optional

from lexer_base import Comment, _line_start_blank, _skip_string
from py_lexer import lex_python as _lex_python

LANG_BY_EXT = {
    ".ts": "js", ".tsx": "js", ".mts": "js", ".cts": "js", ".js": "js", ".jsx": "js",
    ".mjs": "js", ".cjs": "js", ".rs": "rust", ".py": "python", ".html": "html",
    ".htm": "html", ".css": "css", ".scss": "scss", ".sql": "sql",
}
JSX_EXTS = (".tsx", ".jsx")

MARKER_RE = re.compile(r"\b(TODO|FIXME|HACK|XXX)\b")
LICENSE_RE = re.compile(r"(?i)copyright|spdx-license|@license|licensed under")
DIRECTIVE_RE = re.compile(
    r"eslint-|prettier-ignore|@ts-(ignore|expect-error|nocheck|check)|tslint:|biome-ignore|noqa"
    r"|type:\s*ignore|pylint:|pyright:|mypy:|istanbul ignore|c8 ignore|v8 ignore|#region|#endregion"
    r"|webpackChunkName|@vite-ignore|@jsx|@refresh|rustfmt::|clippy::|fmt: (off|on)|isort:|stylelint-")
CHAR_LIT_RE = re.compile(r"'(?:\\.[^']*|[^\\'])'")


def language_for(rel_path: str) -> Optional[str]:
    return LANG_BY_EXT.get(os.path.splitext(rel_path)[1].lower())


def _block_end(text: str, i: int, nested: bool) -> int:
    """Index just after the closing */ of a block starting at i."""
    n = len(text)
    depth, j = 1, i + 2
    while j < n:
        if nested and text.startswith("/*", j):
            depth += 1
            j += 2
        elif text.startswith("*/", j):
            depth -= 1
            j += 2
            if depth == 0:
                return j
        else:
            j += 1
    return n


def _lex_c_like(text: str, lang: str, jsx: bool) -> List[Comment]:
    out: List[Comment] = []
    n, i, line = len(text), 0, 1
    line_comments = lang in ("js", "rust", "scss")
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if lang == "rust" and c in "rb" and i + 1 < n:
            m = re.compile(r'b?r(#*)"').match(text, i) if not (i and (text[i - 1].isalnum() or text[i - 1] == "_")) else None
            if m:
                close = '"' + m.group(1)
                end = text.find(close, m.end())
                end = n if end < 0 else end + len(close)
                line += text.count("\n", i, end)
                i = end
                continue
        if c in "\"'`" and not (lang == "rust" and c == "`"):
            if lang == "rust" and c == "'":
                m = CHAR_LIT_RE.match(text, i)
                i = m.end() if m else i + 1
                continue
            if c == "`" and lang not in ("js",):
                i += 1
                continue
            end = _skip_string(text, i, c)
            line += text.count("\n", i, end)
            i = end
            continue
        if line_comments and text.startswith("//", i):
            end = text.find("\n", i)
            end = n if end < 0 else end
            style, kind = "//", "single-line"
            if lang == "rust" and text.startswith("///", i) and not text.startswith("////", i):
                style, kind = "///", "doc"
            elif lang == "rust" and text.startswith("//!", i):
                style, kind = "//!", "doc"
            skip = len(style) if style != "//" else 2
            out.append(Comment(line, line, kind, style, text[i + skip:end].strip(),
                               inline=not _line_start_blank(text, i)))
            i = end
            continue
        if text.startswith("/*", i):
            end = _block_end(text, i, lang == "rust")
            body = text[i:end]
            inner = body[2:-2] if body.endswith("*/") and len(body) >= 4 else body[2:]
            span = body.count("\n")
            style, kind = "/* */", "multi-line"
            if body.startswith("/**") and not body.startswith("/**/"):
                style, kind, inner = "/** */", "doc", inner[1:]
            elif lang == "rust" and body.startswith("/*!"):
                style, kind, inner = "/*! */", "doc", inner[1:]
            if jsx and lang == "js":
                before = text[:i].rstrip()
                after = text[end:].lstrip()
                if before.endswith("{") and after.startswith("}"):
                    style = "{/* */}"
            out.append(Comment(line, line + span, kind, style, inner.strip(),
                               inline=not _line_start_blank(text, i)))
            line += span
            i = end
            continue
        i += 1
    return out


def _lex_css(text: str, scss: bool) -> List[Comment]:
    return _lex_c_like(text, "scss" if scss else "css", False)


def _lex_sql(text: str) -> List[Comment]:
    out: List[Comment] = []
    n, i, line = len(text), 0, 1
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
        elif c == "'":
            j = i + 1
            while j < n:
                if text[j] == "'":
                    if text.startswith("''", j):
                        j += 2
                        continue
                    break
                j += 1
            end = min(j + 1, n)
            line += text.count("\n", i, end)
            i = end
        elif text.startswith("--", i):
            end = text.find("\n", i)
            end = n if end < 0 else end
            out.append(Comment(line, line, "single-line", "--", text[i + 2:end].strip(),
                               inline=not _line_start_blank(text, i)))
            i = end
        elif text.startswith("/*", i):
            end = _block_end(text, i, False)
            body = text[i:end]
            span = body.count("\n")
            out.append(Comment(line, line + span, "multi-line", "/* */", body[2:-2].strip(),
                               inline=not _line_start_blank(text, i)))
            line += span
            i = end
        else:
            i += 1
    return out


def _lex_html(text: str) -> List[Comment]:
    out = []
    for m in re.finditer(r"<!--(.*?)-->", text, re.S):
        s = text.count("\n", 0, m.start()) + 1
        e = s + m.group(0).count("\n")
        out.append(Comment(s, e, "multi-line" if e > s else "single-line", "<!-- -->",
                           m.group(1).strip(), inline=not _line_start_blank(text, m.start())))
    return out


def _merge(comments: List[Comment]) -> List[Comment]:
    out: List[Comment] = []
    for c in comments:
        p = out[-1] if out else None
        if (p and c.kind == p.kind == "single-line" or p and c.style == p.style == "///" or
                p and c.style == p.style == "//!") and p.style == c.style and not c.inline \
                and not p.inline and c.start_line == p.end_line + 1:
            p.end_line = c.end_line
            p.text += "\n" + c.text
        else:
            out.append(c)
    return out


def _classify(c: Comment) -> None:
    m = MARKER_RE.search(c.text)
    if m:
        c.kind, c.marker = "marker", m.group(1)
    if LICENSE_RE.search(c.text):
        c.keep = "license"
    elif DIRECTIVE_RE.search(c.text):
        c.keep = "directive"


def scan_comments(text: str, lang: str, rel_path: str = "") -> List[Comment]:
    jsx = rel_path.lower().endswith(JSX_EXTS)
    if lang in ("js", "rust"):
        found = _lex_c_like(text, lang, jsx)
    elif lang in ("css", "scss"):
        found = _lex_css(text, lang == "scss")
    elif lang == "python":
        found = _lex_python(text)
    elif lang == "html":
        found = _lex_html(text)
    elif lang == "sql":
        found = _lex_sql(text)
    else:
        return []
    found = _merge(found)
    for c in found:
        _classify(c)
    return found
