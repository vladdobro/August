# Desktop Shell Route

## TL;DR
- August ships as an Electron desktop app (AUG-114) that embeds the unchanged Express server in the main process by importing server/dist/app.js and calling startServer({ port: 0 }).
- The root package.json is the Electron app manifest (main: electron/dist/main.js, version, electron/electron-builder/electron-updater deps); electron/ holds only main-process source, preload, builder config and build assets.
- App version source of truth is the root `version` file; npm run build syncs it into package.json via version:sync.
- The renderer is the same React client loaded from http://127.0.0.1:<free port>/ served by the embedded server; no IPC replaces REST/WebSocket.
- Packaged macOS builds keep session data in ~/Library/Application Support/August/data, never inside August.app, because the signed bundle is replaced on every update/reinstall (AUG-121).
- Packaged Windows builds keep session data in <install dir>/data next to the per-user NSIS install; models, settings and logs stay under userData on both platforms; paths reach the server via AUGUST_DATA_DIR, WHISPER_MODEL_PATH, WHISPER_BIN_PATH and FFMPEG_PATH set before the server module is imported.
- Packaged builds override globalThis.fetch with electron.net.fetch before importing the server module; Node.js undici does not respect system proxy, certificates or firewall (AUG-138).
- whisper-cli, ffmpeg and ffprobe are bundled from whisper/bin/<platform>/ into resources/whisper/bin/ as extraResources; the ~874 MB model is never bundled and auto-downloads on first launch.
- The Windows extraResources folder also carries the bundled Vulkan loader vulkan-1.dll and its VulkanRT-License.txt placed by npm run setup (AUG-117).
- Packaged builds set FFMPEG_PATH to the resources copy of ffmpeg (AUG-115), so a fresh machine needs no ffmpeg install.
- asar is disabled so whisper-cli, ffmpeg, csc.exe and express.static work against real file paths.
- `electron . --dev` (npm run dev:electron) attaches to the Vite dev server (default http://127.0.0.1:5175) and the tsx server on 3001 instead of embedding a server.
- Tray icon states: idle, recording, transcribing; closing the window hides it to the tray and quitting is explicit. While compact the tray menu starts with "Expand August" and the tooltip shows the recording timer (AUG-156).
- Global record hotkey default CommandOrControl+Alt+R, persisted in <userData>/desktop-settings.json, configurable in Settings → Desktop.
- Native notifications fire on transcribing → completed/failed transitions detected by the main process polling GET /api/sessions every 5 seconds, and on recording start/stop while the window is hidden.
- Auto-update uses electron-updater against GitHub Releases (vladdobro/August); Windows nsis and macOS zip targets update, msi and dmg do not.
- The tray update item mirrors updater state: Check for Updates… → Checking… → Downloading (N%) → "Restart to Update to x.y.z" (AUG-141).
- The sidebar ≡ menu has the same update item (update menu, AUG-157): "Check for Updates" (idle/error) → "Checking for Updates…" and "Downloading Update v{version} ({percent}%)…" (disabled) → "Restart to Update to v{version}" (calls installNow). It is hidden in the browser build and in unpackaged desktop runs (no updater).
- A manual tray check always notifies the outcome (up to date, downloading, error); background checks notify only when a download is ready.
- "Restart to Update" calls quitAndInstall(silent, forceRun) so the NSIS installer relaunches August; quitting instead installs silently without relaunch.
- A per-machine ("all users") Windows install triggers a UAC prompt during every silent update; that prompt is the installer elevating, not a hang.
- NSIS updates (--updated) skip the model-dir and GPU-engine pages and keep the first-install choices from %APPDATA%/August/.
- Custom NSIS pages must use the customPageAfterChangeDir hook, after the install-mode page: choosing "all users" relaunches the installer elevated and re-shows every page before it.
- Right-click on a sidebar session calls window.august.revealSession(id) over august:reveal-session; main reveals the folder via shell.showItemInFolder (AUG-124).
- The Archive page opens the sessions data dir via window.august.revealSessionsDir() over august:reveal-sessions-dir; main calls shell.openPath(sessionsDir()) and takes no path from the renderer (AUG-150). The method is optional in desktop.d.ts; the browser build shows the path as text.
- Compact Mode (AUG-156): CompactController (electron/src/compact.ts) resizes the main window to a right-edge Dock Strip or a 180×180 Dock Square, or hides it behind a frameless transparent always-on-top ghost window (Ghost Caption / Ghost Coin) loading the same app URL with ?ghost=caption|coin; setCompactMode({ shape: 'none' }) restores the saved bounds, maximized flag and the 960×600 minimum.
- Always-on-top diverges: macOS setAlwaysOnTop(on, 'floating') + setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: true }); Windows setAlwaysOnTop(on) only.
- Also known as: reveal sessions folder, open data directory (AUG-150), Compact Mode, dock strip, dock square, ghost window, ghost caption, ghost coin, setCompactMode (AUG-156).
- Key files: electron/src/main.ts, electron/src/compact.ts, electron/src/preload.cts, electron/src/tray.ts, electron/src/hotkey.ts, electron/src/sessionWatcher.ts, electron/src/updater.ts, electron/electron-builder.yml, server/src/app.ts, client/src/desktop.d.ts.

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
- The renderer owns MediaRecorder; the shell only forwards toggle requests (august:toggle-recording) and receives recording state (august:recording-state) for the tray. Compact state is also renderer-owned: main only applies shapes requested via august:set-compact-mode and forwards expand/strip-width events (AUG-156).
- New bridge methods for Compact Mode are optional in desktop.d.ts and mirrored in preload.cts; ghost-only IPC (august:ghost-ignore-mouse, ghost-resize, ghost-drag) is accepted only from the ghost window's webContents (AUG-156).
- minWidth 960 / minHeight 600 are lowered only while compact and restored on expand (AUG-156).
- august:reveal-session takes only a session ID; the renderer never sends filesystem paths to the main process.
- The main process resolves the session folder as <AUGUST_DATA_DIR or repo server/data>/sessions/<id>, mirroring server/src/config.ts.
- revealSession rejects IDs outside [A-Za-z0-9_-], paths escaping the sessions dir, and missing folders, returning { ok: false, error } without opening anything.
- revealSessionsDir accepts no arguments and only opens the resolved sessions dir; it returns { ok: false, error } when the folder is missing or shell.openPath reports an error.
- In --dev mode the main process assumes the tsx server uses the repo server/data default; a custom AUGUST_DATA_DIR set only in the server's .env is not seen by main.
- The desktop toggle is consumed by FileUpload exactly once per request (desktopToggleRequest + onDesktopToggleHandled) so remounts never replay a start.
- backgroundThrottling is disabled on the window so a recording continues at full rate while hidden in the tray.
- The window hides on close; the app quits only via tray Quit, Cmd+Q or app.quit().
- The hotkey must contain at least one modifier; a failed registration keeps the previous shortcut and reports the error to Settings.
- Session notifications are derived by polling; the first poll only seeds state so pre-existing completed sessions never notify.
- macOS GUI apps do not inherit the shell PATH, so the shell appends /opt/homebrew/bin and /usr/local/bin before starting the server (the audiotee and ffmpeg PATH fallbacks; the packaged app ships its own audiotee in resources/whisper/bin/darwin-<arch>/).
- Windows packaged builds carry a pre-compiled wasapi-loopback.exe in data/tools/ (placed by afterPack); the server's ensureWasapiHelper skips csc.exe compilation when the source hash matches.
- The bundled ffmpeg must stay inside whisper/bin/<platform>/ so the existing extraResources entry ships it without any electron-builder change.
- Unpackaged runs (npm run electron:start, --dev) leave FFMPEG_PATH unset so the server's own resolver finds the repo's whisper/bin/<platform>/ffmpeg or falls back to PATH.
- getDisplayMedia needs setDisplayMediaRequestHandler in Electron: Windows supplies system audio as a loopback track; macOS uses the native picker on 15+ and otherwise returns video only, so server-side capture stays the preferred macOS path.
- Chromium memory hygiene: spare renderer, media router, translate, webgl, spellcheck, plugins disabled; do not re-enable without a reason.
- Packaged builds override globalThis.fetch with electron.net.fetch in startEmbeddedServer() before the server module is imported; Node.js undici does not respect system proxy, Windows certificate store, or firewall rules, causing "No internet connection" download failures when the browser can reach the same URL (AUG-138).
- startEmbeddedServer() logs WHISPER_MODEL_PATH and AUGUST_DATA_DIR at startup for path resolution debugging.
- electron/build/ is force-included in git (.gitignore negation) because electron-builder needs icon.png and tray PNGs at build time; regenerate with npm run electron:icons, never hand-edit.
- App and tray icons use square corners by design (brand rule: no border radius).
- The updater starts checking only after the tray exists (updater.start() in main.ts) so the first "checking" state reaches the menu.
- updater.ts routes electron-updater's logger to console.log/warn/error with a [updater] prefix; log.ts mirrors console.info too, because electron-updater logs at info level and those lines were missing from main.log before AUG-141.
- A failed update check never clears a 'ready' (downloaded) state; the error state is transient and the tray and sidebar menu show it as idle.
- main.ts keeps the updater and the last UpdateState at module level so IPC registered before the updater exists can answer; updater onState fans out to the tray and to the renderer (AUG-157).
- electron-updater runs the Windows installer as `<pending>.exe --updated /S` from %LOCALAPPDATA%/august-updater/pending; Cyrillic user paths work there.
- electron-builder's ${isUpdated} test needs the StdUtils plugin dir, which may be declared after the custom installer.nsh include; top-level functions in installer.nsh must test --updated with FileFunc ${GetParameters}/${GetOptions} instead.
- Differential download may fail with "sha512 checksum mismatch" when the installed build came from a local installer; electron-updater falls back to a full download, which is not a bug.

