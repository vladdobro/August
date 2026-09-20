# Whisper Setup Domain

## TL;DR
- Supports Windows x64 and macOS arm64/x64 only; Linux logs a warning and setup exits with code 1.
- Platform binaries live in whisper/bin/{win-x64,darwin-arm64,darwin-x64}/, selected at runtime by whisperPlatformDir() in config.ts.
- whisper.cpp is pinned to version 1.8.4 via WHISPER_CPP_VERSION in server/src/config.ts.
- npm run setup is idempotent, skipping its download/build step whenever the platform binary already exists.
- npm run setup also downloads a pinned, SHA256-verified static ffmpeg 9.0.2 + ffprobe into whisper/bin/<platform>/ next to whisper-cli (AUG-115).
- The server resolves ffmpeg and ffprobe once in config.ts with precedence FFMPEG_PATH env, then bundled binary next to whisper-cli, then PATH.
- Windows setup downloads a prebuilt release zip; macOS setup builds whisper-cli from source because no prebuilt macOS CLI is released.
- macOS setup provisions its own cmake automatically, so no manual cmake install is required.
- The whisper model ggml-large-v3-turbo-q8_0.bin (8-bit quantized, ~874 MB) auto-downloads on server startup and its SHA256 checksum is verified before use.
- Downloads write to a .part file and rename to the final path only after checksum verification succeeds.
- GET /api/setup/status and the SSE stream /api/setup/download-progress expose live model download progress to the client.
- whisper/bin/ and whisper/.build/ are git-ignored; platform binaries are never committed to the repository.
- npm run dev runs setup automatically through the root package.json predev hook, and a setup failure never blocks the app from starting.
- ffmpeg is mandatory for browser recordings; the diagnostics page blocks "Proceed" when neither a bundled nor a PATH ffmpeg is found.
- Windows x64 whisper-cli runs on Vulkan with automatic CPU fallback: a Vulkan-class failure is retried once with --no-gpu and the process stays on CPU (AUG-116).
- WHISPER_USE_GPU=0|1 pins the GPU mode and disables the startup probe and the fallback; documented in .env.example.
- /api/health reports gpuBackend ('vulkan' | 'metal' | 'cpu' | 'unknown') from services/gpuBackend.ts; the diagnostics page shows a plain-language CPU line when it is 'cpu'.
- A missing vulkan-1.dll aborts whisper-cli before main() for every flag set including --no-gpu, because ggml-vulkan.dll is a static import in the v1.8.4 zip.
- npm run setup bundles the Khronos Vulkan loader vulkan-1.dll plus VulkanRT-License.txt into whisper/bin/win-x64/ from LunarG's SHA256-pinned runtime zip (AUG-117, VULKAN_RUNTIME in setup.ts).
- With the bundled loader and no GPU driver, whisper-cli runs on CPU by itself and exits 0 without printing the ggml_vulkan device banner.
- The startup probe flips GpuState to cpu when the ggml_vulkan device banner is absent, so /api/health reports gpuBackend 'cpu' with no retry.

One-sentence description: How whisper-cli, the bundled ffmpeg/ffprobe and the whisper model get installed per platform, and how the client learns about download progress.

## Purpose

Explain the setup, binary-distribution, and model-download mechanics behind transcription so an agent never re-derives platform quirks or reintroduces a Windows-only assumption: why macOS needs a source build, why model downloads verify-then-rename, and why custom models are never silently overwritten.

## Core Concepts

