# Desktop Shell Route

## TL;DR
- August ships as an Electron desktop app (AUG-114) that embeds the unchanged Express server in the main process by importing server/dist/app.js and calling startServer({ port: 0 }).
- The root package.json is the Electron app manifest (main: electron/dist/main.js, version, electron/electron-builder/electron-updater deps); electron/ holds only main-process source, preload, builder config and build assets.
- The renderer is the same React client loaded from http://127.0.0.1:<free port>/ served by the embedded server; no IPC replaces REST/WebSocket.
- Packaged builds keep all writable data under the Electron userData folder (Windows %APPDATA%\August, macOS ~/Library/Application Support/August) via AUGUST_DATA_DIR, WHISPER_MODEL_PATH, WHISPER_BIN_PATH and FFMPEG_PATH env vars set before the server module is imported.
- whisper-cli, ffmpeg and ffprobe are bundled from whisper/bin/<platform>/ into resources/whisper/bin/ as extraResources; the ~874 MB model is never bundled and auto-downloads on first launch.
- The Windows extraResources folder also carries the bundled Vulkan loader vulkan-1.dll and its VulkanRT-License.txt placed by npm run setup (AUG-117).
- Packaged builds set FFMPEG_PATH to the resources copy of ffmpeg (AUG-115), so a fresh machine needs no ffmpeg install.
- asar is disabled so whisper-cli, ffmpeg, csc.exe and express.static work against real file paths.
- `electron . --dev` (npm run dev:electron) attaches to the Vite dev server (default http://127.0.0.1:5175) and the tsx server on 3001 instead of embedding a server.
- Tray icon states: idle, recording, transcribing; closing the window hides it to the tray and quitting is explicit.
- Global record hotkey default CommandOrControl+Alt+R, persisted in <userData>/desktop-settings.json, configurable in Settings → Desktop.
- Native notifications fire on transcribing → completed/failed transitions detected by the main process polling GET /api/sessions every 5 seconds, and on recording start/stop while the window is hidden.
- Auto-update uses electron-updater against GitHub Releases (vladdobro/August); Windows nsis and macOS zip targets update, msi and dmg do not.
- Key files: electron/src/main.ts, electron/src/preload.cts, electron/src/tray.ts, electron/src/hotkey.ts, electron/src/sessionWatcher.ts, electron/src/updater.ts, electron/electron-builder.yml, server/src/app.ts, client/src/desktop.d.ts.

This route documents how August's Electron desktop shell embeds the existing web app instead of replacing it.

## Purpose

A desktop shell exists so non-technical users get a one-click install with no terminal or Node.js setup, plus native affordances a browser tab cannot offer: a tray icon, a global record hotkey, and native OS notifications. The Express server was kept intact rather than rebuilt on Electron IPC to minimize migration risk and keep one codebase serving both the web and desktop builds.

## Core Concepts

- Main process: the Electron Node.js process that starts the embedded server, owns the tray, hotkey, settings store, session watcher and updater.
- Preload bridge: `window.august`, exposed under contextIsolation and sandbox, implemented in electron/src/preload.cts and typed in client/src/desktop.d.ts.
- Embedded server: the startServer export in server/src/app.ts; server/src/index.ts stays a thin CLI wrapper around it.
- Dev renderer mode: the --dev flag that points the shell at the Vite dev server and the tsx server on 3001 instead of embedding a server.
- Desktop settings store: <userData>/desktop-settings.json, holding shell-only settings such as the hotkey.
- Session watcher: the main-process poller that detects session state transitions for notifications.
- Tray: the persistent tray icon reflecting idle, recording and transcribing states.
- Global hotkey: the OS-level shortcut that toggles recording regardless of window focus.
- Auto-updater: electron-updater checking GitHub Releases for new versions.
- Smoke test: AUGUST_SMOKE_TEST=1 prints SMOKE_OK and exits after the first renderer load, for CI verification.

## Invariants

- The Express server must never be refactored into Electron IPC; the renderer talks to it over HTTP/WebSocket exactly as the browser does.
- process.env.NODE_ENV, AUGUST_DATA_DIR, WHISPER_MODEL_PATH, WHISPER_BIN_PATH and FFMPEG_PATH must be set before the server module is dynamically imported, because server/src/config.ts reads them at module load.
- The embedded server always listens on a free port (port 0) so a desktop instance never collides with a dev server on 3001.
- Only `startServer` from server/src/app.ts is imported by the shell; server/src/index.ts must stay a thin CLI wrapper that calls it and exits on failure.
- The preload API surface (`window.august`) is defined in client/src/desktop.d.ts and implemented in electron/src/preload.cts; the two must change together.
- Every renderer call to window.august must be guarded, because the browser build has no bridge.
- The renderer owns MediaRecorder; the shell only forwards toggle requests (august:toggle-recording) and receives recording state (august:recording-state) for the tray.
- The desktop toggle is consumed by FileUpload exactly once per request (desktopToggleRequest + onDesktopToggleHandled) so remounts never replay a start.
- backgroundThrottling is disabled on the window so a recording continues at full rate while hidden in the tray.
- The window hides on close; the app quits only via tray Quit, Cmd+Q or app.quit().
- The hotkey must contain at least one modifier; a failed registration keeps the previous shortcut and reports the error to Settings.
- Session notifications are derived by polling; the first poll only seeds state so pre-existing completed sessions never notify.
- macOS GUI apps do not inherit the shell PATH, so the shell appends /opt/homebrew/bin and /usr/local/bin before starting the server (audiotee and the ffmpeg PATH fallback).
- The bundled ffmpeg must stay inside whisper/bin/<platform>/ so the existing extraResources entry ships it without any electron-builder change.
- Unpackaged runs (npm run electron:start, --dev) leave FFMPEG_PATH unset so the server's own resolver finds the repo's whisper/bin/<platform>/ffmpeg or falls back to PATH.
- getDisplayMedia needs setDisplayMediaRequestHandler in Electron: Windows supplies system audio as a loopback track; macOS uses the native picker on 15+ and otherwise returns video only, so server-side capture stays the preferred macOS path.
- Chromium memory hygiene: spare renderer, media router, translate, webgl, spellcheck, plugins disabled; do not re-enable without a reason.
- electron/build/ is force-included in git (.gitignore negation) because electron-builder needs icon.png and tray PNGs at build time; regenerate with npm run electron:icons, never hand-edit.
- App and tray icons use square corners by design (brand rule: no border radius).

## Key implementation details

- Scripts: dev:electron, electron:start, electron:pack, electron:dist, electron:icons, build.
- userData layout: data/, whisper/models/, desktop-settings.json, logs/main.log.
- resources layout: whisper/bin/<platform>/ holds whisper-cli plus ffmpeg and ffprobe, all signed by electron-builder along with the app.
- electron-builder targets: mac dmg+zip per arch, win nsis+msi x64.
- Signing env vars: CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.
- Unsigned macOS builds are ad-hoc signed by the afterPack hook electron/scripts/afterPack.cjs; Apple Silicon shows a re-packaged unsigned app as "damaged" and xattr cannot fix that.
- Ad-hoc signed macOS apps show the "unverified developer" Gatekeeper prompt; users bypass it with right-click → Open, Privacy & Security → Open Anyway, or xattr -cr on the app.
- The release workflow exports CSC_LINK and Apple credentials only when the secrets are non-empty; an empty CSC_LINK makes electron-builder abort with "not a file".
- electron-builder never replaces existing GitHub release assets; a rerun of the same tag uploads nothing, so fixes need a version bump and a new tag (or manual asset deletion).
- The default GITHUB_TOKEN is read-only; the release workflow declares permissions contents: write so electron-builder can create the release.
- The packaged app must exclude server/node_modules/.bin: its symlinks point into excluded dev packages and a dangling symlink aborts the macOS build.
- Release runs via .github/workflows/release.yml on v* tags with --publish always; the version source is the root package.json.

## Key files

- electron/src/main.ts — main-process entry: window creation, server bootstrap, lifecycle wiring.
- electron/src/preload.cts — implements the window.august bridge exposed to the renderer.
- electron/src/tray.ts — tray icon creation and idle/recording/transcribing state updates.
- electron/src/hotkey.ts — global record hotkey registration, validation and persistence.
- electron/src/sessionWatcher.ts — polls GET /api/sessions to detect state transitions for notifications.
- electron/src/updater.ts — electron-updater wiring against GitHub Releases.
- electron/src/settings.ts — reads/writes <userData>/desktop-settings.json.
- electron/src/log.ts — writes <userData>/logs/main.log.
- electron/scripts/make-icons.mjs — regenerates electron/build/ icons; the only supported way to update them.
- electron/electron-builder.yml — electron-builder configuration: targets, extraResources, appId.
- electron/build/entitlements.mac.plist — macOS entitlements for the signed/notarized build.
- server/src/app.ts — exports startServer(), imported directly by the shell.
- client/src/desktop.d.ts — TypeScript surface for window.august, mirrored by preload.cts.
- client/src/services/desktop.ts — renderer-side helper wrapping window.august calls.
- README.md (root) — project overview covering both the web and desktop builds.
- .github/workflows/release.yml — builds and publishes installers to GitHub Releases on v* tags.

## Route-Specific Constraints

- No third-party inference in the shell either — the embedded server still runs whisper-cli locally.
- Do not add Electron IPC endpoints that duplicate REST routes.
- Do not bundle the whisper model.
- Do not enable asar.
- Keep electron-updater's feed pointing at GitHub Releases.
- Do not store desktop settings in server user-preferences.json — the main process needs them before the server is up.
