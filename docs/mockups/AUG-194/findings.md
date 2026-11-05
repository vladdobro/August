# AUG-194 — Settings → AI assistants: tab spec, preferences, consent, status probe

Research only, 2026-11-06, Windows 10 x64, Claude Code 2.1.318, PraxisOS local API 0.1.0 (api 144). Mockup: `ai-assistants-tab.html` (self-contained, built on the real `client/src/App.css` `.settings-*` rules). Parent: AUG-193 (Option A, Sonnet default). Copilot row follows the AUG-196 decision (four modes), not the AUG-193 toggle + checkbox draft.

## 1. Tab layout (final)

Tab strip: GENERAL · AUDIO · TRANSCRIPTION · PROJECTS · **AI ASSISTANTS** · COMPACT MODE. Tab id `assistants`. Six tabs need ≈ 680 px with today's tab CSS (14 px padding, .1em spacing) and overflow the 600 px card → **decision 2026-11-06: `.settings-card` becomes `width: min(680px, 100%)` for every tab**; tab CSS unchanged (rejected: tighter tab padding, renaming the tab). Four sections, top to bottom:

### 1.1 Status
One section instead of per-row Claude Code hints (both the copilot's Claude modes and the Active session need the same two things).

| Row | Right side (one line, terminal font) |
|---|---|
| Claude Code | `Signed in · 2.1.318` (muted) / `Installed, not signed in` (warn) / `Not installed` (warn) / `Too old (2.0.x) — update it` (warn) / `Checking…` (muted) |
| PraxisOS | `Running` (muted) / `Not running` (warn) |

Below the rows, only when something is wrong, a warn hint + a `RECHECK` button (`.settings-btn-inline`, outline):
- not installed → "Claude Code is not installed. Install it, run `claude` once in a terminal to sign in, then press Recheck."
- not signed in → "Claude Code is installed but not signed in. Run `claude` once in a terminal, sign in through the browser, then press Recheck."
- too old → "Claude Code is older than 2.1.318 and cannot report its sign-in. Run `claude update`, then press Recheck."
- Praxis not running → "PraxisOS is not running. Copilot hints start when it is; the Active session can still read project files."

Recheck re-runs both probes (`GET /api/assistant/status?recheck=1`); the button shows `Checking…` and is disabled while the probe runs (≤ 10 s). Nothing in this section shows a path, a port, an e-mail or a plan name.

### 1.2 Meeting Copilot (AUG-196 radio list)
`role="radiogroup"` of four cards (new CSS: `.settings-choice-list`, `.settings-choice`, `.settings-choice--selected`, `.settings-choice--disabled`; same look as the AUG-196 `.opt` cards: 1 px border, selected = accent border + `--accent-light` background, square 14 px radio mark). Each card: name (+ tag), description line, price/privacy line on the right (260 px column; stacks under the description below 560 px).

| Mode | Description | Price / privacy line |
|---|---|---|
| Off (default) | No hints. | Free · nothing is sent |
| Local hints | Spots references to past agreements and shows matching notes from the Praxis project. Finds less in meetings that are not in the notes' language. | Free · runs on this computer, nothing is sent |
| Claude explains **RECOMMENDED** (accent tag) | Same trigger; Claude checks the found notes, searches the project when needed and says in one sentence what was agreed. | About $0.10–0.20 per meeting hour of your Claude usage · sends only the few lines around each reference and the matching notes |
| Always-on Claude **EXPENSIVE** (red tag) | Claude reads the whole meeting and decides itself when to show a hint. Catches references without trigger words. | About $1–2.50 per meeting hour · the whole conversation is sent to Anthropic as it happens |

Children (`.settings-child`, shown only under the selected Claude mode):
- Claude explains → hint "Choosing this mode allows August to send the lines around each reference and the matching notes to Anthropic through your Claude account." + row **Model** (dropdown `aiCopilotModel`).
- Always-on Claude → row **Model** + row **Spending limit per meeting** (money field `aiCopilotAlwaysBudgetUsd`: `$` prefix + a free number input, real `.settings-input`, 96 px, right-aligned, placeholder "0 = no limit", default 2) + hint "At the limit the copilot switches to Claude explains for the rest of the meeting. Enter 0 for no limit." (with 0: "No limit: usage is capped only by your Claude plan.").

Section footer hint: "The copilot is off by default. You can switch modes during a meeting from the ASSISTANT panel."

State rules:
- Claude Code not usable (missing / not signed in / too old) → the two Claude cards get `--disabled` (opacity .45, not selectable; user decision 2026-11-06: disabled but visible, not selectable-with-warning). If one of them is the saved mode it stays selected and a warn hint appears under it: "Claude Code is not available — hints are shown without explanation until it is." (runtime falls back to Local hints; the saved mode is not changed).
- PraxisOS not running and mode ≠ Off → warn hint under the list: "PraxisOS is not running. Hints start when it is." (the choice is still saved).
- Choosing Claude explains = consent (writes `aiCopilotConsent`), no modal. Choosing Always-on opens the red confirmation modal (checkbox-gated, text from AUG-196 §2) every time; Cancel keeps the previous mode.
- Stale copilot consent (`aiCopilotConsent.version` < current) → the saved Claude card stays selected with warn hint "What this mode sends has changed since you chose it. Choose it again to confirm."; runtime runs Local hints until re-chosen. Re-clicking the selected card re-posts the mode.

### 1.3 Active session (Claude)
Row **Active session** · toggle (`.settings-toggle`, ON/OFF label). Hint: "A chat with Claude bound to a project of your choice during the meeting. It answers from the project notes, adds action items and creates Praxis tasks. Text is sent only when you ask."

Children (`.settings-child`, `--off` when the toggle is off or disabled):

| Row | Control | Hint |
|---|---|---|
| Model | dropdown `aiModel`: Sonnet — balanced (default) / Haiku — cheapest, fastest / Opus — strongest, costliest | Billed to your Claude plan. |
| Spending limit per meeting | money field `aiSessionBudgetUsd`: `$` prefix + free number input (`.settings-input`, 96 px, right-aligned, placeholder "0 = no limit", default 2), committed on change (blur / Enter) | The session stops answering when the limit is reached. Enter 0 for no limit. (With 0: "No limit: usage is capped only by your Claude plan.") |
| Transcript window | dropdown `aiTranscriptWindowMin`: 2 min / 5 min (default) / 10 min / 15 min | How much recent transcript goes with each question. |

State rules:
- Toggle ON (from OFF) → consent modal (§2). Agree → `POST /api/assistant/enable {accept:true}`; the toggle shows ON only after the response (same as Groq: `checked={enabled || consentOpen}`).
- Toggle OFF → `POST /api/assistant/disable` at once, no confirmation.
- Claude Code not usable → toggle disabled (`disabled`, cursor not-allowed, children `--off`). Saved value is left as is; label still shows it. Hint under the row: "Needs Claude Code — see Status above."
- Stale consent (`aiConsent.version` < `AI_SESSION_CONSENT_VERSION`) → toggle shows OFF (status `enabled:false, consentStale:true`), children `--off`, warn hint "What the session sends has changed since you agreed. Turn it on again to review and confirm." (mirrors the Groq "The Groq key changed. Turn this on again to confirm."). Turning it on reopens the modal.
- Enable failure (409 from the server: Claude Code vanished between probe and click) → warn hint with the server message; toggle back to OFF.

### 1.4 Footer hint
"Both assistants are off by default. Transcripts stay on this computer unless a mode above says otherwise."

## 2. Consent modal — Active session (Claude), final text

Pattern: `GroqTextConsentModal` (`.groq-setup-backdrop/-card/-header/-steps/-hint/-actions/-btn`), 440 px card, 28 px padding, accent title, lettered lines like the Groq modal. The window size in line A is the live value of Transcript window; the limit in line C is the live Spending limit.

Title: **Active session (Claude)**

1. A) When you ask a question during a live recording, the last **5 minutes** of the transcript, the participant names you entered, the collected action items and your question are sent to Anthropic. Nothing is sent until you ask.
2. B) It goes through Claude Code under your own Claude account, the same way as using Claude Code in a terminal. Claude may also read files in the project folder you pick for the meeting.
3. C) Usage counts against your Claude plan — no API key is needed. The session stops at your spending limit of **$2** per meeting. (With No limit the second sentence reads: "You chose no spending limit, so usage is capped only by your plan.")

