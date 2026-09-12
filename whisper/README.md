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
| All platforms | ffmpeg — `brew install ffmpeg` (macOS) or `winget install ffmpeg` (Windows) |
| macOS only | Xcode Command Line Tools — setup opens Apple's installer automatically if they're missing (or install ahead of time with `xcode-select --install`) |

cmake is **not** required on macOS: `npm run setup` uses cmake from PATH if present, otherwise it
downloads a portable, pinned, SHA256-verified CMake 4.4.3 build into `whisper/.build/` and deletes it
after the build completes.

## Binary layout

```
whisper/bin/win-x64/       whisper-cli.exe + DLLs, from the v1.8.4 release zip
whisper/bin/darwin-arm64/  whisper-cli, static binary built from the v1.8.4 source tarball (Metal embedded)
whisper/bin/darwin-x64/    whisper-cli, static binary built from the v1.8.4 source tarball
```

This folder is git-ignored (see `.gitignore`) — `npm run setup` (re)creates it. If a legacy
`whisper/bin/whisper-cli.exe` (from before this per-platform layout) is found, setup migrates it into
`whisper/bin/win-x64/` instead of re-downloading.

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

macOS on Apple Silicon uses Metal; every other supported platform runs with `--no-gpu`.

## Overriding paths

Both the model path and the whisper-cli binary path can be overridden via environment variables (see
`.env.example` at the repo root): `WHISPER_MODEL_PATH` and `WHISPER_BIN_PATH`. Leave them empty to use
the defaults described above.
