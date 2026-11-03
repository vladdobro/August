"""Python comment/docstring lexer."""
from __future__ import annotations

import re
from typing import List

from lexer_base import Comment, _line_start_blank, _skip_string

NON_DEF_RE = re.compile(r"(if|elif|else|for|while|try|except|finally|with|match|case)\b|else:|try:|finally:")
PY_PREFIX_RE = re.compile(r"(?i)(?:rb|br|fr|rf|r|b|u|f)?")


def lex_python(text: str) -> List[Comment]:
    out: List[Comment] = []
    n, i, line = len(text), 0, 1
    seen_code = False
    prev_code = ""
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if c == "#":
            end = text.find("\n", i)
            end = n if end < 0 else end
            body = text[i + 1:end]
            if not ((line == 1 and text.startswith("#!")) or re.match(r"\s*-\*-\s*coding|\s*(?:vim?:\s*)?(?:en)?coding[:=]", body)):
                out.append(Comment(line, line, "single-line", "#", body.strip(),
                                   inline=not _line_start_blank(text, i)))
            i = end
            continue
        if c in " \t\r\f":
            i += 1
            continue
        ls = text.rfind("\n", 0, i) + 1
        pm = PY_PREFIX_RE.match(text, i)
        q_at = pm.end() if pm else i
        if q_at < n and text[q_at] in "\"'" and (i == q_at or not (i and (text[i - 1].isalnum() or text[i - 1] == "_"))):
            q = text[q_at]
            if text.startswith(q * 3, q_at):
                close = text.find(q * 3, q_at + 3)
                while close > 0 and text[close - 1] == "\\" and text[close - 2:close] != "\\\\":
                    close = text.find(q * 3, close + 1)
                end = n if close < 0 else close + 3
                eol = text.find("\n", end)
                eol = n if eol < 0 else eol
                rest = text[end:eol].strip()
                standalone = not text[ls:i].strip() and (not rest or rest.startswith("#"))
                if standalone:
                    kind = "multi-line"
                    if not seen_code or (prev_code.endswith(":") and not NON_DEF_RE.match(prev_code)):
                        kind = "doc"
                    seen_code = True
                    body = text[q_at + 3:end - 3 if close >= 0 else end]
                    out.append(Comment(line, line + text.count("\n", i, end), kind, q * 3, body.strip()))
                else:
                    seen_code = True
                    prev_code = text[ls:eol].strip()
                line += text.count("\n", i, end)
                i = end
                continue
            end = _skip_string(text, q_at, q)
            line += text.count("\n", i, end)
            seen_code = True
            i = end
            continue
        eol = text.find("\n", i)
        eol = n if eol < 0 else eol
        stripped = text[ls:eol].split("#")[0].strip()
        if stripped:
            if not (stripped.startswith("from __future__") and not seen_code):
                seen_code = True
            prev_code = stripped
        # advance over this code token run, skipping strings
        j = i
        while j < eol:
            ch = text[j]
            if ch in "\"'":
                break
            if ch == "#":
                break
            j += 1
        i = max(j, i + 1)
    return out
