# User Preferences Domain

## TL;DR
- User preferences persist as a flat JSON file at server/data/user-preferences.json with GET/PATCH/DELETE REST endpoints.
- All 13 preference fields are optional; the client applies defaults when absent from the server response.
- systemAudioSource ('auto' | 'browser' | 'system', default 'auto') chooses HOW system audio is captured; the systemAudio boolean stays the on/off switch.
- systemAudio defaults to true in DEFAULT_PREFERENCES; FileUpload's initial toggle reads that same constant so Settings and the record screen never disagree when the key is unsaved.
- The System (direct) option is disabled when systemCapture is false or selfTest is 'failed'; it stays enabled on 'silent'.
- On Windows the WASAPI loopback helper makes System (direct) available on Bluetooth/USB headsets without Stereo Mix or VB-Cable (AUG-112).
- Settings never shows probe internals (method, dB levels, stderr); self-test detail stays in the server log and npm run capture:check.
- Under System Audio Source the modal prints at most one plain-language line: direct capture unavailable, or a Windows test-before-a-call warning.
- FileUpload auto-saves language, mic, and system audio preferences on change via PATCH /api/preferences.
- The Settings modal displays and edits all preferences, accessible from the sidebar hamburger menu.
- Theme toggle remains in localStorage and is explicitly excluded from the preferences system.
- migrateLegacyPreferences() in server/src/services/preferencesStore.ts moves a legacy server/src/data/user-preferences.json to server/data/ once on server start.
- Runtime preferences must never live under server/src or be tracked in git; the path comes from config.dataDir.

Persistence layer for user preferences across sessions — auto-saves choices and provides a Settings UI for review/reset.

## Purpose

Eliminate repeated manual re-configuration every app session. Before this system, users had to re-select language, mic device, system audio toggle, recording mode, and other settings on every launch. The preferences API stores these choices server-side as a JSON file and the client loads them on startup.

## Core Concepts

- Preferences file: server/data/user-preferences.json — a flat JSON object, created on first PATCH, deleted on reset. The path is derived from config.dataDir (server/src/config.ts), the same root as sessions, uploads, captures, and perf-stats.json.
- Legacy migration: before AUG-109 the file lived at server/src/data/user-preferences.json and was tracked in git. On every server start, migrateLegacyPreferences() (server/src/services/preferencesStore.ts) moves that file to server/data/ once, removes the old copy, and logs the move. It never overwrites an existing server/data/ file.
- Schema: 13 optional fields (language, micDeviceId, systemAudio, systemAudioSource, recordingMode, liveEngine, audioBoost, retranscriptionLanguage, praxisProjectPath, sidebarCollapsed, sessionSortOrder, skipStopConfirmation, skipClearConfirmation).
- Server allowlist: ALLOWED_KEYS set in the route filters unknown keys from PATCH requests.
- Auto-save: when the user changes language, mic, or system audio in FileUpload, a PATCH request fires immediately.
- Load on startup: App.tsx calls GET /api/preferences on mount and distributes values as props.
- Settings modal: full CRUD UI for all preferences, opened from the sidebar menu gear icon.
- System audio source: Settings > Recording shows a "System Audio Source" dropdown (Auto / Browser (screen picker) / System (direct)) directly under the System Audio toggle.
- Capture hint line: when isSystemCaptureUsable() is false the modal prints "System (direct) is not available on this computer — recordings use the browser screen picker." (neutral).
- Windows warning: when capabilities.platform is 'win32' and the source resolves to 'system' (regardless of the System Audio toggle), the modal prints a yellow warning to make a short test recording and check the other side before an important call.
- No hint line is shown while capabilities are still loading, on macOS with a usable capture, or when the source resolves to browser.
- The System option is disabled when systemCapture is false or selfTest is 'failed'; it stays enabled on 'silent' (the user may have had nothing playing).
- On Windows the status hint names the WASAPI default output device ("WASAPI loopback of the default output ..."), or the matched DirectShow device, or explains Stereo Mix / VB-Cable when neither exists; the wording comes from the server probe, not the client.
- On Windows with the WASAPI helper, a 'silent' self-test means nothing was playing through the default output during the 1 s probe; the System (direct) option stays enabled.
- Source resolution: resolveSystemAudioSource() in client/src/services/preferences.ts maps 'browser' → browser, and 'auto'/'system' → system only when isSystemCaptureUsable() is true (systemCapture true and selfTest not 'failed'), otherwise browser.
- Reset: DELETE /api/preferences removes the file; client reverts to empty object and applies defaults.
- Mic notice: when saved micDeviceId is not found in available devices, a dismissible warning appears.

## Invariants

- All preference fields are optional — the app works identically to before if the file is missing or empty.
- The server never validates field values beyond key membership in ALLOWED_KEYS.
- Theme toggle stays in localStorage — it is not part of the preferences system.
- The preferences file is gitignored (server/data/user-preferences.json; the legacy server/src/data/ path is also ignored as a safety net for old checkouts). Running the app must never dirty the git working tree.
- The legacy migration is idempotent and never overwrites a file already present at server/data/user-preferences.json.
- No database — file-based only, consistent with the local-first architecture.
- PATCH merges into existing data (spread operator) — it never replaces the entire file.
- systemAudioSource never disables system audio — when systemAudio is false, the source field is ignored.
- Without a detected capture method (no WASAPI helper, Stereo Mix or VB-Cable on Windows; no BlackHole or audiotee on macOS), every systemAudioSource value resolves to the browser picker; there is no regression path.
- DELETE removes the file entirely — there is no "partial reset".

## Key Files

- server/src/routes/preferences.ts — GET/PATCH/DELETE /api/preferences endpoints.
- server/src/services/preferencesStore.ts — PREFS_PATH / LEGACY_PREFS_PATH constants and the one-time migrateLegacyPreferences() startup migration.
- client/src/services/preferences.ts — UserPreferences interface, DEFAULT_PREFERENCES, API wrappers.
- client/src/components/SettingsModal.tsx — Settings modal UI component.
- client/src/components/FileUpload.tsx — auto-save integration and mic notice.
- client/src/App.tsx — preferences state management and prop distribution.

## Route-Specific Constraints

- Do not add preferences to a database — the file-based approach is intentional for the local-first MVP.
- Do not migrate the theme toggle to this system — it must remain in localStorage per explicit design decision.
- New preference fields require adding the key to ALLOWED_KEYS in server/src/routes/preferences.ts and to the UserPreferences interface in client/src/services/preferences.ts.
- The Settings modal follows the Necron/brutalist design system (0 border-radius, theme tokens, monospace terminal font).
- Do not put capability detection in the client — the server probe (GET /api/capture/capabilities) is the only source of truth for whether direct system capture works.
- Never resolve the preferences path relative to import.meta.dirname or any src/ directory — always go through config.dataDir so runtime data stays out of the source tree and out of git.
