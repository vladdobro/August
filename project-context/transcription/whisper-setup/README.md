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
- Windows x64 supports CPU (default) or CUDA/NVIDIA GPU engine; switchable in-app via Settings or Diagnostics screen; CUDA downloads on demand (~457 MB).
- In packaged Electron builds, GPU/CPU binary paths must use process.resourcesPath (extraResources), not WHISPER_BIN_ROOT which resolves into resources/app/ (server source tree).
- GPU engine choice persists in user-preferences.json (gpuEngine field) and is read at config init by readPersistedGpuEngine().
- WHISPER_GPU_ENGINE env overrides the persisted gpuEngine; WHISPER_USE_GPU=0|1 pins the GPU mode and disables the probe and fallback.
- WHISPER_GPU_ENGINE_DEFAULT (the installer choice, set by Electron main) applies only while user-preferences.json has no gpuEngine; it never pins the engine (AUG-140).
- A whisper job that ran the CPU build under a cuda policy never confirms or flips GpuState; only the CUDA build prints the ggml_cuda_init banner (AUG-140).
- gpuState.reset() bumps an epoch that runWhisper() snapshots at spawn, so jobs outliving an engine switch cannot alter the new state (AUG-140).
- Diagnostics shows "GPU (NVIDIA) — active" only when /api/health gpuBackend is 'cuda'; engine cuda with backend cpu shows a "could not be used" notice (AUG-140).
- nvidiaDetect.ts detects NVIDIA GPUs via nvidia-smi on Windows; result is cached process-wide and exposed in /api/health.
- POST /api/engine/switch toggles between cpu and cuda at runtime; GET /api/engine/cuda-progress streams CUDA download progress via SSE.
- /api/health reports gpuBackend, gpuEngine, nvidiaGpu ({detected, gpuName}), and cudaStatus from gpuBackend.ts, nvidiaDetect.ts, and cudaDownloader.ts.
- Health endpoint returns gpuEnginePinned: boolean — true when WHISPER_GPU_ENGINE env var is set, signaling the UI to hide engine switch controls.
- Health endpoint returns modelPath and modelError for debugging model path resolution and download failures (AUG-138).
- Offline download errors include the actual network error code (e.g. ENOTFOUND, ETIMEDOUT) in the message for diagnostics (AUG-138).
- The CPU build (whisper-bin-x64.zip) is CPU-only; GPU acceleration on Windows uses the separate CUDA 12.4 variant (whisper-cublas-12.4.0-bin-x64.zip, AUG-130).
- npm run setup bundles the Khronos Vulkan loader vulkan-1.dll plus VulkanRT-License.txt into whisper/bin/win-x64/ from LunarG's SHA256-pinned runtime zip (AUG-117, VULKAN_RUNTIME in setup.ts).
- With the bundled loader and no GPU driver, whisper-cli runs on CPU by itself and exits 0 without printing the ggml_vulkan device banner.
- The startup probe flips GpuState to cpu when the ggml_vulkan device banner is absent, so /api/health reports gpuBackend 'cpu' with no retry.
- The no-banner CPU flip applies to Vulkan builds only; Metal runs never print the banner and never flip (AUG-125).
- npm run setup downloads the SHA256-pinned Silero VAD model ggml-silero-v5.1.2.bin into whisper/bin/<platform>/ on every platform (AUG-125).

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
- Bundled VAD model (AUG-125): setupVadModel() in setup.ts is idempotent, skipping when the file exists with the pinned size 885098 bytes.
- setupVadModel() downloads to .part, verifies SHA256 29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf, then renames; the source is huggingface ggml-org/whisper-vad, pinned in WHISPER_VAD_MODEL in config.ts.
- CUDA variant (AUG-130): WHISPER_CUDA_BUILD in config.ts pins the v1.8.4 whisper-cublas-12.4.0-bin-x64.zip (SHA256 b07cff4e..., 457 MB); entries list the 9 files to extract from Release/ inside the zip.
- CUDA directory layout: dev installs to whisper/bin/win-x64-cuda/; packaged installs download on demand to %APPDATA%/August/whisper/bin/win-x64-cuda/.
- cudaDownloader.ts (ensureWhisperCuda): downloads and extracts the CUDA variant on first server start when the active engine is cuda, following the modelDownloader.ts pattern; idempotent, never throws.
- CUDA device banner: countCudaDevices() in gpuBackend.ts parses 'ggml_cuda_init: found N CUDA devices' from stderr; null/0 means no NVIDIA GPU and whisper-cli runs on CPU.
- GPU engine selection: the NSIS installer (installer.nsh) shows a radio page for CPU vs GPU-NVIDIA; the choice persists in %APPDATA%/August/gpu-engine, read by Electron main.ts into WHISPER_GPU_ENGINE_DEFAULT (a non-pinning default, AUG-140).
- GpuEngine type ('cpu' | 'cuda') in config.ts: parseGpuEngine() reads WHISPER_GPU_ENGINE; resolveGpuPolicy() uses it so Windows returns nativeBackend 'cuda' only when the CUDA engine is selected.
- readPersistedGpuEngine() in config.ts: WHISPER_GPU_ENGINE env first (overrides everything), then an explicit gpuEngine ('cpu' | 'cuda') in user-preferences.json, then WHISPER_GPU_ENGINE_DEFAULT, else 'cpu'.
- defaultWhisperBinPath() in config.ts: when gpuEngine is 'cuda' on Windows, resolves to whisper/bin/win-x64-cuda/ instead of win-x64/.
- In-app engine switch (AUG-136): POST /api/engine/switch validates NVIDIA GPU detected, refuses if WHISPER_GPU_ENGINE env is set (409), persists to user-preferences.json, mutates runtime config and calls gpuState.reset() BEFORE any probe.
- Diagnostics screen GPU switch (AUG-137): when nvidiaGpu.detected and gpuEngine='cpu' on Windows, SetupGuide.tsx shows a Switch to GPU button; hidden when gpuEnginePinned (WHISPER_GPU_ENGINE env set).
- Diagnostics shows an "Install GPU engine (NVIDIA)" button when gpuEngine='cuda' and cudaStatus is 'missing' (launch-time download failed); it re-posts /api/engine/switch to retry (AUG-140).
- SetupGuide.tsx subscribes to /api/engine/cuda-progress whenever health.cudaStatus is 'downloading', so a launch-time CUDA download (installer chose GPU) shows progress too (AUG-140).
- NVIDIA GPU detection: detectNvidiaGpu() in nvidiaDetect.ts runs nvidia-smi --query-gpu=name with 5s timeout on win32; result is cached for the process lifetime.
- Engine switch CUDA download: when switching to cuda and CUDA binaries are missing, the switch endpoint starts ensureWhisperCuda() in background and streams progress via GET /api/engine/cuda-progress (SSE).
- Settings modal GPU selector: on Windows with NVIDIA GPU detected, Settings shows a CPU/GPU(NVIDIA) dropdown with CUDA download progress bar and status hints.
- setupWindowsCuda() in setup.ts: downloads the CUDA variant for dev machines; npm run setup runs it after the CPU variant so both are available for testing.
- electron-builder extraResources already copy whole whisper/bin/darwin-${arch} and whisper/bin/win-x64 folders, so the VAD model ships in the DMG and the Windows installer without builder config changes.
- The server resolves the VAD model via WHISPER_VAD_MODEL_PATH env, else next to the resolved whisper-cli (works for packaged resources/whisper/bin/<platform>/).
- Packaged-build path resolution (AUG-138): WHISPER_BIN_ROOT resolves to resources/app/whisper/bin/ in packaged builds, which is the server source tree — NOT where extraResources places binaries (resources/whisper/bin/).
- resolveCpuBinDir() in engine.ts uses process.resourcesPath when available so engine switch paths work in both packaged and dev builds.
- Electron main.ts always sets WHISPER_CUDA_BIN_PATH on Windows regardless of gpuEngine, so the server knows the CUDA binary location even when starting in CPU mode — the user may switch to CUDA at runtime.
- probeGpuBackend() is called after every engine switch (both immediate and post-CUDA-download) to confirm the GPU backend; it runs asynchronously with a 30s timeout and one retry after 5s when the result is inconclusive (AUG-140).
- An inconclusive probe (killed by timeout, non-GPU exit) leaves the backend 'unknown' until the first job only after the retry also fails; the old 10s limit was exceeded on a loaded machine.
- gpuState.reset() must run before probeGpuBackend() is invoked: the probe reads the policy synchronously, and probing under the old CPU policy is a no-op that leaves the backend 'unknown' (AUG-140).
- probeGpuBackend() marks the state CPU with reason "CUDA whisper-cli is not installed" when the active binary is not the CUDA build under a cuda policy, instead of reporting "no CUDA device" (AUG-140).
- SetupGuide.tsx polls /api/health every 2s while gpuBackend === 'unknown' to resolve the race between the async GPU probe and the UI refresh.
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
- Offline failures (DNS/connect error codes) surface as "No internet connection. Cannot download the whisper model. [<error code>]" with the actual network error code appended for diagnostics (AUG-138).
- A download aborts if no bytes arrive for 60 seconds (stall timeout).
- Both the setup script and the model downloader route their downloads through the shared download.ts helper — never duplicate streaming or hashing logic.
- GPU mode is owned by services/gpuBackend.ts (GpuState singleton): Metal on darwin-arm64, CUDA on win32-x64 when gpuEngine is 'cuda', --no-gpu everywhere else including Windows CPU builds.
- config.whisperGpuOverride (WHISPER_USE_GPU) is the only configuration input; true/false lock the mode, null enables the probe and fallback.
- Both Vulkan and CUDA builds can fall back: on Metal, CPU-only, and on a pinned mode, runWhisper() never retries and never alters flags.
- CUDA variant is never bundled in the installer — it downloads on demand (~457 MB) on first launch when GPU-NVIDIA was chosen; the CPU variant is always bundled.
- Silent/unattended installs default to CPU engine because GpuEngine is initialized as 'cpu' in customInit.
- The uninstaller always deletes %APPDATA%/August/gpu-engine and %APPDATA%/August/whisper/bin/win-x64-cuda/ to clean up CUDA artifacts.
- ensureWhisperCuda() runs before runPreflightChecks() and probeGpuBackend() in startServer(), so the CUDA binary is present before the health check and GPU probe.
- The engine switch endpoint refuses with 409 when WHISPER_GPU_ENGINE env is set — env overrides are operator-level and must not be toggled from the UI.
- The engine switch endpoint refuses with 400 when requesting cuda without a detected NVIDIA GPU.
- Engine switch mutates config.whisperGpuEngine and config.whisperBinPath at runtime (never config.whisperCudaBinPath); GpuState is rebuilt via gpuState.reset(newPolicy), which bumps the epoch (AUG-140).
- Switching to CPU must keep config.whisperCudaBinPath: it is the engine-independent CUDA location (Electron: %APPDATA%), and nulling it made the next cuda switch download into resources/app (AUG-140).
- A CUDA build counts as installed only when every WHISPER_CUDA_BUILD entry exists (cudaBuildComplete); an incomplete folder is wiped and re-downloaded by ensureWhisperCuda() (AUG-140).
- POST /api/engine/switch to cuda always runs ensureWhisperCuda() (never a bare fileExists), so "Install" / "Retry GPU engine" in Diagnostics works without restarting the app (AUG-140).
- Diagnostics shows a "Retry GPU engine (NVIDIA)" button when engine is cuda but gpuBackend is cpu; it re-posts /api/engine/switch, which resets GpuState and re-probes (AUG-140).
- In packaged builds, engine switch CPU paths must resolve via process.resourcesPath, never via WHISPER_BIN_ROOT — the latter points into resources/app/ which lacks extraResources binaries.
- WHISPER_CUDA_BIN_PATH must be set by Electron main on every Windows startup, not just when gpuEngine is 'cuda' — the user can switch engines at runtime via the Diagnostics UI.
- The engine switch must always chain probeGpuBackend() after changing the binary path — without it, gpuState stays 'unknown' and the frontend shows "GPU: detecting…" indefinitely.
- The frontend must poll health while gpuBackend is 'unknown' — a single refresh after engine switch or CUDA download races with the async probe and may read stale state.
- readPersistedGpuEngine() uses sync fs.readFileSync at module-load time; the preferences file path is derived from config.dataDir.
- The CUDA 12.4 zip is self-contained: all needed CUDA runtime DLLs (cublas64_12, cublasLt64_12, cudart64_12) ship inside the zip; no system CUDA toolkit required.
- CUDA 11.8 was evaluated and rejected: its zip does not include cublas64_11.dll, requiring a system cuBLAS install (AUG-130 research).
- classifyWhisperFailure() is conservative — only exit 0xC0000135 (STATUS_DLL_NOT_FOUND) or explicit Vulkan/CUDA error phrasing on stderr counts as a GPU failure; kills, timeouts, ENOENT and every other exit are never retried.
- The healthy-run banner "ggml_vulkan: Found 1 Vulkan devices" is printed even with --no-prints and must never match the classifier, or unrelated failures on GPU machines would be re-run on CPU.
- STATUS_STACK_BUFFER_OVERRUN (0xC0000409) stays classified as non-GPU because it is the non-ASCII path crash handled by toSafePath().
- The CPU flip is process-wide and permanent until restart, so live chunks and later batch jobs run --no-gpu directly with no per-chunk retry storm.
- Root cause AUG-140: a CPU-build job spawned during the CUDA download finished under the cuda policy, printed no ggml_cuda_init banner, and markGpuUnusable() put the process on CPU while gpuEngine stayed cuda.
- The CUDA build prints the ggml_cuda_init banner even with --no-prints; the CPU build never prints it (verified on RTX 4060 with whisper-cli 1.8.4).
- runWhisper() snapshots config.whisperBinPath and gpuState.epoch() at spawn; isNativeGpuBinary() plus an unchanged epoch gate every markGpuConfirmed()/markGpuUnusable() for that job (outcomeApplies in runWithGpuFallback).
- Electron main never sets WHISPER_GPU_ENGINE from the installer file; it sets WHISPER_GPU_ENGINE_DEFAULT so the in-app switch stays available.
- The startup probe runs `whisper-cli --help` once on Vulkan builds; it catches the cannot-load case only, and the first real job is the second half of the probe because device-level Vulkan failures surface at model load.
- Verified: with the Vulkan loader present but no usable device (VK_LOADER_DRIVERS_DISABLE=*), whisper-cli itself falls back to CPU, exits 0 and prints no ggml_vulkan banner, so no retry is needed for a no-GPU machine — only the banner check.
- Verified: with an unloadable vulkan-1.dll next to the binaries, --help, GPU and --no-gpu runs all die at process load (0xC000012F), so --no-gpu cannot rescue a missing Vulkan runtime — that is why the loader is bundled (AUG-117); for any fallback around a native binary, check the import table / a broken-DLL simulation before designing the retry.
- On a complete install 0xC0000135 is unreachable; seeing it means whisper/bin/win-x64 is incomplete, and both the probe and runWhisper() log "re-run npm run setup" while the session error stays plain-language (WHISPER_RUNTIME_MISSING_MESSAGE).
- On Vulkan builds only, the probe and runWhisper() flip GpuState to cpu (reason NO_VULKAN_DEVICE_REASON) when a GPU-mode run printed no device banner; this depends on the pinned v1.8.4 ggml-vulkan always printing the banner when a device exists — re-verify the banner when bumping whisper.cpp.
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

