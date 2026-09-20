# Whisper Setup

August uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`, pinned at v1.8.4)
to transcribe audio locally.

## Setup

```
npm run install:all
npm run setup
```

`npm run setup` downloads (Windows) or builds (macOS) the `whisper-cli` binary for your platform. It
is safe to re-run — it skips the download/build when the binary is already present. `npm run dev`
runs it automatically first (a `predev` hook) — it's a no-op when the binary already exists, and a
failure there doesn't block the app from starting, though transcription stays unavailable until
`npm run setup` succeeds. You can still run `npm run setup` manually any time.

### Prerequisites

| | Requirement |
|---|---|
| All platforms | Nothing for ffmpeg — `npm run setup` downloads a pinned, SHA256-verified static ffmpeg 9.0.2 + ffprobe into `whisper/bin/<platform>/` (see below). A manual `brew install ffmpeg` / `winget install ffmpeg` is only a fallback. |
| macOS only | Xcode Command Line Tools — setup opens Apple's installer automatically if they're missing (or install ahead of time with `xcode-select --install`) |

cmake is **not** required on macOS: `npm run setup` uses cmake from PATH if present, otherwise it
downloads a portable, pinned, SHA256-verified CMake 4.4.3 build into `whisper/.build/` and deletes it
after the build completes.

## Binary layout

```
whisper/bin/win-x64/       whisper-cli.exe + DLLs, from the v1.8.4 release zip, + vulkan-1.dll (Khronos Vulkan loader 1.4.357.0) + VulkanRT-License.txt
whisper/bin/darwin-arm64/  whisper-cli, static binary built from the v1.8.4 source tarball (Metal embedded)
whisper/bin/darwin-x64/    whisper-cli, static binary built from the v1.8.4 source tarball
whisper/bin/win-x64/       + ffmpeg.exe, ffprobe.exe   (BtbN LGPL static build 9.0.2)
whisper/bin/darwin-arm64/  + ffmpeg, ffprobe           (ffmpeg.martin-riedl.de static build 9.0.2, GPL)
whisper/bin/darwin-x64/    + ffmpeg, ffprobe           (ffmpeg.martin-riedl.de static build 9.0.2, GPL)
```

This folder is git-ignored (see `.gitignore`) — `npm run setup` (re)creates it. If a legacy
`whisper/bin/whisper-cli.exe` (from before this per-platform layout) is found, setup migrates it into
`whisper/bin/win-x64/` instead of re-downloading.

## ffmpeg

`npm run setup` also downloads a static `ffmpeg` + `ffprobe` build for your platform into the same
`whisper/bin/<platform>/` folder, verifying each archive's SHA256 against the value pinned in
`server/src/scripts/setup.ts` (`FFMPEG_BUILDS`). Sources: BtbN's LGPL Windows build from a permanent
autobuild tag, and Martin Riedl's per-architecture macOS release builds (GPL). The step is skipped when
both binaries already exist.

At runtime the server resolves the executables once, in `server/src/config.ts` (`config.ffmpegPath`,
`config.ffprobePath`, `config.ffmpegSource`), with this precedence:

1. `FFMPEG_PATH` — an explicit ffmpeg executable; ffprobe is taken from the same directory when present.
2. The bundled build next to `whisper-cli` (the repo's `whisper/bin/<platform>/`, or the packaged app's
   `resources/whisper/bin/<platform>/`).
3. `ffmpeg` / `ffprobe` on `PATH` — the fallback for dev machines with a system install.

Every ffmpeg/ffprobe spawn in the server goes through those config fields, so `/api/health` reports
`ffmpegAvailable: true` with only the bundled binary present. The Electron build bundles the folder as
`extraResources` and sets `FFMPEG_PATH` to the packaged copy.

## Model file

The transcription model, `ggml-large-v3-turbo.bin` (~1.6 GB), auto-downloads to
`whisper/models/ggml-large-v3-turbo.bin` the first time the server starts, and its SHA256 is verified
against the known-good hash:

```
1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69
```

The app shows a progress modal while this download is in flight (backed by `GET /api/setup/status`
and the SSE stream `GET /api/setup/download-progress`). An interrupted download (`*.part` file) is
deleted and retried automatically on the next server start.

If you'd rather fetch it yourself, download it from Hugging Face and place it at
`whisper/models/ggml-large-v3-turbo.bin`:

```
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

Auto-download only applies to that default file name — a custom `WHISPER_MODEL_PATH` (see below) is
never downloaded automatically.

## GPU

macOS on Apple Silicon uses Metal. Windows x64 uses the Vulkan backend of the release build; if whisper-cli
fails with a Vulkan error, the server retries that job once with `--no-gpu` and stays on CPU until it is
restarted (`/api/health` then reports `gpuBackend: "cpu"`, and the Diagnostics page says transcription runs
on CPU). Set `WHISPER_USE_GPU=0` or `1` in `.env` to pin the mode and skip the probe/fallback.

### Vulkan loader (Windows)

The Windows release zip links `ggml-vulkan.dll` into `ggml.dll` statically, and `ggml-vulkan.dll` imports
`vulkan-1.dll` (the Khronos Vulkan loader). Without that DLL whisper-cli cannot start at all — not even with
`--no-gpu` — so `npm run setup` bundles the loader next to `whisper-cli.exe`, downloaded from LunarG's signed
Vulkan Runtime components zip and verified against the SHA256 pinned in `server/src/scripts/setup.ts`
(`VULKAN_RUNTIME`). The loader only dispatches to whatever GPU driver is installed: on a computer without a
Vulkan-capable driver it finds no device, whisper-cli runs on CPU by itself, and the server's startup probe
notices (no `ggml_vulkan: Found N Vulkan devices` banner) and reports `gpuBackend: "cpu"` with no retry.
Windows loads DLLs from the application folder before `System32`, so the bundled loader is the one used
even when a driver installed its own copy.

## Overriding paths

The model path, the whisper-cli binary path and the ffmpeg executable can be overridden via environment
variables (see `.env.example` at the repo root): `WHISPER_MODEL_PATH`, `WHISPER_BIN_PATH`, `FFMPEG_PATH` and
`WHISPER_USE_GPU`. Leave them empty to use the defaults described above.

## Third-party licences

- **Vulkan Loader** (`whisper/bin/win-x64/vulkan-1.dll`, version 1.4.357.0) — Copyright (c) 2015-2026 The Khronos
  Group Inc., LunarG, Inc., Valve Corporation. Licensed under the Apache License 2.0 (with MIT-licensed
  components); the full notice ships next to the DLL as `whisper/bin/win-x64/VulkanRT-License.txt` and is
  bundled into the desktop app's `resources/whisper/bin/win-x64/`. Source: https://github.com/KhronosGroup/Vulkan-Loader;
  binary: LunarG Vulkan Runtime components, https://vulkan.lunarg.com/sdk/home.
- whisper.cpp (MIT), ffmpeg (LGPL v3 Windows build / GPL v3 macOS builds) — see the sections above for sources.
