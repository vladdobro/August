# August

August is a local-first meeting transcription app. A React + Vite client talks to an Express + TypeScript
server, which transcribes audio with `whisper.cpp` (v1.8.4) via a bundled `whisper-cli` binary — no audio
ever needs to leave the machine unless you opt into Groq for live transcription. August ships two ways:
as a web app you run at `localhost`, and as an Electron desktop app (`.dmg` / `.msi` / one-click `.exe`)
that embeds the same server and adds a tray icon, a global hotkey, and native notifications.

## Requirements

- Node.js 22+ (development uses Node 24)
- `ffmpeg` on `PATH` — `winget install ffmpeg` on Windows, `brew install ffmpeg` on macOS
- macOS only: Xcode Command Line Tools, needed to build `whisper-cli` from source

See [`whisper/README.md`](whisper/README.md) for how `whisper-cli` is fetched/built per platform and how
the whisper model is downloaded and verified.

## Web app development

```bash
npm run install:all   # installs root, server, and client dependencies
npm run setup          # fetches/builds whisper-cli for your platform (also runs automatically via predev)
npm run dev             # server on :3001, Vite dev server on :5175
```

`npm run dev` runs `predev` first, so a fresh checkout works with just `install:all` + `dev`. Copy
`.env.example` to `.env` in the repo root to override defaults (port, whisper paths, Groq key, etc.).

## Desktop app (Electron)

### Layout

- `electron/src/main.ts` — the Electron main process. It embeds the server by importing
  `server/dist/app.js` directly (no child process), and owns the window, tray, global hotkey, native
  notifications, and the auto-updater.
- `electron/src/preload.cts` — a CommonJS preload script that exposes a small `window.august` bridge to
  the renderer via `contextBridge` (see `client/src/desktop.d.ts` for the shape).
- `electron/electron-builder.yml` — packaging config (targets, files, code signing, publish feed).
- `electron/build/` — the app icon and tray PNGs (generated, see below) and the macOS entitlements file.
- The root `package.json` is the Electron app manifest: it declares `main`, `version`, and every
  Electron-side dependency (`electron`, `electron-builder`, `electron-updater`, `sharp`).

### Develop

```bash
npm run dev:electron
```

This starts the server, the Vite dev server, and Electron together (`concurrently`). Electron is launched
with `--dev`, which makes it wait for and attach to the Vite dev server at `http://127.0.0.1:5175` and the
API at `http://127.0.0.1:3001` instead of embedding the server — so client and server changes hot-reload
exactly like `npm run dev`. Override the URLs with `AUGUST_RENDERER_URL` / `AUGUST_API_URL` if you run the
dev servers on different ports. Plain `npm run dev` (no Electron) still works for browser-only development.

### Run the production shell unpackaged

```bash
npm run electron:start
```

Builds the client, the server, and the Electron main process, then launches Electron directly. In this
mode Electron starts the Express server in-process on a free OS-assigned port and reuses the repo's
`server/data/` and `whisper/` folders — handy for testing the packaged code path without building an
installer.

### Package

```bash
npm run electron:pack   # unpacked app directory, for inspection — electron/release/*-unpacked/
npm run electron:dist    # real installers in electron/release/
```

`electron:dist` produces a `.dmg` and `.zip` on macOS and a one-click NSIS `.exe` plus an `.msi` on
Windows. `npm run setup` must have already produced `whisper/bin/<platform>/` — the platform-specific
`whisper-cli` binary is bundled into the app's `resources/whisper/bin/` folder. Build macOS installers
per architecture with `-- --arm64` or `-- --x64`. The whisper model itself (~874 MB) is **not** bundled;
the packaged app downloads and SHA256-verifies it on first launch into the user-data folder, showing the
same progress modal as the web app.

### Where data lives when packaged

