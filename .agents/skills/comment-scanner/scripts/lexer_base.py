"""Shared lexer types and helpers."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Comment:
    start_line: int
    end_line: int
    kind: str
    style: str
    text: str
    marker: str = ""
    keep: str = ""
    inline: bool = False


def _skip_string(text: str, i: int, quote: str) -> int:
    n = len(text)
    i += 1
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == quote:
            return i + 1
        if c == "\n" and quote != "`":
            return i
        i += 1
    return n


def _line_start_blank(text: str, i: int) -> bool:
    j = text.rfind("\n", 0, i) + 1
    return not text[j:i].strip()