Hint (muted): "You can turn this off at any time here. Meeting Copilot hints are covered by the mode you choose above, not by this consent."

Buttons: **Cancel** (outline) · **Agree and enable** (primary, accent). Esc / backdrop click = Cancel. Error line (red, `.groq-setup-error`) above the buttons when the enable call fails.

Consistency with the Groq modal (AUG-164/190): same three lettered statements (what is sent → to whom under which account → cost/limits), same button labels, same "nothing is changed/sent until…" reassurance, same card. Differences are deliberate: no key step (login instead), and the cost line names the plan and the per-meeting cap.

Always-on Claude confirmation (copilot, from AUG-196 §2, unchanged): red-framed card, title "Turn on Always-on Claude?", text "Always-on Claude sends the whole conversation to Anthropic as it happens, through your Claude account. A one-hour meeting costs about $1–2.50 of your Claude usage; it stops at your limit of $N.", checkbox "I understand the whole conversation leaves this computer", buttons Cancel / **Turn on** (enabled only with the checkbox). With No limit the last clause reads "you chose no spending limit." instead of "it stops at your limit of $N."

"No limit" (user decisions 2026-11-06): subscribers do not care about dollars per meeting, so both spending limits are **free number fields** (not dropdowns) where the user types any amount and **0 means no limit**; the child is spawned without `--max-budget-usd`. The AUG-193 caps (≤ 3 children, ≤ 12 hints/hour, window ≤ 15 min, idle stop) still apply.

