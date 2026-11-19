---
name: pushrem
description: August release flow — commit the pending changes to master, push them, bump the app version and build new installers through the GitHub "Release desktop app" workflow. Use when the user types /pushrem or asks to commit + push + build new distributives / a new release with a version bump.
---

# /pushrem — commit, push, bump version, build installers

Arguments (optional): `patch` (default), `minor`, `major`, or an exact version like `0.3.0`.

Run every step in order. Stop and report on the first failure; never skip a step silently.

## 1. Look before committing
- `git branch --show-current` must be `master` (August commits go straight to master). Otherwise stop and ask.
- `git status --short` and `git diff --stat`. Read the list.
- Commit everything that belongs to the work: source, tests, `project-context/`, `.praxis/tasks/` moves, `docs/`.
- Never commit: `.env*`, credentials, `*.log`, build output (`dist/`, `electron/release/`), `installed/`, files outside the repo's normal layout that look like scratch. If unsure about a file, ask with `AskUserQuestion` instead of guessing.
- Other agents may work in this repo: if a running peer session (ListAgents, not idle) owns some of the changes, ask before including them.
- Nothing to commit and nothing unpushed → still continue to the version bump only if the user asked for a build; otherwise report and stop.

## 2. Bump the version
- Current version: the root `version` file (single source of truth).
- New version: `patch` → x.y.(z+1), `minor` → x.(y+1).0, `major` → (x+1).0.0, or the exact argument.
- The tag `v<new>` must not exist yet: `git tag --list v<new>` and `git ls-remote --tags origin v<new>`. If it exists, stop and ask.
- Write it with Node (no BOM, keeps UTF-8), then sync package.json and the lockfile:
  ```
  node -e "require('fs').writeFileSync('version', process.argv[1] + '\n')" <new>
  npm run version:sync
  ```
- Do NOT edit package.json with PowerShell `Get-Content`/`Set-Content`: Windows PowerShell 5.1 adds a BOM and corrupts non-ASCII characters (the em dash in `description`).

## 3. Verify before pushing
- `npm run build` and `npm run electron:test` must pass. The server tests (`cd server && npm test`) run when server files changed.
- A failure stops the flow: report the output, do not commit the bump, do not push.

## 4. Commit
- Message: when `.praxis/tasks/to_review/` holds tasks changed in this diff, start with their titles (`[AUG-123] Title ...`); otherwise a one-line summary of the change. Then `; bump version to <new>`.
- End with the attribution line from the session's system reminder (e.g. `Co-Authored-By: Claude ... <noreply@anthropic.com>`).
- Windows: write the message to a file in the scratchpad and run `git commit -F <file>`. `git commit -F -` with a PowerShell here-string does not work (stdin is not passed).
- Stage explicit paths or `git add -A` only after step 1 confirmed the whole list.

## 5. Push and trigger the release
```
git push origin master
git tag v<new>
git push origin v<new>
```
- The tag push starts `.github/workflows/release.yml` ("Release desktop app"): it creates the GitHub release for the tag, then builds macOS arm64 (dmg + zip) and Windows x64 (exe + msi) and uploads `latest.yml` / `latest-mac.yml`, which feed electron-updater.
- Do not also run `gh workflow run`: the tag push already triggers it, a second run races on the same release.
- git prints progress to stderr; in PowerShell that shows as NativeCommandError even on success — check the `->` lines, not the error banner.

## 6. Watch the build
- `gh run list --workflow release.yml --limit 1` → run id (event `push`, branch `v<new>`).
- Watch in the background (takes ~10 min): `gh run watch <id> --exit-status` with `run_in_background`; exit 0 = success.
- Then `gh run view <id>` (job results) and `gh release view v<new> --json assets --jq ".assets[].name"`.
- In PowerShell avoid `--jq` expressions with spaces or quotes around `+`: they break argument parsing; use `gh run view <id>` plain output instead.
- A failed job: `gh run view <id> --log-failed`, report the failing step; do not delete or re-push the tag without asking.

## 7. Report (≤6 lines)
- Commit sha + one-line message, new version, tag pushed.
- Run id + result per job (mac / win), release assets list (exe, msi, dmg, zip, latest*.yml).
- Anything skipped or left uncommitted, and why.
