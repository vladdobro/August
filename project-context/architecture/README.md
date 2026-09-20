# Architecture Route

## TL;DR
- August web app is a React + Vite client talking to a Node.js/Express + TypeScript server over REST.
- Speech-to-text runs locally via whisper-cli (whisper.cpp) on Windows x64 and macOS arm64/x64, never a third-party AI API.
- Sessions are stored as folders on disk for the MVP — no PostgreSQL yet, no auth yet.
- Session CRUD includes create, list, get, delete, and rename (PATCH title update) via the REST API.
- Transcription runs as a background child process; the client polls session status every 5 seconds.
- Dev mode: server on port 3001 redirects non-API requests to Vite dev server on port 5173; open 5173 for the latest UI.
- Production mode: server serves the built client from client/dist via express.static; the Electron shell runs this mode on a free port.
- Agentation widget is mounted in App.tsx for dev mode only, gated by import.meta.env.DEV.
- The server loads the repo-root .env from config.ts before building config.
- Praxis integration: POST /api/praxis/send creates a task directly in a target PraxisOS project's .praxis/tasks/new/ directory from a session transcript. POST /api/praxis/browse opens the OS native folder picker dialog so users can select the project path visually.
- User preferences persist in server/data/user-preferences.json via GET/PATCH/DELETE /api/preferences endpoints.
- Settings modal is accessible from the sidebar menu; preferences auto-save on control changes in FileUpload.
- App.tsx uses a single unified render — no early returns that unmount the layout; FileUpload stays mounted (hidden) during active recording to preserve MediaRecorder state.
- Recording crash recovery: audio chunks auto-save to IndexedDB every 30 seconds; on reload, recovered audio is offered for upload via a recovery banner.
- Desktop shell (AUG-114): an Electron app in electron/ embeds the Express server in-process; rules live in project-context/desktop-shell/README.md.
- In the browser build system audio still requires the getDisplayMedia() picker; picker-free capture runs on the local server.
- Server-side system capture (macOS and Windows): GET /api/capture/capabilities, POST /api/capture/start, POST /api/capture/stop drive an ffmpeg capture (audiotee, BlackHole avfoundation, Windows WASAPI loopback helper, or Windows dshow loopback) into server/data/captures/<captureId>.wav.
- Windows preferred capture method 'wasapi-loopback' (AUG-112): a compiled C# helper taps the default output device via WASAPI loopback, so Bluetooth/USB headsets work with no virtual device.
- Windows method preference order: wasapi-loopback (helper compiles and --probe succeeds), then dshow-loopback (Stereo Mix or VB-Cable), then none.
- The WASAPI helper source server/tools/wasapi-loopback/WasapiLoopback.cs is compiled on demand by csc.exe shipped with Windows into server/data/tools/ (gitignored); a source hash change recompiles.
- WASAPI helper silence-fill invariant: the helper writes zero frames for every gap so stdout is a continuous real-time stream and WAV length equals capture length.
- Capture endpoints refuse non-loopback callers with 403 even though the HTTP server binds all interfaces; the guard lives in server/src/routes/capture.ts.
- POST /api/sessions/upload accepts captureId + micStartedAt instead of the systemAudio multipart file; the server moves the capture into the session as audio-system.wav.
- Orphaned system captures (files left in server/data/captures/) are killed by sidecar PID and deleted on every server start.
- audiotee raw PCM sample format (s16le vs f32le) is sniffed by server/src/services/pcmSampleFormat.ts and reported as sampleFormat in capture capabilities.
- Capture startedAt is the first-written-byte time of the WAV (fs.stat poll every 25 ms, 2 s fallback to spawn time); it drives systemOffsetMs.
- Capture capabilities carry selfTest ('ok' | 'silent' | 'failed' | 'skipped') and selfTestDetail from a darwin-only ~1 s probe capture validated by ffprobe and volumedetect.
- selfTest runs on macOS and Windows once a method is detected; it is 'skipped' on other platforms, and startCapture() never waits for or runs it.

This route documents the August web app's technical architecture: how the client, server, and local whisper.cpp inference fit together.

## Purpose

Give any agent working on the codebase a map of the client/server split, how a session moves through the system, and how local AI inference is wired in, so changes respect the existing structure instead of re-deriving it.

## Core Concepts

