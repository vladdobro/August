# Whisper Setup Domain

## TL;DR
- Supports Windows x64 and macOS arm64/x64 only; Linux logs a warning and setup exits with code 1.
- Platform binaries live in whisper/bin/{win-x64,darwin-arm64,darwin-x64}/, selected at runtime by whisperPlatformDir() in config.ts.
- whisper.cpp is pinned to version 1.8.4 via WHISPER_CPP_VERSION in server/src/config.ts.
- npm run setup is idempotent, skipping its download/build step whenever the platform binary already exists.
- Windows setup downloads a prebuilt release zip; macOS setup builds whisper-cli from source because no prebuilt macOS CLI is released.
- macOS setup provisions its own cmake automatically, so no manual cmake install is required.
- The whisper model ggml-large-v3-turbo-q8_0.bin (8-bit quantized, ~874 MB) auto-downloads on server startup and its SHA256 checksum is verified before use.
- Downloads write to a .part file and rename to the final path only after checksum verification succeeds.
- GET /api/setup/status and the SSE stream /api/setup/download-progress expose live model download progress to the client.
- whisper/bin/ and whisper/.build/ are git-ignored; platform binaries are never committed to the repository.
- npm run dev runs setup automatically through the root package.json predev hook, and a setup failure never blocks the app from starting.

One-sentence description: How whisper-cli binaries and the whisper model get installed per platform, and how the client learns about download progress.

## Purpose

Explain the setup, binary-distribution, and model-download mechanics behind transcription so an agent never re-derives platform quirks or reintroduces a Windows-only assumption: why macOS needs a source build, why model downloads verify-then-rename, and why custom models are never silently overwritten.

## Core Concepts

- Platform resolution: whisperPlatformDir() maps process.platform + process.arch to win-x64, darwin-arm64, or darwin-x64; unsupported combinations (e.g. Linux) return null.
- Binary naming: whisperBinName() returns whisper-cli.exe on Windows and whisper-cli on macOS.
- Setup script (server/src/scripts/setup.ts): the idempotent installer behind npm run setup; exits 1 immediately on an unsupported platform.
- Legacy migration: Windows setup first checks for a pre-multiplatform whisper/bin/whisper-cli.exe and copies it plus its DLLs into win-x64/ instead of re-downloading.
- Windows install path: downloads whisper-bin-x64.zip from the pinned v1.8.4 GitHub release, extracts via tar (falling back to PowerShell Expand-Archive), then copies whisper-cli.exe and DLLs into whisper/bin/win-x64/.
- macOS build path: downloads the v1.8.4 source tarball and builds whisper-cli with cmake as a static binary (BUILD_SHARED_LIBS=OFF), because whisper.cpp's GitHub releases ship no prebuilt macOS CLI, only an xcframework.
- macOS GPU flags: GGML_METAL=ON with an embedded Metal shader library on arm64; Metal off on x64.
- Xcode Command Line Tools prerequisite: compilers cannot be bundled, so when they are missing macOS setup runs xcode-select --install to open Apple's installer and exits asking the user to re-run.
- cmake resolution: setup uses cmake from PATH if present; otherwise it downloads the portable CMake 4.4.3 macos-universal tarball from Kitware's GitHub releases and verifies its pinned SHA256.
- Portable cmake lifecycle: the downloaded cmake is extracted into whisper/.build/tools/ and deleted along with whisper/.build/ after a successful build; a failed run leaves it in place for reuse.
- CMake policy compatibility: the cmake configure step passes CMAKE_POLICY_VERSION_MINIMUM=3.5 because CMake 4.x rejects projects declaring cmake_minimum_required below 3.5.
- Model auto-download: ensureWhisperModel() in modelDownloader.ts runs after the HTTP server starts listening, downloading ggml-large-v3-turbo-q8_0.bin from Hugging Face only when it is missing.
- Streaming download and hash: downloadToFile() in download.ts streams bytes to <model>.part while computing SHA256 in the same pass, then renames to the final path only if the hash matches the pinned value.
- Shared helper: download.ts (downloadToFile, isOfflineError) backs both the setup script's binary/source downloads and the model downloader.
- Setup API: GET /api/setup/status (point-in-time state), GET /api/setup/download-progress (SSE stream), and POST /api/setup/download-model (triggers server-side download) in server/src/routes/setup.ts.
- The diagnostics page download button triggers POST /api/setup/download-model instead of opening a browser download — the server downloads directly to whisper/models/ with checksum verification.
- Client modal: ModelDownloadModal.tsx (mounted in App.tsx) fetches status on load, opens an EventSource while downloading, shows the error with a Dismiss button when missing, and renders nothing when the model is present.
- ffmpeg pre-flight: checkFfmpegAvailable() runs both at server startup and inside the setup script; failures log the shared FFMPEG_MISSING_MESSAGE with per-platform install commands.
- .env loading: config.ts loads the repo-root .env via dotenv before computing config, so WHISPER_BIN_PATH and WHISPER_MODEL_PATH overrides in .env are honored.

