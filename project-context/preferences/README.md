# User Preferences Domain

## TL;DR
- User preferences persist as a flat JSON file at server/data/user-preferences.json with GET/PATCH/DELETE REST endpoints.
- All 27 client preference fields are optional; the client applies defaults when absent from the server response. The server-only fields llmEnabled and llmModel (AUG-162) follow the same rule: absent means off and the default model. The server-only groqTextEnabled and groqTextConsent (AUG-164) follow the same rule: absent means the online text correction is off.
- praxisProjects (array of path, name, isDefault, optional prompt) and praxisDefaultPrompt (string or null) hold the multi-project Praxis setup (AUG-142).
- The legacy praxisProjectPath key stays in ALLOWED_KEYS for backward compatibility only; it is folded into praxisProjects and removed.
- migratePraxisProjects() in preferencesStore.ts turns a legacy praxisProjectPath into the first project, named after the folder basename, default if none is default.
- readPreferencesMigrated() runs the migration on every GET and PATCH of /api/preferences and on each Praxis export, writing the file only when something changed.
- The Praxis migration therefore happens at app start, before the Settings modal is ever opened.
- sanitizePraxisProjects() runs on every PATCH: it drops entries without a path, trims values, dedupes by resolved path case-insensitively, and keeps at most one default.
- Removing the default Praxis project promotes the first remaining project to default.
- systemAudioSource ('auto' | 'browser' | 'system', default 'auto') chooses HOW system audio is captured; the systemAudio boolean stays the on/off switch.
- systemAudio defaults to true in DEFAULT_PREFERENCES; FileUpload's initial toggle reads that same constant so Settings and the record screen never disagree when the key is unsaved.
- The System (direct) option is disabled when systemCapture is false or selfTest is 'failed'; it stays enabled on 'silent'.
- On Windows the WASAPI loopback helper makes System (direct) available on Bluetooth/USB headsets without Stereo Mix or VB-Cable (AUG-112).
- Settings never shows probe internals (method, dB levels, stderr); self-test detail stays in the server log and npm run capture:check.
- Under System Audio Source the modal prints at most one plain-language line: direct capture unavailable, or a Windows test-before-a-call warning.
- FileUpload auto-saves language, mic, and system audio preferences on change via PATCH /api/preferences.
- The Settings modal displays and edits all preferences, accessible from the ControlsPanel Settings item (right overlay; the sidebar hamburger was removed in AUG-160).
- The Settings modal has five tabs: General (Interface, Confirmations, Desktop), Audio (Recording), Transcription, Projects, and Compact mode (AUG-156).
- The old Integration section with a single Praxis path is gone; Praxis projects are managed on the Projects tab.
- The Projects tab is a master-detail page (list left, editor right) that autosaves every edit on blur; there is no Add form or project cards.
- Settings modal width is min(600px, 100%).
- Settings modal is top-anchored, not vertically centered (AUG-159): `.settings-backdrop` uses `place-items: start center` with `padding-top: 7.5vh` (5vh at ≤768px), so switching tabs only moves the bottom edge; re-centering brings back the "jumping" top edge.
- Theme toggle remains in localStorage and is explicitly excluded from the preferences system.
- migrateLegacyPreferences() in server/src/services/preferencesStore.ts moves a legacy server/src/data/user-preferences.json to server/data/ once on server start.
- Runtime preferences must never live under server/src or be tracked in git; the path comes from config.dataDir.
- Settings modal Transcription section includes a read-only GPU/CPU engine status block with left-border accent styling.
- On Windows with NVIDIA GPU detected, Settings shows a CPU/GPU(NVIDIA) engine dropdown; gpuEngine persists via PATCH /api/preferences.
- autoDeleteWav (boolean, default false) and autoDeleteWavThreshold (50–95 step 5, default 70) back the Settings → Transcription toggle "Delete audio.wav after transcription" and its "Minimum confidence" slider; the server reads them when a transcription completes to decide whether the converted WAV is removed (AUG-152).
- Compact Mode prefs (AUG-156): compactEnabled (default true), compactMode 'follow'|'indicator'|'transcript' (follow), compactIndicatorWidget 'dock-square'|'ghost-coin' (dock-square), compactTranscriptWidget 'dock-strip'|'ghost-caption' (dock-strip), compactAlwaysOnTop (true), compactExpandOn 'stop'|'click' (stop), compactStripWidth 280–520 (360), compactCaptionHeight 72–480 (112, set by dragging the Ghost Caption edge), compactHintSeen (false) back Settings → Compact mode; compactHintSeen lives here, not localStorage, because the packaged renderer origin port changes every launch.
- llmEnabled (boolean, default false) and llmModel ('qwen2.5-1.5b-instruct-q4km' default | 'qwen2.5-3b-instruct-q4km') hold the opt-in local language model (AUG-162); they are written only by POST /api/llm/enable and /disable, are not in ALLOWED_KEYS (PATCH /api/preferences ignores them) and are not part of the client UserPreferences — Settings reads them from GET /api/llm/status.
- groqTextEnabled (boolean, default false) and groqTextConsent ({acceptedAt ISO, keyFingerprint = first 16 hex of sha256(GROQ_API_KEY)}) hold the opt-in Online text correction (Groq) (AUG-164); written only by POST /api/groq-text/enable ({accept:true}, 409 without a key) and /disable (which also deletes the consent); not in ALLOWED_KEYS and not part of the client UserPreferences — Settings reads GET /api/groq-text/status. The feature is active only while the fingerprint matches the current key, so a changed key or DELETE /api/preferences means the consent is shown again.
- Settings → Transcription shows a "Model folder" row (path, Change…, Use default; read-only when LLM_ROOT is set) and the confirmation names that folder and warns when free space is below the model size (AUG-162).
- Settings → Transcription has a "Local language model" toggle (off by default) and a model dropdown whose hint shows disk size, memory and quality; turning it on, or picking another model while on, opens a two-point confirmation (A: download size, B: RAM/VRAM) and nothing downloads until "Download and enable" is pressed (AUG-162).
- llmCorrections (boolean, default false, AUG-163) backs the Settings → Transcription checkbox 'Allow the model to correct text by meaning', shown directly under the 'Local language model' toggle only while the model is on; when true, batch transcriptions send flagged segments to the local model (or to Groq per batchCorrectionEngine, AUG-164) and store suggestions in transcript.corrected.json; it is in ALLOWED_KEYS and coerced to a strict boolean.
- batchCorrectionEngine ('local' default | 'groq', AUG-164) picks who fixes flagged lines after a recording when both llmCorrections (local model on) and Online text correction (Groq) are on; Settings → Transcription shows it as the dropdown 'Fixes after recording by' only in that case; in ALLOWED_KEYS, any other value is dropped from the patch.
- Also known as: user preferences, settings persistence, user-preferences.json, Settings modal, auto-delete WAV setting, confidence threshold slider (AUG-152), Compact mode settings, compact preferences (AUG-156), local language model toggle, llmEnabled, llmModel (AUG-162), online text correction toggle, Groq consent, groqTextEnabled, groqTextConsent (AUG-164), meaning corrections checkbox, llmCorrections (AUG-163), batchCorrectionEngine, 'Fixes after recording by' (AUG-164).

