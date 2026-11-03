---
name: comment-scanner
description: Scan the project for inline code comments (single-line, multi-line, doc comments, TODO/FIXME/HACK markers) in Python, Rust, TypeScript/JavaScript, HTML, CSS/SCSS, SQL and Next.js config files, and report them as token sinks. Use when the user asks to find, count, audit or clean up comments, reduce token waste from comments, or list TODO/FIXME markers.
---

# Goal

Project-context is the single source of truth for project knowledge. Inline comments often duplicate it and cost AI agents tokens on every file read. This skill finds and measures comments. It only reports; it never edits files.

# When to use

- The user asks to find, count, audit or clean up code comments.
- The user wants to reduce token waste caused by comments.
- The user wants a list of TODO / FIXME / HACK / XXX markers.

# Run

Requires Python 3.8+, standard library only.

- macOS / Linux: `python3 .agents/skills/comment-scanner/scripts/scan_comments.py .`
- Windows: `py -3 .agents\skills\comment-scanner\scripts\scan_comments.py .`

| Option | Meaning |
|---|---|
| `root` | Directory to scan (default `.`) |
| `--format markdown\|json` | Output format (default `markdown`) |
| `--max-items N` | Max comments listed in the report (default 200, `0` = all) |
| `--type T` | Only this type: `single-line`, `multi-line`, `doc`, `marker` (repeatable) |
| `--markers-only` | Only TODO/FIXME/HACK/XXX markers |
| `--exclude GLOB` | Skip paths matching the glob (repeatable) |
| `--no-gitignore` | Do not apply `.gitignore` |

Examples:

- Markers only: `python3 .agents/skills/comment-scanner/scripts/scan_comments.py . --markers-only`
- JSON: `python3 .agents/skills/comment-scanner/scripts/scan_comments.py . --format json`
- Exclude a folder: `python3 .agents/skills/comment-scanner/scripts/scan_comments.py . --exclude docs --exclude "vendor/**"`

# What it detects

| Language | Extensions | Comment styles |
|---|---|---|
| TypeScript / JavaScript | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | `//`, `/* */`, `/** */` (doc), `{/* */}` in tsx/jsx |
| Next.js config | `next.config.*` | same as above, flagged in the report |
| Rust | `.rs` | `//`, `///` and `//!` (doc), nested `/* */`, `/** */`, `/*! */` |
| Python | `.py` | `#`, standalone `"""` / `'''` blocks (doc when module/def/class docstring) |
| HTML | `.html .htm` | `<!-- -->` |
| CSS / SCSS | `.css .scss` | `/* */` (and `//` in SCSS) |
| SQL | `.sql` | `--`, `/* */` |

Types: single-line, multi-line, doc, marker (TODO/FIXME/HACK/XXX wins over other types). Each comment may carry a keep flag: `directive` (eslint, ts-expect-error, noqa, type: ignore, pylint, istanbul ignore, ...) or `license` (copyright, SPDX, @license). Shebangs and encoding lines are not reported.

# Skipped paths

- `.gitignore` is applied through `git ls-files`; without git a built-in parser is used.
- Always skipped: `node_modules/`, `target/`, `dist/`, `build/`, `.git/`, `__pycache__/`, `.praxis/` and this skill's own folder.

# Workflow for the agent

1. Run the scanner with the Markdown report.
2. Summarize for the user: totals, estimated tokens, counts by type, the heaviest files and the markers.
3. Never delete or rewrite comments without explicit user approval.
4. If the user wants cleanup: first move knowledge worth keeping (why, decisions, rules) into project-context, for example through the Praxis `update_project_context` flow. Keep comments flagged `directive` or `license`, shebangs and encoding lines. Offer to turn markers into tasks instead of deleting them.
5. Re-run the scanner and show the before/after delta.

# Limitations

- The lexer is heuristic: JavaScript regex literals and nested `${}` in template literals are not parsed.
- `<script>` and `<style>` contents inside HTML are not lexed.
- Token counts are estimates (characters / 4).
