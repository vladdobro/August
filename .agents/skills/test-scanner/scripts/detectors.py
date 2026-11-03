"""Test file classification, framework/case detection and test config detection."""
from __future__ import annotations

import json
import os
import re
from typing import Dict, List, Optional

TEST_DIR_NAMES = {"tests", "__tests__"}
SOURCE_EXTS = {".py", ".rs", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss"}
JS_EXTS = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}


def is_test_path(rel: str) -> Optional[str]:
    base = rel.rsplit("/", 1)[-1]
    stem, ext = os.path.splitext(base)
    if base == "conftest.py":
        return "conftest.py"
    if ext not in SOURCE_EXTS:
        return None
    if ".test." in base:
        return "*.test.*"
    if ".spec." in base:
        return "*.spec.*"
    if ".e2e." in base:
        return "*.e2e.*"
    if stem.endswith("_test"):
        return "*_test.*"
    if base.startswith("test_"):
        return "test_*.*"
    for seg in rel.split("/")[:-1]:
        if seg in TEST_DIR_NAMES:
            return seg + "/"
    return None


def _c(p: str) -> "re.Pattern":
    return re.compile(p, re.M)


PY_CASE = _c(r"^\s*(?:async\s+)?def\s+test\w*\s*\(")
PY_SUITE = _c(r"^\s*class\s+Test\w*")
PY_FIX = _c(r"^\s*@pytest\.fixture")
PY_ASSERT = [_c(r"^\s*assert\b"), _c(r"\bself\.assert\w+\s*\("), _c(r"\bpytest\.raises\s*\(")]
PY_PYTEST = _c(r"import pytest|from pytest|@pytest\.")
PY_UNITTEST = _c(r"import unittest|from unittest|unittest\.TestCase|\(TestCase\)")
JS_CASE = _c(r"(?<![\w.$])(?:it|test)(?:\.\w+)*\s*\(")
JS_SUITE = _c(r"(?<![\w.$])describe(?:\.\w+)*\s*\(")
JS_ASSERT = [_c(r"(?<![\w.$])expect\s*\("), _c(r"(?<![\w.$])assert(?:\.\w+)?\s*\(")]
JS_FW = [
    ("vitest", _c(r"""from ['"]vitest['"]|require\(['"]vitest['"]\)""")),
    ("jest", _c(r"@jest/globals|\bjest\.(fn|mock|spyOn)\b")),
    ("mocha", _c(r"""from ['"]mocha['"]|require\(['"]mocha['"]\)""")),
    ("playwright", _c(r"@playwright/test")),
    ("node:test", _c(r"""['"]node:test['"]""")),
]
RS_CASE = _c(r"#\[(?:tokio::)?test\]|#\[rstest\]|#\[test_case")
RS_SUITE = _c(r"#\[cfg\(test\)\]")
RS_ASSERT = _c(r"\b(?:debug_)?assert(?:_eq|_ne)?!\s*\(")


def _count(pats, text: str) -> int:
    if not isinstance(pats, list):
        pats = [pats]
    return sum(len(p.findall(text)) for p in pats)


def analyze_test_file(rel: str, text: str, default_framework: str = "unknown") -> Dict:
    ext = os.path.splitext(rel)[1]
    res = {"frameworks": [], "suites": 0, "cases": 0, "assertions": 0, "fixtures": 0}
    if ext == ".py":
        res["cases"] = _count(PY_CASE, text)
        res["suites"] = _count(PY_SUITE, text)
        res["fixtures"] = _count(PY_FIX, text)
        res["assertions"] = _count(PY_ASSERT, text)
        unit = bool(PY_UNITTEST.search(text))
        if PY_PYTEST.search(text) or (res["cases"] > 0 and not unit):
            res["frameworks"].append("pytest")
        if unit:
            res["frameworks"].append("unittest")
    elif ext in JS_EXTS:
        res["cases"] = _count(JS_CASE, text)
        res["suites"] = _count(JS_SUITE, text)
        res["assertions"] = _count(JS_ASSERT, text)
        res["frameworks"] = [n for n, p in JS_FW if p.search(text)]
        if not res["frameworks"]:
            res["frameworks"] = [default_framework if res["cases"] + res["suites"] > 0 else "unknown"]
    elif ext == ".rs":
        res["cases"] = _count(RS_CASE, text)
        res["suites"] = _count(RS_SUITE, text)
        res["assertions"] = _count(RS_ASSERT, text)
        res["frameworks"] = ["rust-test"]
    elif ext in (".css", ".scss"):
        res["frameworks"] = ["stylesheet"]
    return res