Persistence layer for user preferences across sessions — auto-saves choices and provides a Settings UI for review/reset.

## Purpose

Eliminate repeated manual re-configuration every app session. Before this system, users had to re-select language, mic device, system audio toggle, recording mode, and other settings on every launch. The preferences API stores these choices server-side as a JSON file and the client loads them on startup.

## Core Concepts

- Preferences file: server/data/user-preferences.json — a flat JSON object, created on first PATCH, deleted on reset. The path is derived from config.dataDir (server/src/config.ts), the same root as sessions, uploads, captures, and perf-stats.json.
- Legacy migration: before AUG-109 the file lived at server/src/data/user-preferences.json and was tracked in git. On every server start, migrateLegacyPreferences() (server/src/services/preferencesStore.ts) moves that file to server/data/ once, removes the old copy, and logs the move. It never overwrites an existing server/data/ file.
- Schema: 29 optional fields (language, micDeviceId, systemAudio, systemAudioSource, recordingMode, liveEngine, audioBoost, retranscriptionLanguage, praxisProjectPath (legacy), praxisProjects, praxisDefaultPrompt, sidebarCollapsed, sessionSortOrder, skipStopConfirmation, skipClearConfirmation, gpuEngine, autoDeleteWav, autoDeleteWavThreshold, compactEnabled, compactMode, compactIndicatorWidget, compactTranscriptWidget, compactAlwaysOnTop, compactExpandOn, compactStripWidth, compactCaptionHeight, compactHintSeen, llmCorrections, batchCorrectionEngine), plus the server-only llmEnabled and llmModel written by /api/llm (AUG-162), and the server-only groqTextEnabled and groqTextConsent written by /api/groq-text (AUG-164).
- readPreferences and writePreferences live in server/src/services/preferencesStore.ts; the route has no private file helpers.
- Server allowlist: ALLOWED_KEYS set in the route filters unknown keys from PATCH requests.
- Auto-delete controls (AUG-152): Settings → Transcription shows the "Delete audio.wav after transcription" toggle after Retranscription Language; only while it is on, a "Minimum confidence" range input (50–95, step 5) appears, followed by a hint whose text changes with the toggle state.
- Slider commit: SettingsModal keeps a local thresholdDraft while dragging and PATCHes autoDeleteWavThreshold on mouse/touch/key release or blur, and only when the value changed, so one drag is one write (AUG-152).
- Compact strip width slider uses the same draft-then-commit pattern as the confidence slider; the main process also PATCHes compactStripWidth (via the renderer's strip-width event) when the user resizes the Dock Strip within 280–520 (AUG-156).
- Auto-save: when the user changes language, mic, or system audio in FileUpload, a PATCH request fires immediately.
- Load on startup: App.tsx calls GET /api/preferences on mount and distributes values as props.
- Settings modal: full CRUD UI for all preferences, opened from the ControlsPanel Settings item (⚙).
- Projects tab (client/src/components/PraxisProjectsPage.tsx) is master-detail: a 210px listbox on the left, an editor on the right, each scrolling independently.
- The Settings card gets settings-card--projects (85vh) and settings-body--projects (no padding, no outer scroll) while the Projects tab is open.
- The list pins "Default settings" first (badge "custom" when praxisDefaultPrompt is set), then one item per project; "+ Add project" under the list opens new mode.
- A project list item shows the name, Default / prompt / "!" (missing .praxis/) badges and the path.
- Initial selection on the Projects tab is the default project, else "Default settings".
- The "Default settings" editor has variable chips, a full-height textarea, Reset to built-in (sets praxisDefaultPrompt to null) and a Built-in/Custom status.
- The project editor has Name, an editable Path with Browse, a "Use as default project" checkbox (disabled when already default), a Reachable/Missing badge and Remove project.
- The project editor Prompt label carries a "custom · use default" link that drops the per-project prompt; the textarea is full height with variable chips.
- The Missing badge appears when POST /api/praxis/validate finds no .praxis/ directory at the project path.
- Editing a project path validates it on blur via POST /api/praxis/validate and replaces the entry, keeping name, isDefault and prompt.
- A project path is saved even when .praxis/ is missing (the Missing badge shows it); a path already used by another project is refused with an inline error.
- New project mode takes an optional Name and a Path typed or chosen with Browse; Cancel returns to the previous selection.
- Add project in new mode validates first, refuses a missing .praxis/ or a duplicate path, and selects the new project on success.
- All Projects tab edits autosave on blur via PATCH /api/preferences; a "Saved" label flashes in the editor header for 1.5 s after every save.
- Variable chips {sessionName}, {date}, {duration} insert the token at the textarea cursor; chips use onMouseDown preventDefault so the textarea keeps focus.
- ArrowUp/ArrowDown on the focused list move the selection through "Default settings" and the projects.
- Escape in any editor input or textarea returns focus to the list without closing the modal (stopPropagation).
- At widths of 560px and below the project list stacks above the editor.
- SettingsDropdown (client/src/components/SettingsDropdown.tsx) is the shared dropdown for SettingsModal and PraxisModal, with an optional per-option sublabel and a placeholder prop.
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
- On Windows with NVIDIA GPU detected, Settings Transcription shows an interactive CPU/GPU(NVIDIA) dropdown that calls POST /api/engine/switch; CUDA download progress streams via SSE.
- When GPU selected, CUDA present and gpuBackend is 'cuda', Settings shows the green "Transcription runs on GPU" block; with gpuBackend 'cpu' a yellow hint says the GPU could not be used (AUG-140); when CPU selected with NVIDIA detected, a yellow hint suggests switching.
- On macOS or Windows without NVIDIA, Transcription shows the existing read-only engine status block (.settings-engine-status).
- Engine status block uses left-border accent: 3px solid --gpu-color (green) for GPU, 3px solid --cpu-fallback-color (yellow) for CPU fallback.
- Plain language only in the engine status block — no backend names (Vulkan/CUDA/Metal), device IDs, or method names shown to users.

## Components

- preferencesStore (component): part of the August server; readPreferences is used by the sessions route's autoDeleteWavIfConfident and by semanticCheck (llmCorrections, batchCorrectionEngine, Groq consent) at transcription completion (AUG-152, AUG-163, AUG-164).
- SettingsModal (component): part of the August client; owns the auto-delete toggle and the threshold slider (AUG-152).
- sanitizeCompactPreferences (component): part of preferencesStore; called by the preferences route on every PATCH (AUG-156).
- llm route (component): part of the August server; the only writer of llmEnabled and llmModel (AUG-162).
- groqText route (component): part of the August server; the only writer of groqTextEnabled and groqTextConsent (AUG-164).

## Invariants

- All preference fields are optional — the app works identically to before if the file is missing or empty.
- The server never validates field values beyond key membership in ALLOWED_KEYS, except that praxisProjects is always normalized by sanitizePraxisProjects(), autoDeleteWav is coerced to a strict boolean, llmCorrections is coerced to a strict boolean (AUG-163), batchCorrectionEngine keeps only 'local' or 'groq' (AUG-164), and autoDeleteWavThreshold is rounded and clamped to 50–95 (a non-numeric value is dropped from the patch) (AUG-152); sanitizeCompactPreferences() makes compactEnabled/compactAlwaysOnTop/compactHintSeen strict booleans, drops unknown compactMode/compactIndicatorWidget/compactTranscriptWidget/compactExpandOn values and rounds/clamps compactStripWidth to 280–520 (AUG-156) and compactCaptionHeight to 72–480. llmEnabled/llmModel are outside ALLOWED_KEYS; /api/llm/enable validates llmModel against LLM_MODELS (AUG-162). groqTextEnabled/groqTextConsent are outside ALLOWED_KEYS (AUG-164).
- Online text correction runs only with a valid consent: groqTextEnabled === true and groqTextConsent.keyFingerprint equal to the fingerprint of the current GROQ_API_KEY (AUG-164); disable deletes the consent, so turning it on always shows the consent modal.
- Theme toggle stays in localStorage — it is not part of the preferences system.
- The preferences file is gitignored (server/data/user-preferences.json; the legacy server/src/data/ path is also ignored as a safety net for old checkouts). Running the app must never dirty the git working tree.
- The legacy migration is idempotent and never overwrites a file already present at server/data/user-preferences.json.
- No database — file-based only, consistent with the local-first architecture.
- PATCH merges into existing data (spread operator) — it never replaces the entire file.
- systemAudioSource never disables system audio — when systemAudio is false, the source field is ignored.
- Without a detected capture method (no WASAPI helper, Stereo Mix or VB-Cable on Windows; no bundled or PATH audiotee and no BlackHole on macOS — run npm run setup to build the bundled audiotee), every systemAudioSource value resolves to the browser picker; there is no regression path.
- The local LLM folder is deliberately NOT a preference: it lives in <dataDir>/llm-location.json, so DELETE /api/preferences (Reset to Defaults) keeps it and downloaded models are never orphaned (AUG-162).
- llmEnabled is the single source of truth for the local language model: the server reads it from user-preferences.json on every use, so DELETE /api/preferences turns the model off and also stops a running llama-server (AUG-162).
- DELETE removes the file entirely — there is no "partial reset"; it also stops a running llama-server (AUG-162).
- The auto-delete decision reads user-preferences.json at transcription completion, so changing the toggle or threshold affects the next completion, never a session that already finished (AUG-152).

## Key Files

- server/src/routes/preferences.ts — GET/PATCH/DELETE /api/preferences endpoints.
- server/src/services/preferencesStore.ts — PREFS_PATH / LEGACY_PREFS_PATH constants, migrateLegacyPreferences() startup migration, readPreferences/writePreferences, migratePraxisProjects(), readPreferencesMigrated(), sanitizePraxisProjects(), sanitizeCompactPreferences() (AUG-156).
- server/src/services/preferencesStore.test.ts — tests for the Praxis project migration and sanitizing.
- client/src/services/preferences.ts — UserPreferences interface, DEFAULT_PREFERENCES, API wrappers.
- client/src/components/SettingsModal.tsx — Settings modal UI component with the General, Audio, Transcription, Projects and Compact mode tabs; Transcription holds the auto-delete toggle and threshold slider (AUG-152) and the Local language model toggle, model dropdown and download confirmation (AUG-162).
- server/src/routes/llm.ts — writes llmEnabled/llmModel on enable/disable (AUG-162).
- server/src/routes/groqText.ts — writes groqTextEnabled/groqTextConsent on enable/disable (AUG-164).
- client/src/components/GroqTextConsentModal.tsx — consent modal for the Online text correction toggle (AUG-164).
- client/src/components/PraxisProjectsPage.tsx — Projects tab: master-detail list and editor for the default prompt, projects, paths and per-project prompts.
- client/src/components/SettingsDropdown.tsx — shared dropdown with optional sublabel and placeholder, used by SettingsModal and PraxisModal.
- client/src/components/FileUpload.tsx — auto-save integration and mic notice.
- client/src/App.tsx — preferences state management and prop distribution.

## Route-Specific Constraints

- Do not add preferences to a database — the file-based approach is intentional for the local-first MVP.
- Do not migrate the theme toggle to this system — it must remain in localStorage per explicit design decision.
- New preference fields require adding the key to ALLOWED_KEYS in server/src/routes/preferences.ts and to the UserPreferences interface in client/src/services/preferences.ts.
- Any write of praxisProjects must go through sanitizePraxisProjects(); never persist the array unsanitized.
- Never write praxisProjectPath from new code; it is read-only legacy input for migratePraxisProjects().
- The Settings modal follows the Necron/brutalist design system (0 border-radius, theme tokens, monospace terminal font).
- Do not put capability detection in the client — the server probe (GET /api/capture/capabilities) is the only source of truth for whether direct system capture works.
- Never resolve the preferences path relative to import.meta.dirname or any src/ directory — always go through config.dataDir so runtime data stays out of the source tree and out of git.