- Client: React 18 + TypeScript + Vite app — session list, file upload, browser audio recording (with device selection) via MediaRecorder API, and transcript viewer.
- Server: Node.js + Express + TypeScript app exposing a REST API for session CRUD (including rename), file upload, and background transcription.
- Session: the unit of work — one audio recording plus its transcript and metadata, stored as a folder under server/data/sessions/.
- whisper-cli integration: the server shells out to a local whisper.cpp binary as a child process to transcribe session audio.
- TranscriptMerger: a TypeScript service that turns raw whisper.cpp segment output into a clean, deduplicated transcript.

## Invariants

- All AI inference runs locally via whisper.cpp — never sent to a third-party AI API.
- Every session is stored as a folder (audio file + session.json + transcript.md) — never a database row for the MVP.
- Transcription always runs in the background (child process) — the API responds immediately and the client polls for status, never blocking on transcription.
- FileUpload must never be unmounted while recording is active — MediaRecorder and AudioContext state lives in React refs and is destroyed on unmount.
- App.tsx lifts `isRecording` from FileUpload via `onRecordingChange` callback to keep FileUpload mounted (hidden via display:none) when navigating to diagnostics or other views.
- All runtime server data (sessions, uploads, captures, perf-stats.json, user-preferences.json) lives under server/data/ resolved from config.dataDir — never under server/src/ and never tracked in git, so running the app cannot dirty the working tree.
- Server bootstrap is the exported startServer() in server/src/app.ts; server/src/index.ts is a thin CLI wrapper, and the Electron shell imports startServer directly.
- All writable server paths derive from config.dataDir, which AUGUST_DATA_DIR relocates (Electron sets it to <userData>/data); ENV_FILE_PATH follows dataDir when the override is set.

## Key implementation details