- Platform resolution: whisperPlatformDir() maps process.platform + process.arch to win-x64, darwin-arm64, or darwin-x64; unsupported combinations (e.g. Linux) return null.
- Binary naming: whisperBinName() returns whisper-cli.exe on Windows and whisper-cli on macOS.
- Setup script (server/src/scripts/setup.ts): the idempotent installer behind npm run setup; exits 1 immediately on an unsupported platform.
- Legacy migration: Windows setup first checks for a pre-multiplatform whisper/bin/whisper-cli.exe and copies it plus its DLLs into win-x64/ instead of re-downloading.
- Windows install path: downloads whisper-bin-x64.zip from the pinned v1.8.4 GitHub release, extracts via tar (falling back to PowerShell Expand-Archive), then copies whisper-cli.exe and DLLs into whisper/bin/win-x64/.
- Bundled ffmpeg (AUG-115): setupFfmpeg() in setup.ts downloads the archives pinned in FFMPEG_BUILDS (URL + SHA256 per platform, version in FFMPEG_VERSION) and copies ffmpeg + ffprobe into whisper/bin/<platform>/.
- Bundled Vulkan loader (AUG-117): setupVulkanLoader() in setup.ts (Windows only) downloads LunarG's VulkanRT-X64-1.4.357.0-Components.zip pinned in VULKAN_RUNTIME (url + sha256), and copies x64/vulkan-1.dll plus VulkanRT-License.txt into whisper/bin/win-x64/; idempotent on the DLL's presence.
- Vulkan device banner: countVulkanDevices() in gpuBackend.ts parses "ggml_vulkan: Found N Vulkan devices" from stderr (printed even with --no-prints and for --help); null/0 means the loader found no driver and whisper-cli is on CPU.
- ffmpeg sources: Windows uses BtbN's LGPL static build from a permanent autobuild tag; macOS arm64/x64 use Martin Riedl's GPL static release builds, chosen because both publish per-arch static binaries with stable URLs.
- Shared zip extraction: extractZip() tries tar (bsdtar on Windows 10+/macOS) and falls back to PowerShell Expand-Archive on Windows; whisper-cli and ffmpeg archives share it.
- Windows extraction calls System32 tar.exe (bsdtar) by absolute path because Git Bash puts GNU tar first on PATH and GNU tar rejects drive-letter paths as remote hosts.
- ffmpeg resolution: resolveFfmpegPaths() in config.ts is a pure function (inputs injected) producing config.ffmpegPath, config.ffprobePath and config.ffmpegSource ('env' | 'bundled' | 'path').
- ffmpeg precedence: FFMPEG_PATH env first, then the bundled binary next to whisper-cli (directory of config.whisperBinPath, then the default platform dir), then bare ffmpeg on PATH.
- ffprobe follows ffmpeg: it is taken from the directory of the chosen ffmpeg when present, otherwise from PATH.
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
- ffmpeg pre-flight: checkFfmpegAvailable(path = config.ffmpegPath) runs at server startup, in /api/health and in the setup script; setup probes the freshly downloaded binary explicitly because config resolved paths at import time.
- FFMPEG_MISSING_MESSAGE leads with npm run setup (bundled download) and lists brew/winget manual install only as a fallback; the diagnostics "Install FFmpeg" section mirrors this on both platforms.
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
- GPU mode is owned by services/gpuBackend.ts (GpuState singleton): Metal on darwin-arm64, Vulkan on win32-x64, --no-gpu everywhere else.
- config.whisperGpuOverride (WHISPER_USE_GPU) is the only configuration input; true/false lock the mode, null enables the probe and fallback.
- Only the Vulkan build can fall back: on Metal and on a pinned mode, runWhisper() never retries and never alters flags.
- classifyWhisperFailure() is conservative — only exit 0xC0000135 (STATUS_DLL_NOT_FOUND) or explicit Vulkan error phrasing on stderr counts as a GPU failure; kills, timeouts, ENOENT and every other exit are never retried.
- The healthy-run banner "ggml_vulkan: Found 1 Vulkan devices" is printed even with --no-prints and must never match the classifier, or unrelated failures on GPU machines would be re-run on CPU.
- STATUS_STACK_BUFFER_OVERRUN (0xC0000409) stays classified as non-GPU because it is the non-ASCII path crash handled by toSafePath().
- The CPU flip is process-wide and permanent until restart, so live chunks and later batch jobs run --no-gpu directly with no per-chunk retry storm.
- The startup probe runs `whisper-cli --help` once on Vulkan builds; it catches the cannot-load case only, and the first real job is the second half of the probe because device-level Vulkan failures surface at model load.
- Verified: with the Vulkan loader present but no usable device (VK_LOADER_DRIVERS_DISABLE=*), whisper-cli itself falls back to CPU, exits 0 and prints no ggml_vulkan banner, so no retry is needed for a no-GPU machine — only the banner check.
- Verified: with an unloadable vulkan-1.dll next to the binaries, --help, GPU and --no-gpu runs all die at process load (0xC000012F), so --no-gpu cannot rescue a missing Vulkan runtime — that is why the loader is bundled (AUG-117); for any fallback around a native binary, check the import table / a broken-DLL simulation before designing the retry.
- On a complete install 0xC0000135 is unreachable; seeing it means whisper/bin/win-x64 is incomplete, and both the probe and runWhisper() log "re-run npm run setup" while the session error stays plain-language (WHISPER_RUNTIME_MISSING_MESSAGE).
- The probe and runWhisper() flip GpuState to cpu (reason NO_VULKAN_DEVICE_REASON) when a GPU-mode run printed no device banner; this depends on the pinned v1.8.4 ggml-vulkan always printing the banner when a device exists — re-verify the banner when bumping whisper.cpp.
- Windows resolves DLLs from the application directory before System32, so the bundled vulkan-1.dll is always the loader in use, even when a GPU driver installed its own copy; the two are interchangeable Khronos loaders.
- When even the --no-gpu retry dies at process load, runWhisper() throws WHISPER_RUNTIME_MISSING_MESSAGE (plain language, no DLL names) and logs the exit code and DLL detail to the server log only.
- Verified on darwin-arm64: the built whisper-cli is a static arm64 Mach-O binary linking only system frameworks, and transcription runs with Metal enabled.
- ffmpeg is bundled by npm run setup; a PATH install is only a fallback, and the diagnostics gate (allReady) still requires ffmpegAvailable.
- Every ffmpeg or ffprobe spawn in the server goes through config.ffmpegPath / config.ffprobePath — never a bare 'ffmpeg' or 'ffprobe' string.
- ffmpeg archives are verified against the SHA256 pinned in FFMPEG_BUILDS; a mismatch deletes the archive and fails setup, so a present binary is a verified binary.
- The ffmpeg step is idempotent: it is skipped when both ffmpeg and ffprobe already exist in whisper/bin/<platform>/.
- The PATH fallback must be preserved so dev machines with only a system ffmpeg keep working (npm run dev).
- ffmpeg is never an npm dependency (no ffmpeg-static); the download stays in setup.ts so the binary layout stays under whisper/bin/ and gets bundled by electron-builder as-is.
- Binaries are excluded from git because they are large and platform-specific — never commit a whisper-cli, ffmpeg or ffprobe binary.