## Key implementation details

- Scripts: dev:electron, electron:start, electron:pack, electron:dist, electron:icons, build.
- userData layout: data/ (macOS only), whisper/models/, desktop-settings.json, logs/main.log.
- resources layout: whisper/bin/<platform>/ holds whisper-cli plus ffmpeg and ffprobe, all signed by electron-builder along with the app.
- electron-builder targets: mac dmg+zip per arch, win nsis+msi x64.
- Signing env vars: CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.
- electron/scripts/afterPack.cjs — afterPack hook: (Windows) pre-compiles the WASAPI loopback helper with csc.exe into data/tools/ so the packaged app doesn't depend on csc.exe at runtime (AUG-135); (macOS) ad-hoc signs unsigned builds with codesign (Apple Silicon requires a valid seal).
- Ad-hoc signed macOS apps show the "unverified developer" Gatekeeper prompt; users bypass it with right-click → Open, Privacy & Security → Open Anyway, or xattr -cr on the app.
- The release workflow exports CSC_LINK and Apple credentials only when the secrets are non-empty; an empty CSC_LINK makes electron-builder abort with "not a file".
- The release workflow creates the GitHub release with gh before any build job; electron-builder itself creates duplicate releases when its dmg and zip publishers race on a fresh tag.
- Release build jobs run with max-parallel 1 so platform uploads never overlap.
- electron-builder 26 replaces existing GitHub release assets on a rerun of the same tag ("overwrite published file"); the earlier belief that it never overwrites was wrong, re-pushing the tag is enough to re-release.
- The default GITHUB_TOKEN is read-only; the release workflow declares permissions contents: write so electron-builder can create the release.
- The packaged app must exclude server/node_modules/.bin: its symlinks point into excluded dev packages and a dangling symlink aborts the macOS build.
- Release runs via .github/workflows/release.yml on v* tags with --publish always.
- The root `version` file is the single source of truth for the app version.
- npm run build first runs version:sync (electron/scripts/sync-version.mjs), copying `version` into package.json and package-lock.json.
- Never edit the version in package.json by hand; it is overwritten from `version` on every build.
- The create-release job reads the tag from the `version` file on workflow_dispatch runs.