## 3. Preferences spec

### 3.1 Keys

| Key | Type / values | Default | Where written | Sanitizer on PATCH |
|---|---|---|---|---|
| `aiCopilotMode` | `'off' \| 'local' \| 'claude' \| 'always'` | `'off'` | **only** `POST /api/assistant/copilot-mode` | not in ALLOWED_KEYS |
| `aiCopilotConsent` | `{ acceptedAt: ISO, version: number }` | absent | `POST /api/assistant/copilot-mode` when mode is `claude` or `always` | not in ALLOWED_KEYS |
| `aiCopilotAlwaysAck` | `{ acceptedAt: ISO }` | absent | `POST /api/assistant/copilot-mode` when mode is `always` and `ack:true` | not in ALLOWED_KEYS |
| `aiCopilotModel` | `'haiku' \| 'sonnet' \| 'opus'` | `'sonnet'` | PATCH /api/preferences | unknown value → key dropped from the patch |
| `aiCopilotAlwaysBudgetUsd` | number ≥ 0 in USD; `0` = no limit | `2` | PATCH | `Number()`; non-finite or negative → key dropped; rounded to cents; capped at 1000 |
| `aiSessionEnabled` | boolean | `false` | **only** `POST /api/assistant/enable` / `disable` | not in ALLOWED_KEYS |
| `aiConsent` | `{ acceptedAt: ISO, version: number }` | absent | `enable` writes, `disable` deletes | not in ALLOWED_KEYS |
| `aiModel` | `'haiku' \| 'sonnet' \| 'opus'` | `'sonnet'` | PATCH | unknown → dropped |
| `aiSessionBudgetUsd` | number ≥ 0 in USD; `0` = no limit | `2` | PATCH | as `aiCopilotAlwaysBudgetUsd` |
| `aiTranscriptWindowMin` | `2 \| 5 \| 10 \| 15` | `5` | PATCH | `Number()`; non-finite → dropped; snap to the nearest of 2/5/10/15 |

Dropped from AUG-193: `aiCopilotEnabled`, `aiCopilotExplain` (AUG-196). `DELETE /api/preferences` removes all of them, which resets both consents (same as Groq).

Why `aiCopilotMode` is server-only: `claude` needs a consent record and `always` needs an ack in the same write; letting PATCH set the mode would allow a Claude mode without a consent. One route, one invariant, mirrors `groqTextEnabled`.

Sanitizers live in `preferencesStore.ts` as `sanitizeAssistantPreferences(patch)` (same shape as `sanitizeCompactPreferences`), called from the PATCH handler; the consent routes use the same helpers for their own body.

### 3.2 Client `UserPreferences` additions (`client/src/services/preferences.ts`)
```ts
// AUG-194: AI assistants tab. Mode / enabled / consents are server-written (status route), not patched.
aiCopilotModel?: 'haiku' | 'sonnet' | 'opus';
aiCopilotAlwaysBudgetUsd?: number;
aiModel?: 'haiku' | 'sonnet' | 'opus';
aiSessionBudgetUsd?: number;
aiTranscriptWindowMin?: 2 | 5 | 10 | 15;
```
`DEFAULT_PREFERENCES`: `'sonnet', 2, 'sonnet', 2, 5`. `aiCopilotMode`, `aiSessionEnabled` and the consent records are read only through `GET /api/assistant/status` (like `groqText` state), never from the preferences object in the client.

### 3.3 Routes (`server/src/routes/assistant.ts`)

