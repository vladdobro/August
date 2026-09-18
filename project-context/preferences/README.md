# User Preferences Domain

## TL;DR
- User preferences persist as a flat JSON file at server/data/user-preferences.json with GET/PATCH/DELETE REST endpoints.
- All 12 preference fields are optional; the client applies defaults when absent from the server response.
- FileUpload auto-saves language, mic, and system audio preferences on change via PATCH /api/preferences.
- The Settings modal displays and edits all preferences, accessible from the sidebar hamburger menu.
- Theme toggle remains in localStorage and is explicitly excluded from the preferences system.

Persistence layer for user preferences across sessions — auto-saves choices and provides a Settings UI for review/reset.

## Purpose

Eliminate repeated manual re-configuration every app session. Before this system, users had to re-select language, mic device, system audio toggle, recording mode, and other settings on every launch. The preferences API stores these choices server-side as a JSON file and the client loads them on startup.

## Core Concepts

- Preferences file: server/data/user-preferences.json — a flat JSON object, created on first PATCH, deleted on reset.
- Schema: 12 optional fields (language, micDeviceId, systemAudio, recordingMode, liveEngine, audioBoost, retranscriptionLanguage, praxisProjectPath, sidebarCollapsed, sessionSortOrder, skipStopConfirmation, skipClearConfirmation).
- Server allowlist: ALLOWED_KEYS set in the route filters unknown keys from PATCH requests.
- Auto-save: when the user changes language, mic, or system audio in FileUpload, a PATCH request fires immediately.
- Load on startup: App.tsx calls GET /api/preferences on mount and distributes values as props.
- Settings modal: full CRUD UI for all preferences, opened from the sidebar menu gear icon.
- Reset: DELETE /api/preferences removes the file; client reverts to empty object and applies defaults.
- Mic notice: when saved micDeviceId is not found in available devices, a dismissible warning appears.

## Invariants

- All preference fields are optional — the app works identically to before if the file is missing or empty.
- The server never validates field values beyond key membership in ALLOWED_KEYS.
- Theme toggle stays in localStorage — it is not part of the preferences system.
- The preferences file is gitignored (server/data/user-preferences.json).
- No database — file-based only, consistent with the local-first architecture.
- PATCH merges into existing data (spread operator) — it never replaces the entire file.
- DELETE removes the file entirely — there is no "partial reset".

## Key Files

- server/src/routes/preferences.ts — GET/PATCH/DELETE /api/preferences endpoints.
- client/src/services/preferences.ts — UserPreferences interface, DEFAULT_PREFERENCES, API wrappers.
- client/src/components/SettingsModal.tsx — Settings modal UI component.
- client/src/components/FileUpload.tsx — auto-save integration and mic notice.
- client/src/App.tsx — preferences state management and prop distribution.

## Route-Specific Constraints

- Do not add preferences to a database — the file-based approach is intentional for the local-first MVP.
- Do not migrate the theme toggle to this system — it must remain in localStorage per explicit design decision.
- New preference fields require adding the key to ALLOWED_KEYS in server/src/routes/preferences.ts and to the UserPreferences interface in client/src/services/preferences.ts.
- The Settings modal follows the Necron/brutalist design system (0 border-radius, theme tokens, monospace terminal font).