## Local DMG build

- Local build prerequisites: npm run install:all, then npm run setup (fetches/builds whisper-cli and ffmpeg for the current platform).
- Local DMG build command: npm run electron:dist -- --mac (builds client + server + compiles Electron TS, then runs electron-builder).
- electron:pack (--dir) creates an unpacked app directory for quick testing; electron:dist creates distributable DMG and ZIP installers.
- Build output lands in electron/release/ with the naming pattern August-{version}-mac-{arch}.dmg.
- On Apple Silicon the default build is arm64; pass --x64 for an Intel build (requires Rosetta or an Intel runner).
- To skip code-signing discovery on unsigned local builds, set CSC_IDENTITY_AUTO_DISCOVERY=false.
- Local builds omit --publish, so nothing is uploaded; --publish always is used only in CI.

## Release workflow (CI → GitHub Releases)

- Trigger: push a git tag matching v* (e.g. v0.0.15) or use workflow_dispatch.
- Step 1 (create-release job): gh release create creates the GitHub Release with --generate-notes if it does not already exist.
- Step 2 (build job, needs create-release): runs npm run install:all, npm run setup, then npm run electron:dist -- --mac --publish always on macos-latest (arm64).
- Step 3 (same build job, Windows matrix entry): runs the same pipeline with --win on windows-latest.
- electron-builder's github publisher uploads DMG, ZIP and latest-mac.yml into the pre-created release using GH_TOKEN.
- The version tag and the root `version` file must match; bump `version` (and commit the synced package.json) before tagging.
- To re-release the same version: re-push the tag (delete the remote tag, push it again); electron-builder 26 replaces existing assets (log line "overwrite published file"), so no manual asset deletion is needed.
- Deleting a release's git tag turns the published release into a draft; drafts are invisible to electron-updater, to the public API and to accounts without write access, so the create-release job publishes a drafted release when it finds one (v0.0.34 incident).
- gh on the dev machine has two accounts: vladdobro (owner, needed for gh release edit/delete and seeing drafts) and vladdobroc (pull-only); switch with gh auth switch --user vladdobro before touching releases, pushes go over SSH as vladdobro regardless.
- gh run rerun and workflow_dispatch need admin rights; re-pushing the tag is the way to rerun the workflow without them.
- Never delete a release while its workflow run is in flight: the running electron-builder jobs keep uploading into the deleted/drafted release.