## Route-Specific Constraints

- Transcribe requests made while the model is downloading fail with "Whisper model is still downloading (N%)" rather than queuing.
- GET /api/setup/download-progress sends an immediate snapshot, closes the stream once state leaves downloading, and heartbeats every 15 seconds while open.
- whisperBinName() is the only place that decides the binary name — whisper-cli.exe on Windows, whisper-cli on macOS.
- ffmpegBinName() is the only place that decides ffmpeg.exe/ffprobe.exe on Windows versus ffmpeg/ffprobe on macOS.
- Upgrading ffmpeg means changing FFMPEG_VERSION and all three FFMPEG_BUILDS entries together, with SHA256 values recomputed from the downloaded archives.
- Upgrading the Vulkan loader means changing every field of VULKAN_RUNTIME together (version, url, sha256 recomputed from the downloaded zip, archive paths); take the x64 DLL from LunarG's Components zip, never from a driver install.
- The Windows static build is large (~130 MB per executable); switching to BtbN's lgpl-shared variant would halve that but requires copying its DLLs like the whisper-cli setup does.
- The predev hook runs npm run setup before every npm run dev; this must remain a no-op when the binary already exists and must never block app start on failure.
- The diagnostics page derives model readiness from the health endpoint (real-time file check), not from the in-memory modelStatus which can be stale after external file deletion.
- POST /api/setup/download-model is idempotent — it returns immediately if a download is already in progress.
- Diagnostics UI text about the GPU stays plain-language ("Transcription runs on CPU on this computer — expect it to take longer"); DLL names, exit codes and backend names belong in the server log, never in SetupGuide.tsx.
- Do not add a second whisper-cli spawn path for probing or retrying — the probe lives in whisper.ts next to runWhisper() and the retry is runWithGpuFallback() inside runWhisper().

## Key Files

- server/src/scripts/setup.ts — per-platform whisper-cli installer (download for Windows, cmake build for macOS with a portable CMake fallback), legacy migration, pinned FFMPEG_BUILDS table and setupFfmpeg(), pinned VULKAN_RUNTIME and setupVulkanLoader() (Windows), ffmpeg pre-flight.
- server/src/services/modelDownloader.ts — ensureWhisperModel(), model status state machine, checksum verification.
- server/src/services/download.ts — shared streaming download and SHA256 helper (downloadToFile, isOfflineError) used by setup and the model downloader.
- server/src/routes/setup.ts — GET /api/setup/status and the SSE /api/setup/download-progress stream.
- server/src/config.ts — whisperPlatformDir(), whisperBinName(), ffmpegBinName(), resolveFfmpegPaths(), parseGpuOverride(), config.whisperGpuOverride, config.ffmpegPath/ffprobePath/ffmpegSource, WHISPER_CPP_VERSION, WHISPER_MODEL constants, repo-root .env loading.
- server/src/config.test.ts — unit tests for the ffmpeg resolver precedence (env, bundled, PATH).
- server/src/services/gpuBackend.ts — GPU policy resolution, GpuState (process-wide mode cache), conservative Vulkan failure classifier, countVulkanDevices() banner parser, runWithGpuFallback() retry-once engine (AUG-116/117).
- server/src/services/gpuBackend.test.ts — unit tests for the classifier, the state machine and the retry-once behaviour.
- client/src/components/ModelDownloadModal.tsx — progress modal and error UI, mounted in App.tsx.
- whisper/README.md — human-facing setup instructions, binary layout including bundled ffmpeg and the Vulkan loader, ffmpeg resolution order, third-party licence notices.
- package.json — predev hook runs npm run setup automatically before npm run dev, without blocking start on failure.
- start.bat — installs dependencies and runs npm run dev, which triggers setup through the predev hook.
- .env.example — documents WHISPER_BIN_PATH, WHISPER_MODEL_PATH, FFMPEG_PATH and WHISPER_USE_GPU overrides.