## Invariants

- Supported platforms are Windows x64, macOS arm64, and macOS x64 only — Linux is unsupported.
- An unsupported platform makes setup.ts exit with code 1 and makes the server log a startup warning, never a silent fallback.
- whisper/bin/ and whisper/.build/ are always git-ignored — platform binaries and build artifacts are never committed.
- npm run setup always skips its download/build step when the target platform binary already exists.
- A model file only appears at its final path after its streamed SHA256 matches the pinned hash — a present file is always a verified file.
- A checksum mismatch deletes the downloaded file and records an error rather than leaving a corrupt model in place.
- Stale <model>.part files are deleted on every server startup, so an interrupted download restarts from zero — never resumed.
- Existing model files are never re-hashed on startup, because hashing a ~874MB file on every boot is too slow.
- Auto-download only runs for the default file name ggml-large-v3-turbo-q8_0.bin — a custom WHISPER_MODEL_PATH with another name is reported missing, never downloaded, so a custom model is never overwritten with the default.
- Offline failures (DNS/connect error codes) always surface as "No internet connection. Cannot download the whisper model."
- A download aborts if no bytes arrive for 60 seconds (stall timeout).
- Both the setup script and the model downloader route their downloads through the shared download.ts helper — never duplicate streaming or hashing logic.
- --no-gpu is passed on every platform except macOS Apple Silicon, which uses Metal (config.whisperUseGpu).
- Verified on darwin-arm64: the built whisper-cli is a static arm64 Mach-O binary linking only system frameworks, and transcription runs with Metal enabled.
- ffmpeg is never bundled — it stays a system dependency checked at setup time and at server startup.
- Binaries are excluded from git because they are large and platform-specific — never commit a whisper-cli binary.

## Route-Specific Constraints

- Transcribe requests made while the model is downloading fail with "Whisper model is still downloading (N%)" rather than queuing.
- GET /api/setup/download-progress sends an immediate snapshot, closes the stream once state leaves downloading, and heartbeats every 15 seconds while open.
- whisperBinName() is the only place that decides the binary name — whisper-cli.exe on Windows, whisper-cli on macOS.
- The predev hook runs npm run setup before every npm run dev; this must remain a no-op when the binary already exists and must never block app start on failure.
- The diagnostics page derives model readiness from the health endpoint (real-time file check), not from the in-memory modelStatus which can be stale after external file deletion.
- POST /api/setup/download-model is idempotent — it returns immediately if a download is already in progress.

## Key Files

- server/src/scripts/setup.ts — per-platform installer (download for Windows, cmake build for macOS with a portable CMake fallback), legacy migration, ffmpeg pre-flight.
- server/src/services/modelDownloader.ts — ensureWhisperModel(), model status state machine, checksum verification.
- server/src/services/download.ts — shared streaming download and SHA256 helper (downloadToFile, isOfflineError) used by setup and the model downloader.
- server/src/routes/setup.ts — GET /api/setup/status and the SSE /api/setup/download-progress stream.
- server/src/config.ts — whisperPlatformDir(), whisperBinName(), WHISPER_CPP_VERSION, WHISPER_MODEL constants, repo-root .env loading.
- client/src/components/ModelDownloadModal.tsx — progress modal and error UI, mounted in App.tsx.
- whisper/README.md — human-facing setup instructions and prerequisites.
- package.json — predev hook runs npm run setup automatically before npm run dev, without blocking start on failure.
- start.bat — installs dependencies and runs npm run dev, which triggers setup through the predev hook.
- .env.example — documents WHISPER_BIN_PATH and WHISPER_MODEL_PATH overrides.
