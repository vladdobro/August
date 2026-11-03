---
name: test-scanner
description: Scan the project for test files, test cases, assertions and test framework config (pytest, unittest, Rust #[test], Jest, Vitest, Mocha, next/jest, Playwright) and report how many tokens test code costs AI agents. Use when the user asks to find, count or audit tests, detect the test framework, or measure test-code token weight.
---

# Goal

Test files are a large token sink when agents read a codebase. This skill finds test files, counts cases and assertions, detects frameworks and config, and estimates the token cost of test code. It only reports; it never edits files.

# When to use

- The user asks to find, count or audit tests.
- The user wants to know which test frameworks the project uses.
- The user wants to measure the token weight of test code.

# Run

Requires Python 3.8+, standard library only.

- macOS / Linux: `python3 .agents/skills/test-scanner/scripts/scan_tests.py .`
- Windows: `py -3 .agents\skills\test-scanner\scripts\scan_tests.py .`

| Option | Meaning |
|---|---|
| `root` | Directory to scan (default `.`) |
| `--format markdown\|json` | Output format (default `markdown`) |
| `--max-items N` | Max files listed in the per-file table (default 200, `0` = all) |
| `--exclude GLOB` | Skip paths matching the glob (repeatable) |
| `--no-gitignore` | Do not apply `.gitignore` |

Examples:

- JSON: `python3 .agents/skills/test-scanner/scripts/scan_tests.py . --format json`
- Exclude a folder: `python3 .agents/skills/test-scanner/scripts/scan_tests.py . --exclude "vendor/**"`

# What it detects

- Naming conventions: `*.test.*`, `*.spec.*`, `*.e2e.*`, `*_test.*`, `test_*.*`, files under `tests/` or `__tests__/`, `conftest.py` (fixtures).
- Python: `def test_*`, `class Test*`, `@pytest.fixture`, `assert`, `self.assert*`, `pytest.raises`; pytest and unittest.
- JS/TS: `describe`, `it`, `test`, `expect`, `assert`; Vitest, Jest, Mocha, Playwright, `node:test`.
- Rust: `#[test]`, `#[tokio::test]`, `#[rstest]`, `#[cfg(test)]` (inline modules in non-test files), `assert!` family.
- Config files: `jest.config.*` (incl. next/jest), `vitest.config.*`, `playwright.config.*`, `.mocharc*`, `pytest.ini`, `tox.ini`, `setup.cfg`, `pyproject.toml [tool.pytest]`, `Cargo.toml [dev-dependencies]`, `.cargo/config.toml`, test entries in `package.json`.
- Per file: framework, suites, cases, assertions, lines, estimated tokens; project totals and share of source tokens.

Skipped: `.gitignore`d paths (via `git ls-files`, parser fallback), `node_modules/`, `target/`, `dist/`, `build/`, `.git/`, `__pycache__/`, `.praxis/` and this skill's own folder.

# Workflow for the agent

1. Run the scanner with the Markdown report.
2. Summarize for the user: totals, frameworks, config files, heaviest files and the share of source tokens.
3. Never delete, move or modify tests without explicit user approval.
4. Offer options the user may choose: document the test strategy and frameworks in project-context so agents need not read test files; tell agents to skip test files unless the task touches them; remove dead or duplicated tests only with approval.
5. Re-run the scanner and show the before/after delta.

# Limitations

- Counts are regex-based; commented-out tests may be counted.
- The Rust inline token estimate covers text from the first `#[cfg(test)]` to the end of the file.
- Token counts are estimates (characters / 4).