## Compact Mode (AUG-156)

- CompactController (electron/src/compact.ts) is the main-process owner of compact shapes: none, strip, square, caption, coin.
- The renderer requests a shape with setCompactMode({ shape, stripWidth?, alwaysOnTop? }) over august:set-compact-mode.
- Main sends events to the renderer over august:compact-event: expand, toggle, strip-width.
- The renderer reports errors over august:compact-issue: interrupted, capture-lost.
- Ghost-only channels are august:ghost-ignore-mouse, august:ghost-resize and august:ghost-drag; main accepts them only from the ghost webContents.
- Updater channels (AUG-157): august:get-update-state (invoke; null when there is no updater), august:check-for-updates and august:install-update (send), and the push august:update-state from main on every state change. The bridge methods getUpdateState/checkForUpdates/installUpdate/onUpdateState are optional in desktop.d.ts; DesktopUpdateState there mirrors UpdateState in updater.ts.
- On the first compact, main snapshots the bounds (normal bounds when maximized or full-screen) and the maximized flag; it leaves full-screen and maximized first.
- Strip: minimum size drops to 280×240, window docks to the right edge of the current display workArea at full height, width 280–520.
- Strip resize by the user above 600 px or maximize sends an expand event.
- Strip resize inside 280–520 sends a strip-width event and the renderer saves compactStripWidth; out-of-range widths are clamped keeping the right edge.
- Square: content 180×180 at the bottom-right with a 12 px margin, not resizable.
- Caption and coin: the main window is hidden and a ghost BrowserWindow opens (frame false, transparent, skipTaskbar, hasShadow false, sandboxed preload, backgroundThrottling false).
- The ghost uses showInactive so the call app keeps focus, and it is always on top; Variant A follows compactAlwaysOnTop.
- Caption geometry: width min(760, 80% workArea) × 112, 24 px from the bottom or top; click-through via setIgnoreMouseEvents(true, { forward: true }) except over its left control zone.
- Caption vertical drag snaps to Top or Bottom.
- Coin geometry: 56×56 at a corner with a 16 px margin; hover grows it to 248×56 anchored at its corner ([ PAUSE ] [ END ] [ OPEN ]); free drag snaps to the nearest corner.
- Shape 'none' destroys the ghost, restores minimum size 960×600, resizable, bounds clamped to the current display workArea (unplugged display), the maximized flag, then show and focus.
- A reload or renderer crash of the main window forces shape 'none'.
- Bounds changes are guarded for 400 ms so programmatic resizes do not trigger the strip resize logic.
- Tray: while compact the menu starts with "Expand August", the tooltip shows "Recording mm:ss" refreshed by a 1 s ticker (tooltip only), and tray click or notification click during a ghost compact expands.
- The "Recording started/stopped" hidden-window notification is skipped while compact.
- Compact error notifications (interrupted, capture lost) fire from main only while the main window is hidden; errors never auto-expand.
- Status: not verified interactively on Windows or macOS; build, server tests and the Electron smoke test pass.
- macOS setBounds right after leaving native full-screen may race the exit animation (inferred, unverified).

## Key files

- electron/src/main.ts — main-process entry: window creation, server bootstrap, lifecycle wiring.
- electron/src/compact.ts — CompactController: compact shapes, bounds snapshot/restore, ghost window lifecycle, drag/snap, always-on-top per platform (AUG-156).
- electron/src/preload.cts — implements the window.august bridge exposed to the renderer.
- electron/src/tray.ts — tray icon creation, idle/recording/transcribing state updates and the update menu item driven by UpdateState; Expand August item and compact tooltip timer (AUG-156).
- electron/src/hotkey.ts — global record hotkey registration, validation and persistence.
- electron/src/sessionWatcher.ts — polls GET /api/sessions to detect state transitions for notifications.
- electron/src/updater.ts — electron-updater wiring against GitHub Releases; exposes UpdateState, checkNow/installNow/start controls and the update notifications (AUG-141).
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
- Do not add a generic "open any path" IPC; file-manager reveal stays scoped to a validated session ID (revealSession) or the fixed sessions dir (revealSessionsDir, AUG-150).
- Do not bundle the whisper model.
- Do not enable asar.
- Keep electron-updater's feed pointing at GitHub Releases.
- Do not store desktop settings in server user-preferences.json — the main process needs them before the server is up.