- Binaries live in whisper/bin/{win-x64,darwin-arm64,darwin-x64}/ — whisper-cli (whisper.cpp v1.8.4) plus a static ffmpeg + ffprobe (9.0.2) — installed by npm run setup, git-ignored.
- The whisper model ggml-large-v3-turbo-q8_0.bin (~874 MB, 8-bit quantized) lives at whisper/models/ and is auto-downloaded on first server start — see project-context/transcription/whisper-setup/.
- Windows non-ASCII paths are converted to 8.3 short paths via a toSafePath helper before invoking the binary; toSafePath is a passthrough on macOS.
- The repo-root .env is loaded in config.ts before config is built; WHISPER_BIN_PATH, WHISPER_MODEL_PATH and FFMPEG_PATH env vars override the default binary, model and ffmpeg paths.
- Timestamp offsets in this build's whisper-cli --output-json-full output are milliseconds, not centiseconds — do not assume centiseconds when reading segment timestamps.
- MediaRecorder.start(30000) uses a 30-second timeslice so ondataavailable fires periodically, enabling IndexedDB auto-save during recording.
- Recording crash recovery uses IndexedDB database "august-recording-recovery" — saves mic (and optionally system) Blob, mimeType, language, and dualTrack flag; client/src/services/recordingRecovery.ts is the helper.
- A beforeunload handler prevents accidental tab close during active recording.
- The browser recorder supports selecting a microphone and an optional "Capture system audio" toggle — when enabled, getDisplayMedia() captures system audio and both tracks are recorded as separate files, then uploaded together in a single request to create one session with dualTrack: true.
- Dual-track sessions transcribe mic and system audio in parallel, then mergeDualStream interleaves segments chronologically with [Me]/[Them] role labels.
- Capture capability probe: on darwin the server prefers the audiotee CLI on PATH (Core Audio process tap, macOS 14.2+, method 'coreaudio-tap'), then a BlackHole device found via ffmpeg -f avfoundation -list_devices (method 'blackhole'); anything else returns method 'none' with a setup hint. Non-darwin always returns 'none'.
- Windows capability probe (AUG-111): lists DirectShow audio inputs with ffmpeg -list_devices true -f dshow -i dummy (parseDshowAudioDevices handles the ffmpeg ≥ 6 "Name" (audio) layout and the older DirectShow audio devices header) and picks the first name matching Stereo Mix / Стерео микшер / What U Hear / CABLE Output / Voicemeeter / loopback.
- dshow captures are addressed by exact friendly name (ffmpeg -f dshow -i audio=<name>), not by index; Cyrillic names pass through Node spawn and ffmpeg unchanged (verified).
- Windows stop rule: Node's kill() is TerminateProcess and leaves the RIFF size unfinalized, so dshow-loopback captures run ffmpeg with stdin as a pipe (no -nostdin) and stop by writing 'q' + closing stdin; SIGKILL only after the hard timeout. Verified: exit 0 and a correct RIFF size.
- dshow devices deliver their first packet about 1.2 s after spawn; the self-test therefore waits for the first written byte (up to 3 s) before counting its 1 s window, for every method.
- Hardware finding: Stereo Mix mirrors only the onboard Realtek output, so Bluetooth or USB headsets are never captured by dshow; such machines (this dev PC) now resolve to wasapi-loopback, and dshow-loopback is the fallback when the helper cannot compile or probe.
- WASAPI helper lifecycle (AUG-112): server/src/services/wasapiHelper.ts compiles server/tools/wasapi-loopback/WasapiLoopback.cs with %SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe (Framework fallback) into config.toolsDir (server/data/tools/) and stores the source sha256 next to the exe.
- The helper is recompiled only when the exe is missing or the stored sha256 differs from the current source; cached probes pay nothing.
- WasapiLoopback.cs must stay C# 5: csc v4.0.30319 has no string interpolation, nameof, null-conditional or expression-bodied members; it uses raw COM interop (IMMDeviceEnumerator, IAudioClient, IAudioCaptureClient) with no NuGet or NAudio.
- wasapi-loopback.exe --probe prints one JSON line with sampleRate, channels, format (ffmpeg raw demuxer name, f32le on Windows 10/11 defaults), bitsPerSample and device; non-ASCII device names are \u-escaped; parseWasapiProbe in wasapiHelper.ts requires all five fields.
- Helper exit codes: 0 ok, 2 no default output device (probe hint says so), 1 any COM/HRESULT failure with the reason on stderr; stdout carries nothing but PCM.
- The helper exits on stdin EOF, so spawnCapturePipeline gives it stdin 'pipe' and keeps it open; stdin 'ignore' would end the helper immediately.
- wasapi-loopback ffmpeg reads the helper's raw PCM: -f <format> -ar <rate> -ac <channels> -i pipe:0, downmixed to 16 kHz mono pcm_s16le with -flush_packets 1 and -fflags +bitexact like every other method.
- ffmpeg is spawned before the helper in the wasapi-loopback pipeline: the helper zero-fills from its own start, and a still-booting ffmpeg queued those frames so the WAV began before the first-byte startedAt (delta 143 ms before, 78 ms after the reorder).
- Silence fill rule inside the helper: no packet for 200 ms (or none yet) triggers zeros up to wall-clock minus a 30 ms lag (no lag before the first packet); AUDCLNT_BUFFERFLAGS_SILENT packets are written as zeros; the stderr exit line reports total and zero-filled frames.
- Silence fill engages only when no application holds a render stream; an app with an open but quiet stream keeps WASAPI packets flowing (about -50 dB noise floor observed), so verify fill with all audio apps closed (expect mean -91 dB and zero-filled equal to total frames).
- Windows capture stop for wasapi-loopback: SIGTERM (TerminateProcess) on the helper closes ffmpeg's pipe:0, ffmpeg finalizes the WAV on EOF, SIGKILL only after the timeouts; ffmpeg is never signalled first because Windows has no SIGINT.
- Windows probe order is the pure function resolveWindowsMethod(WindowsProbeInput) in systemCapture.ts (ffmpeg → helper status → dshow device → none); tests feed it fake inputs so the order is verified on any platform.
- WASAPI capabilities hint names the default output device, sample rate, channels and format; the helper exe path lives in ResolvedCapabilities.wasapi and is stripped by stripInternal, never sent to the client.
- Self-test 'silent' for wasapi-loopback means nothing was playing through the default output during the 1 s window; the helper follows the device that was default when the capture started.
- npm run capture:check on Windows prints the WASAPI helper compile/probe status and the probe JSON before the method and self-test lines.
- Verified on the dev PC (Bluetooth headphones default, no Stereo Mix, no VB-Cable): method wasapi-loopback, selfTest ok while playing and silent otherwise, a 5 s tone / 5 s silence / 5 s tone capture gives a 16.3 s WAV with 5 s at -91 dB, ffprobe within 78 ms of durationMs, RIFF and data sizes matching the file size.
- Capture capability results are cached for 30 seconds; pass ?refresh=1 to force a re-probe.
- Capture self-test (darwin only): after a method is detected the probe records ~1 s into server/data/captures/selftest-<uuid>.wav using the same spawn pipeline as startCapture().
- Self-test duration check: ffprobe duration must be ≥ 0.5 s, otherwise selfTest is 'failed'.
- Self-test silence threshold: `ffmpeg -af volumedetect` mean_volume ≤ −60 dB (or no level reported) counts as 'silent'; above it is 'ok'.
- Self-test 'silent' hint names the fix: Multi-Output Device including BlackHole for the blackhole method, System Audio Recording permission for coreaudio-tap.
- The self-test temp file is always deleted in a finally block, so nothing named selftest-*.wav survives in server/data/captures/ after the probe returns.
- selfTestDetail holds the measured level for 'ok'/'silent', a ≤400-char stderr excerpt for 'failed', or the skip reason.
- The self-test result is cached with the 30 s capability cache; ?refresh=1 re-runs it.
- Self-test stop uses stopCaptureProcesses() with shorter timeouts (800 ms soft, 1200 ms hard) so a healthy probe finishes within ~3 s.
- selfTest is 'skipped' on non-darwin, when no method is detected, or when a capture is already running; 'failed' when the process exits early, produces no file, or the file is shorter than 0.5 s.
- startCapture() never waits for a self-test: it reuses a fresh cached probe or detects only the method. Concurrent capability requests share one in-flight probe.
- `npm run capture:check` (server/src/scripts/captureCheck.ts) prints platform, avfoundation device list, method, and self-test result for bug reports; exits 0.
- Capture output is always 16 kHz mono pcm_s16le WAV — the same format ensureWav produces — so the transcription pipeline needs no conversion.
- audiotee is piped into ffmpeg as raw PCM; its sample format is sniffed on each uncached capability probe, never assumed (AUG-107).
- Sample-format probe: spawn `audiotee --sample-rate 16000`, read ~200 ms of stdout (6400 bytes, hard budget 450 ms), SIGTERM it, pass the bytes to detectPcmSampleFormat in server/src/services/pcmSampleFormat.ts.
- detectPcmSampleFormat is a pure function over a Buffer (no native deps) so it is unit-testable on Windows; tests live in server/src/services/pcmSampleFormat.test.ts.
- Detection rule: score the same bytes as int16 LE and float32 LE and pick the view with the lower zero-crossing rate (real audio ≈ 0.05–0.3, the wrong view ≈ 0.5).
- Float32 view is rejected in favour of s16le when it contains NaN/Infinity, peaks above 1.5, or only denormals (typical of int16 data read as float).
- A silent or too-short probe buffer falls back to s16le with sampleFormatSource 'fallback' and a console warning, so a noise-only [Them] track leaves a trace.
- The detected format is cached together with the capabilities (30 s TTL) and exposed as sampleFormat + sampleFormatSource ('detected' | 'fallback' | 'override') in GET /api/capture/capabilities; cached probes never re-run detection.
- startCapture reads the cached sampleFormat for ffmpeg -f on the coreaudio-tap path; it never reads config for the format.
- AUDIOTEE_SAMPLE_FORMAT (s16le | f32le) is an explicit override that skips the probe and is echoed back as sampleFormat with sampleFormatSource 'override'. A 'fallback' result is also logged as a console warning so a noise-only [Them] track has a trace.
- Capture stop for method 'blackhole' sends SIGINT to ffmpeg immediately (ffmpeg's documented graceful shutdown that finalizes the WAV header), then SIGKILL after 5 s. On Windows (dshow-loopback) the graceful step is 'q' on stdin instead of SIGINT.
- Capture stop for method 'coreaudio-tap' sends SIGTERM to audiotee, which closes ffmpeg's stdin pipe (EOF finalizes the WAV), then SIGINT to ffmpeg after 1.5 s, then SIGKILL after 5 s.
- BlackHole ffmpeg is spawned with stdin 'ignore' and -nostdin; the stop path never writes 'q' to stdin, so stop latency does not depend on stdin being read (AUG-110).
- The stop signal sequence lives in exported stopCaptureProcesses(method, procs, exited, timeouts) in systemCapture.ts; unit tests drive it with a fake process so they run on Windows.
- A stopped capture that no session claims is deleted after 10 minutes; a capture claimed by an upload is moved (rename, copy fallback) into the session folder.
- Track alignment: the client records micStartedAt (Date.now() right after MediaRecorder.start()); systemOffsetMs = capture startedAt − micStartedAt is stored in session.json and applied by alignDualSegments before mergeDualStream, including on retranscribe.
- Capture startedAt is the first-written-byte time: after spawning ffmpeg the server polls the WAV size with fs.stat every 25 ms (waitForFirstByte in systemCapture.ts) and records the moment it exceeds the 44-byte header (AUG-108).
- Polling stops at the first byte, on process exit, or after 2 s; on timeout startedAt falls back to spawnedAt and the response carries startedAtSource 'spawn' (otherwise 'first-byte').
- POST /api/capture/start and /stop return startedAt, spawnedAt and startedAtSource so device startup latency (startedAt − spawnedAt) can be inspected; the same delta is logged with console.debug.
- Capture ffmpeg runs with -flush_packets 1 (each packet reaches the file immediately instead of waiting for the ~32 KiB AVIO buffer, which is ≈1 s of 16 kHz mono s16le) and -fflags +bitexact (no LIST/INFO chunk, so the header is exactly 44 bytes).
- The applied systemOffsetMs is stored in session.json only; it is no longer printed in the transcript header (debug it from the session file).
- Praxis note (AUG-108): if real dual-track transcripts still show [Me]/[Them] misordering after the first-written-byte fix, the next step is cross-correlating the two audio tracks (e.g. onset envelopes) to measure the residual offset — not tuning the polling constants further.
- Client fallback rules: if POST /api/capture/start fails the recording continues with the getDisplayMedia picker and a dismissible notice; if /stop fails at the end the mic track is uploaded single-track and a notice says the system track was lost.
- Live transcription with System audio source = System (AUG-113): POST /api/capture/start { live: true } makes ffmpeg tee 16 kHz mono s16le PCM to stdout beside the unchanged WAV.
- The live WebSocket binds a server capture with an {type: "attach-capture", captureId} text frame, so live mode shows no screen picker and the browser sends only mic chunks.
- With System audio source = Browser, live mode keeps the screen picker and taps both streams in the browser.
- IndexedDB crash recovery saves only the mic track when the system track is server-captured (dualTrack false) — the orphaned capture is cleaned on server restart rather than recovered.
- Sessions shorter than 30 seconds are auto-deleted by the server after transcription completes (likely wrong audio source in dual-track recording).
- Sessions can be renamed via PATCH /api/sessions/:id with a JSON body { title }; the client triggers this by double-clicking the session title in the sidebar.
- Dev/prod static serving: when NODE_ENV !== 'production' (dev mode), server/src/index.ts redirects browser requests to the Vite dev server at http://127.0.0.1:5173 instead of serving stale client/dist files; in production, express.static serves client/dist normally.
- Praxis integration writes task files directly to the target project's .praxis/tasks/new/ directory — no dependency on a running Praxis MCP server.
- Task ID allocation mirrors the Praxis Python logic: reads .praxis/config/task_counter, scans .praxis/tasks/*/ for the filesystem max, increments, and writes the counter back.
- Task tag prefix is read from .praxis/config/general.yaml (taskTitleTag field); composite ID format is TAG-NUMBER-SUFFIX (e.g., POS-42-a7x3mq).
- POST /api/praxis/validate checks whether a directory contains .praxis/ before attempting task creation.
- The acceptance criteria template embedded in the export is a structured instruction set with 4 sections: pre-processing (participant identification, role prediction, reasoning, classification, dedup scan, context search), deliverables (summary, action items, commitments CMT-NNN, route updates), quality rules (self-containment, traceability, nothing-silently-skipped, halt on ambiguity), and output format (recap summary, extracted items, processing log).
- Pre-processing requires identifying [Them] from transcript context and predicting professional roles for each participant before any extraction begins.
- Task creation from transcripts only generates tasks for items the sender personally committed to — vague discussion points route to context updates instead.
- The template enforces merge-don't-replace for route updates — new information merges into existing records, never overwrites them.
- Exported tasks are always assigned to assistant.json unconditionally.

## Key files

- server/src/app.ts — startServer(): Express app, route wiring, HTTP+WebSocket listen, returns the bound port.
- server/src/index.ts — CLI entry; calls startServer() and exits on failure.
- server/src/services/whisper.ts — whisper-cli child_process invocation (runWhisper) and JSON output parsing.
- server/src/services/transcriptMerger.ts — filtering, dedup, and join logic that turns raw segments into a transcript.
- server/src/services/sessionManager.ts — session folder lifecycle (create, read, update status).
- client/src/App.tsx — client app shell and top-level routing/state.
- client/src/vite-env.d.ts — Vite client type declarations (import.meta.env).
- server/src/config.ts — platform binary resolution, model constants, AUGUST_DATA_DIR data-root override, .env loading.
- server/src/services/praxisIntegration.ts — Praxis task creation: counter management, ID allocation, atomic file write to target project.
- server/src/routes/praxis.ts — POST /api/praxis/validate and POST /api/praxis/send endpoints.
- server/src/routes/preferences.ts — GET/PATCH/DELETE /api/preferences for user preferences persistence.
- server/src/services/preferencesStore.ts — preferences file path from config.dataDir and the one-time legacy migration run at server start.
- server/src/services/systemCapture.ts — capability probe (avfoundation, audiotee, WASAPI helper, dshow), resolveWindowsMethod preference order, ffmpeg capture lifecycle, self-test, sidecar PID files, orphan cleanup.
- server/src/services/wasapiHelper.ts — compile-on-demand of the WASAPI helper with csc.exe (sha256-gated), --probe runner and parseWasapiProbe.
- server/tools/wasapi-loopback/WasapiLoopback.cs — single-file C# 5 WASAPI loopback helper (raw COM interop, silence fill, PCM to stdout, --probe JSON).
- server/src/scripts/captureCheck.ts — capture diagnostics CLI (device list, method, self-test).
- server/src/services/pcmSampleFormat.ts — pure int16-vs-float32 raw PCM detector and the AUDIOTEE_SAMPLE_FORMAT override resolver used by the capture probe.
- server/src/routes/capture.ts — loopback-guarded GET /capabilities, POST /start, POST /stop.
- client/src/services/preferences.ts — UserPreferences interface, defaults, and API wrappers.
- client/src/components/SettingsModal.tsx — Settings modal with all preferences displayed/editable.

## Dev Tooling: Agentation Widget

Agentation is a browser annotation overlay for visual QA that feeds annotations to AI coding agents.
The `<Agentation />` component is mounted in `client/src/App.tsx` at root scope, outside the main layout div.
It is gated behind `import.meta.env.DEV` — never rendered in production builds.
The endpoint is read from `VITE_AGENTATION_ENDPOINT` env var, defaulting to `http://127.0.0.1:4747`.
The `agentation` npm package is a client-only frontend dependency installed in `client/`.
No Agentation MCP server or backend scripts are configured — only the frontend widget is wired.

## Route-Specific Constraints

- Do not introduce a third-party transcription or AI API call anywhere in this stack — all inference must go through whisper-cli.
- Do not assume a database exists — session persistence is file-based until PostgreSQL is introduced (see project-context/roadmap/README.md).
- Do not assume authenticated requests — no auth is implemented yet; all endpoints are open for the MVP.
- Detailed transcription pipeline rules (whisper flags, TranscriptMerger constants, session lifecycle states) live in project-context/transcription/README.md, not here.
- Never spawn OS-level capture processes from an endpoint that lacks the loopbackOnly guard — the server listens on all interfaces.
- Never drop -flush_packets 1 or -fflags +bitexact from the capture ffmpeg arguments — first-written-byte detection depends on both.
- Never compute systemOffsetMs from spawnedAt; startedAt (first-written-byte, or its spawn fallback) is the only alignment reference.
- waitForFirstByte must stay a chained-await loop that returns on the first byte — no setInterval that outlives capture start.
- Windows direct capture prefers the WASAPI helper; dshow-loopback requires a real DirectShow loopback device; never fake either from the browser path.
- Never spawn a dshow-loopback capture with -nostdin or stop it with a signal — 'q' on stdin is its only header-finalizing stop on Windows.
- Never stop a wasapi-loopback capture by signalling ffmpeg first — terminate the helper so ffmpeg gets EOF on pipe:0 and finalizes the WAV.
- The WASAPI helper must never write anything but PCM to stdout; all diagnostics go to stderr.
- Keep WasapiLoopback.cs C# 5 compatible — csc.exe v4.0.30319 shipped with Windows is the only allowed build tool; no NuGet, NAudio or Node native addons.
- Never commit server/data/tools/ — the compiled helper is machine-specific and regenerated from source.
- Never spawn the WASAPI helper with stdin 'ignore' — it exits on stdin EOF.
- Never spawn the helper before ffmpeg in the wasapi-loopback pipeline — the pre-boot frames would skew startedAt.