- Windows: `%APPDATA%\August\`
- macOS: `~/Library/Application Support/August/`

Inside that folder:

- `data/` — sessions, uploads, captures, preferences, and the `.env` file written by
  `POST /api/config/groq-key`
- `whisper/models/` — the downloaded whisper model
- `desktop-settings.json` — desktop-only settings (currently just the record hotkey)
- `logs/main.log` — mirrored console output from the main process (rotates at 5 MB)

This is implemented by three environment variables the Electron shell sets automatically before starting
the embedded server: `AUGUST_DATA_DIR`, `WHISPER_MODEL_PATH`, and `WHISPER_BIN_PATH`. None of them need to
be set for the web app.

### Desktop features

- **Tray icon** — reflects idle / recording / transcribing state in its color and tooltip. The menu offers
  Show August, Start/Stop Recording, Check for Updates, and Quit. Closing the main window hides it to the
  tray instead of quitting; quitting is always explicit (tray menu, `Cmd+Q`, or the OS shutting the app
  down).
- **Global hotkey** — default `Ctrl+Alt+R` (`Cmd+Alt+R` on macOS), configurable in Settings → Desktop.
  Pressing it starts a recording with your saved defaults (same behavior as the long-press gesture in the
  UI) or stops the current one, from anywhere, even while the window is hidden.
- **Native notifications** — shown when a transcription completes or fails (clicking one opens the
  session), and when a recording starts or stops while the window is hidden.
- **`getDisplayMedia` note** — Electron has no built-in system-audio picker. On Windows, system audio is
  delivered via WASAPI loopback; on macOS 15+ the native picker is used. Direct server-side system-audio
  capture remains the recommended path on both platforms and works the same as in the web app.

### Memory footprint

`asar` packing is disabled — the server spawns `whisper-cli`, `ffmpeg`, and (on Windows) `csc.exe` against
real filesystem paths, and serves `client/dist` with `express.static`; packing those into an archive is a
common source of "works in dev, breaks packaged" bugs. Several unused Chromium features are disabled
(spare renderer, media router, translate, GPU-hint collection, native window occlusion) to keep idle RAM
down, since whisper inference needs the memory more than those features do. Background throttling is
disabled only so recording keeps working while the window sits in the tray.

### Auto-update

The desktop app uses `electron-updater` against GitHub Releases (`vladdobro/August`). It checks for
updates on launch and every 4 hours, downloads silently, and installs the next time the app quits. This
requires the NSIS build on Windows (the MSI build does not support auto-update) and a signed build on
macOS.

### Code signing & release

Set these environment variables to enable signing and notarization:

- `CSC_LINK`, `CSC_KEY_PASSWORD` — Windows Authenticode and macOS Developer ID signing certificate
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — macOS notarization

Release flow: bump `version` in the root `package.json`, tag `vX.Y.Z`, and push. The
`.github/workflows/release.yml` workflow builds macOS (Apple Silicon) and Windows installers and publishes
them with `--publish always`. The local equivalent is:

```bash
GH_TOKEN=... npm run electron:dist -- --publish always
```

### Icons

```bash
npm run electron:icons
```

Regenerates `electron/build/icon.png` and the tray PNGs from a geometric "A" glyph (no fonts involved, so
output is identical on every machine). Square corners are intentional, per the brand's angular design.

### Smoke test

```bash
AUGUST_SMOKE_TEST=1 npx electron .
```

Boots the embedded server and the window without showing it, prints `SMOKE_OK` once the renderer has
loaded, and exits — useful in CI to catch a broken packaged build quickly.

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `PORT` | server | HTTP port (default `3001`) |
| `WHISPER_BIN_PATH` | server | Override path to `whisper-cli` |
| `WHISPER_MODEL_PATH` | server | Override path to the whisper model file |
| `AUGUST_DATA_DIR` | server | Writable data root; set automatically by the Electron shell |
| `GROQ_API_KEY` | server | Enables Groq-backed live transcription (optional) |
| `AUGUST_PORT` | electron | Fixed port for the embedded server (default: OS-assigned) |
| `AUGUST_RENDERER_URL` / `AUGUST_API_URL` | electron (dev) | Vite/server URLs for `--dev` mode |
| `AUGUST_SMOKE_TEST` | electron | Set to `1` to run the headless smoke test |

## Project docs

Deeper documentation — architecture, transcription pipeline, preferences, and frontend design — lives
under [`project-context/`](project-context/).