`GET /api/assistant/status[?recheck=1]` → `AssistantStatus`:
```ts
{
  claude: {
    found: boolean;            // CLI resolved and `claude --version` answered
    signedIn: boolean;         // `claude auth status` → loggedIn === true
    version: string | null;    // "2.1.318"
    tooOld: boolean;           // version < AI_MIN_CLAUDE_VERSION
    checkedAt: string;         // ISO of the cached probe
  };
  praxis: { reachable: boolean };          // GET http://127.0.0.1:7865/health 200 within 1.5 s
  copilot: {
    mode: 'off' | 'local' | 'claude' | 'always';   // saved
    consentStale: boolean;     // saved mode is claude/always and consent.version < AI_COPILOT_CONSENT_VERSION
    model: 'haiku' | 'sonnet' | 'opus';
    alwaysBudgetUsd: number;
  };
  session: {
    enabled: boolean;          // aiSessionEnabled && consent valid
    consentStale: boolean;     // aiSessionEnabled && consent missing or old version
    consentAt: string | null;
    model; budgetUsd; transcriptWindowMin;
  };
}
```
`claude.usable = found && signedIn && !tooOld` is derived in the client. The probe result is cached in memory per app start; `recheck=1` re-runs it (both probes, ≤ 10 s total). The status route never returns the CLI path.

`POST /api/assistant/copilot-mode` `{ mode, accept?: true, ack?: true }`:
- `off` / `local` → write mode; delete nothing (consents are kept so switching back needs no re-consent while the version matches).
- `claude` → requires `accept:true` (400 otherwise) and a usable Claude Code (409 "Claude Code is not available."); writes mode + `aiCopilotConsent {acceptedAt, version: AI_COPILOT_CONSENT_VERSION}`.
- `always` → requires `accept:true` and `ack:true`; writes mode + consent + `aiCopilotAlwaysAck`.
- Responds with the full status.

`POST /api/assistant/enable {accept:true}` → 400 without accept; 409 when Claude Code is not usable; writes `aiSessionEnabled:true`, `aiConsent {acceptedAt, version: AI_SESSION_CONSENT_VERSION}`. `POST /api/assistant/disable` → `aiSessionEnabled:false`, deletes `aiConsent`. Both respond with the status.

Constants (`server/src/services/assistantState.ts`): `AI_SESSION_CONSENT_VERSION = 1`, `AI_COPILOT_CONSENT_VERSION = 1`, `AI_MIN_CLAUDE_VERSION = '2.1.318'`. Bumping a consent version is the only way to force the modal again for existing users.

## 4. Claude Code detection (Windows x64, macOS arm64/x64)

### 4.1 Resolver `resolveClaudeCli()` (server/src/services/claudeCli.ts)
Order, first hit wins, every candidate checked with `fs.access` (X_OK on darwin):
1. `CLAUDE_CLI_PATH` env (absolute path; no further checks).
2. win32: `%USERPROFILE%\.local\bin\claude.exe` (native installer — verified on this machine: `where claude` → `C:\Users\<cyrillic>\.local\bin\claude.exe`, nothing in `%APPDATA%\npm`), then `%APPDATA%\npm\claude.cmd` (npm global; needs `cmd.exe /d /s /c` to spawn), then the first `.exe` line of `where claude`.
3. darwin: `~/.local/bin/claude` (native installer), `/opt/homebrew/bin/claude`, `/usr/local/bin/claude` (npm global symlinks), then `which claude`.
4. Nothing → `{ found:false }`.
Spawn rules (from AUG-193 D9, unchanged): `path.join` only, `windowsHide:true`, absolute path works for a Cyrillic user dir, `toSafePath` not needed, `--mcp-config` built with `JSON.stringify`.

### 4.2 Probe (`probeClaudeCli()`), cached per app start, re-run on Recheck
1. `claude --version` → stdout `2.1.318 (Claude Code)`; parse `/^(\d+\.\d+\.\d+)/`; exit 0. Measured 55 ms warm. Timeout 10 s (cold Node start on a laptop can take seconds). Non-zero exit / timeout → `found:false`.
2. `claude auth status` (JSON is the default output; `--json` / `--text` flags exist in 2.1.318). Measured 352 ms, exit 0:
   ```json
   { "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
     "loginExpiresAt": "2026-11-12T01:40:13.708Z", "email": "…", "orgName": "…", "subscriptionType": "max",
     "configDirectory": "C:\\Users\\…\\.claude", "projectsDirectory": "…" }
   ```
   `signedIn = parsed.loggedIn === true`. Non-zero exit, unparsable output or `loggedIn !== true` → `signedIn:false`. "Unknown command" (the `auth` subcommand is missing on older builds) → `tooOld:true`. The logged-out output was not captured (it would require logging this machine out); the implementation task must verify it once with `claude auth logout` on a scratch profile (`CLAUDE_CONFIG_DIR`) and record the exact JSON.
   Only `loggedIn`, `authMethod` and the version are logged; `email`, `orgName`, `subscriptionType` are discarded and never reach the UI.