def is_inline_rust(rel: str, text: str) -> Optional[int]:
    """Char count of inline test code for non-test .rs files, else None."""
    if not rel.endswith(".rs"):
        return None
    m = re.search(r"^[ \t]*#\[cfg\(test\)\]", text, re.M)
    if m:
        return len(text) - m.start()
    if re.search(r"#\[test\]", text):
        return len(text)
    return None


CONFIG_BASES = ("jest.config.", "vitest.config.", "vitest.workspace.", "playwright.config.", ".mocharc")
CONFIG_NAMES = {"pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml", "Cargo.toml", "package.json"}


def may_be_config(rel: str) -> bool:
    base = rel.rsplit("/", 1)[-1]
    return (base in CONFIG_NAMES or base.startswith(CONFIG_BASES)
            or rel.endswith((".cargo/config.toml", ".cargo/config")))


def detect_config(rel: str, text: Optional[str]) -> Optional[Dict]:
    base = rel.rsplit("/", 1)[-1]
    text = text or ""

    def r(fw: str, reason: str) -> Dict:
        return {"path": rel, "framework": fw, "reason": reason}

    if base.startswith("jest.config."):
        return r("next/jest", "jest.config (next/jest)") if "next/jest" in text else r("jest", "jest.config.*")
    if base.startswith(("vitest.config.", "vitest.workspace.")):
        return r("vitest", base.split(".")[0] + ".*")
    if base.startswith("playwright.config."):
        return r("playwright", "playwright.config.*")
    if base.startswith(".mocharc"):
        return r("mocha", ".mocharc*")
    if base == "pytest.ini":
        return r("pytest", "pytest.ini")
    if base == "tox.ini" and "[pytest]" in text:
        return r("pytest", "[pytest]")
    if base == "setup.cfg" and "[tool:pytest]" in text:
        return r("pytest", "[tool:pytest]")
    if base == "pyproject.toml" and "[tool.pytest" in text:
        return r("pytest", "[tool.pytest]")
    if base == "Cargo.toml" and "[dev-dependencies]" in text:
        return r("rust", "[dev-dependencies]")
    if rel.endswith((".cargo/config.toml", ".cargo/config")):
        return r("rust", ".cargo/config.toml")
    if base == "package.json":
        try:
            data = json.loads(text)
        except ValueError:
            return None
        if not isinstance(data, dict):
            return None
        deps: Dict = {}
        for key in ("dependencies", "devDependencies"):
            if isinstance(data.get(key), dict):
                deps.update(data[key])
        fws: List[str] = [n for n in ("jest", "vitest", "mocha", "@playwright/test") if n in deps]
        reasons = ["devDependencies: " + ", ".join(fws)] if fws else []
        if "jest" in data:
            if "jest" not in fws:
                fws.append("jest")
            reasons.append("jest key")
        scripts = data.get("scripts")
        if isinstance(scripts, dict) and scripts.get("test"):
            reasons.append("scripts.test")
        if reasons:
            return r("+".join(fws) if fws else "unknown", "; ".join(reasons))
    return None


def project_default_framework(configs: List[Dict]) -> str:
    found = {c["framework"] for c in configs}
    for name in ("vitest", "jest", "next/jest", "mocha"):
        if any(name == f or name in f.split("+") for f in found):
            return name
    return "unknown"