- server/src/scripts/setup.ts — per-platform whisper-cli installer (setupVadModel() for the Silero VAD model, download for Windows, cmake build for macOS with a portable CMake fallback), legacy migration, pinned FFMPEG_BUILDS table and setupFfmpeg(), pinned VULKAN_RUNTIME and setupVulkanLoader() (Windows), ffmpeg pre-flight.
- server/src/services/cudaDownloader.ts — ensureWhisperCuda(), CUDA variant download state machine, on-demand extraction of 9 DLLs + exe from the zip (AUG-130).
- electron/build/installer.nsh — NSIS installer pages for model directory chooser (AUG-119) and GPU engine radio selection (AUG-130); persists choices to %APPDATA%/August/.
- server/src/services/modelDownloader.ts — ensureWhisperModel(), model status state machine, checksum verification.
- server/src/services/download.ts — shared streaming download and SHA256 helper (downloadToFile, isOfflineError) used by setup and the model downloader.
- server/src/routes/setup.ts — GET /api/setup/status and the SSE /api/setup/download-progress stream.
- server/src/config.ts — whisperPlatformDir(), whisperBinName(), ffmpegBinName(), resolveFfmpegPaths(), parseGpuOverride(), parseGpuEngine(), GpuEngine type, WHISPER_CUDA_BUILD, config.whisperGpuEngine, config.whisperGpuOverride, config.ffmpegPath/ffprobePath/ffmpegSource, WHISPER_CPP_VERSION, WHISPER_MODEL constants, repo-root .env loading.
- server/src/config.test.ts — unit tests for the ffmpeg resolver precedence (env, bundled, PATH).
- server/src/services/gpuBackend.ts — GPU policy resolution (Metal/CUDA/Vulkan/CPU), GpuState (process-wide mode cache), conservative failure classifier, countVulkanDevices() and countCudaDevices() banner parsers, runWithGpuFallback() retry-once engine (AUG-116/117/130).
- server/src/services/nvidiaDetect.ts — detectNvidiaGpu() NVIDIA GPU detection via nvidia-smi, cached process-wide (AUG-136).
- server/src/routes/engine.ts — POST /api/engine/switch and GET /api/engine/cuda-progress SSE stream (AUG-136).
- server/src/services/gpuBackend.test.ts — unit tests for the classifier, the state machine and the retry-once behaviour.
- client/src/components/ModelDownloadModal.tsx — progress modal and error UI, mounted in App.tsx.
- whisper/README.md — human-facing setup instructions, binary layout including bundled ffmpeg and the Vulkan loader, ffmpeg resolution order, third-party licence notices.
- package.json — predev hook runs npm run setup automatically before npm run dev, without blocking start on failure.
- start.bat — installs dependencies and runs npm run dev, which triggers setup through the predev hook.
- .env.example — documents WHISPER_BIN_PATH, WHISPER_MODEL_PATH, FFMPEG_PATH and WHISPER_USE_GPU overrides.