3. Both commands run with `cwd = os.homedir()`, `env` = process env minus `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` (see 4.4), 10 s timeout each, `windowsHide:true`.

### 4.3 Why `claude auth status`, not credential files
- Windows keeps the OAuth record in `~/.claude/.credentials.json` (`claudeAiOauth.{accessToken, refreshToken, expiresAt, subscriptionType}` — verified), macOS keeps it in the Keychain (item "Claude Code-credentials", known from Claude Code docs — not verified here), so a file check is not cross-platform and would miss refresh logic.
- `~/.claude.json` has `oauthAccount` (profile cache) but it is not cleared on logout in a verifiable way → rejected.
- `auth status` is the CLI's own answer, handles token refresh and expiry (`loginExpiresAt`), and costs 0.35 s.

### 4.4 Billing goes to the login, not to an API key
Claude Code prefers `ANTHROPIC_API_KEY` from the environment when set; a user with a global key would be billed per token instead of their plan, contradicting the consent text. The spawn env for every August child (probe and sessions) therefore deletes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`. `--bare` is not used (it is API-key-only auth, AUG-193). An `apiKeyHelper` in the user's own `~/.claude/settings.json` is their explicit choice and is left alone.

### 4.5 macOS PATH and environment
- `ensureToolPaths()` in `electron/src/main.ts` adds `/opt/homebrew/bin` and `/usr/local/bin`; extend it with `path.join(os.homedir(), '.local', 'bin')` (native installer default). Stays darwin-only (`process.platform !== 'darwin' → return`).
- The child needs `HOME` (for `~/.claude`) — inherited from the GUI process; a Launch-Services-started app has it.
- Open question carried over from AUG-193: whether the Keychain credential is readable from a child of a GUI app without a prompt [UNVERIFIED — prototype on a Mac before implementation; if a prompt appears, the status row must say "Allow access in the Keychain prompt, then press Recheck"].
- Windows needs no PATH change: the native installer writes `%USERPROFILE%\.local\bin` to the user PATH, and the resolver tries that folder directly anyway.

### 4.6 PraxisOS reachability
`GET http://127.0.0.1:7865/health` is tokenless and answers in < 50 ms:
```json
{"status":"ok","service":"praxis-local-api","version":"0.1.0","api_version":"144","claude_available":true,"default_model":"sonnet","mcp_available":true,"mcp_http":true}
```
(`/api/*`, `/mcp` and `/` answer 401 without a token; `/stream` 406 — the MCP transport, used later by the copilot.) `praxis.reachable = status 200 && body.status === 'ok'`, timeout 1.5 s, no retries. Praxis's own `claude_available` is ignored: August must judge the CLI from the same process that will spawn it.

## 5. What the Settings row shows in each case

| Probe result | Claude Code row | Copilot Claude modes | Active session toggle |
|---|---|---|---|
| found, signed in, ≥ min | `Signed in · 2.1.318` | selectable | enabled |
| found, not signed in | `Installed, not signed in` + hint + Recheck | disabled | disabled, hint "Needs Claude Code — see Status above." |
| not found | `Not installed` + hint + Recheck | disabled | disabled |
| found, `auth` unknown | `Too old (x.y.z) — update it` + hint + Recheck | disabled | disabled |
| probe running | `Checking…` | as last known | as last known |

## 6. Rejected while researching
- Per-row Claude Code hints under both the copilot and the session (AUG-193 draft): duplicated text and two Recheck buttons → one Status section.
- Showing the signed-in e-mail or plan in Settings: not needed for any decision and leaks account data into screenshots.
- Tighter tab padding / renaming the tab to fit 600 px: user chose the wider card (680 px) instead.
- Claude modes selectable with a warning while Claude Code is unusable: user chose disabled-but-visible.
- Reading `.credentials.json` for the sign-in check: Windows-only.
- Letting PATCH write `aiCopilotMode`: would allow a Claude mode without a consent record.
- A "Recheck" that also restarts PraxisOS: August does not manage the Praxis process.

## 7. User decisions (2026-11-06, mockup review)
1. Design approved as in `ai-assistants-tab.html` with one change: both spending limits are **free number fields** (any amount in USD, committed on change), **0 = no limit** (no `--max-budget-usd`). A dropdown of preset amounts was rejected the same day.
2. Settings card width 680 px for all tabs (not tighter tabs, not a shorter label).
3. Claude copilot modes are disabled but visible while Claude Code is unusable.
Implementation task: see the AUG-194 card and the M4 roadmap line.
