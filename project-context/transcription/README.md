# Transcription Route

## TL;DR
- whisper-cli (whisper.cpp), built for Windows and macOS, transcribes session audio locally; output is raw timestamped segments in milliseconds.
- runWhisper() in whisper.ts is the single whisper-cli invocation path for both batch and live transcription.
- runWhisper() retries a Vulkan-class failure once with --no-gpu and keeps the process on CPU afterwards (AUG-116, services/gpuBackend.ts).
- On Windows the Khronos Vulkan loader is bundled next to whisper-cli, so a machine without a GPU driver transcribes on CPU automatically (AUG-117, whisper-setup route).
- TranscriptMerger filters hallucinations and filler, dedupes near-duplicate segments, and joins nearby segments into readable lines.
- stripCreditHallucination replaces the "Редактор субтитров А.Семкин Корректор А.Егорова" hallucination with [OOPS] via regex, not silent drop.
- A session moves through uploading, transcribing, then completed or failed — the client polls status until it leaves transcribing.
- Failed sessions can be retranscribed from the UI; the retranscribe endpoint runs a whisper-cli and model preflight check before flipping status.
- Dual-track recording (mic + system) produces one session; mergeDualStream interleaves both streams with [Me]/[Them] role labels.
- Server-captured system tracks are offset-aligned by alignDualSegments (session.systemOffsetMs) before mergeDualStream; browser-recorded dual tracks have offset 0.
- Transcript headers never print systemOffsetMs; the alignment offset is a diagnostic kept only in session.json.
- TranscriptMerger constants are a faithful port from SplitVox's C# implementation — never re-tune without re-validating against known audio.
- Single-track transcripts have no role prefix; dual-track transcripts prefix each line with [Me] or [Them].
- Active whisper child processes are tracked per session in a Map; cancelTranscription kills all tracked processes for a session.
- Audio boost mode applies ffmpeg preprocessing (highpass, lowpass, volume gain, loudnorm) to quiet mic tracks before whisper runs.
- performanceTracker.ts stores rolling processing-seconds per audio-second ratios (last 10, pipeline 2) in data/perf-stats.json for ETA estimation.
- whisper-cli decodes greedily (--beam-size 1 --best-of 1, WHISPER_DECODING in config.ts), ported from SplitVox; --max-context 0 and default flash attention stay.
- Batch jobs pass --vad with the bundled Silero model ggml-silero-v5.1.2.bin; timestamps stay on the original track timeline.
- Dual-track sessions transcribe mic then system sequentially through one global batch slot; live chunks bypass the slot.
- Dual-track session.duration equals alignedDualDuration(mic, system, systemOffsetMs), the real call length, in upload, retranscribe and completion paths.
- describeTrackMismatch warns (server log + session.trackWarning shown in TranscriptView) when tracks differ by more than 60 s or 10%.
- estimatedDuration = (mic + system seconds) × median perf ratio for the current GPU/CPU mode; defaults 0.03 Metal/GPU, 0.16 CPU.
- Retranscribe reuses existing audio-*.wav conversions and boosted WAVs whose mtime is not older than the source.
- getAudioDuration() uses ffprobe to measure audio length before transcription starts, enabling accurate time estimates.
- SessionMetadata.estimatedDuration (seconds) is computed synchronously in the upload/retranscribe endpoint and included in the response for immediate countdown display.
- Orphaned sessions stuck in "transcribing" with no active process are auto-recovered to "failed" on server startup.
- Live transcription mode streams real-time audio chunks over WebSocket to whisper-cli or Groq Whisper API (opt-in) — see child route live-transcription/.
- Live transcription supports two engines: local whisper-cli (default) and Groq Whisper API (opt-in via GROQ_API_KEY); post-recording transcription is always local.
- Per-platform binaries, the setup script, and model auto-download live in the whisper-setup child route.

This route governs how audio becomes a transcript: the whisper.cpp CLI wrapper, the TranscriptMerger cleanup pass, and the session states in between.

## Purpose

Document the exact mechanics of turning a recorded or uploaded audio file into a usable markdown transcript, and the filtering rules that keep whisper.cpp's known failure modes (hallucinated captions, looping, filler noise) out of the final output.

## Core Concepts

- whisper.cpp CLI wrapper: server/src/services/whisper.ts's runWhisper() is the shared spawner that invokes whisper-cli as a child process against a session's audio file; transcribe() calls it and maps the returned JSON into segments.
- TranscriptMerger: server/src/services/transcriptMerger.ts takes raw whisper.cpp segments and produces the cleaned transcript — filtering, deduplication, and join logic.
- Session lifecycle: a session's status field moves uploading -> transcribing -> completed or transcribing -> failed. A failed session can be retranscribed, which resets it to transcribing.
- Transcript rendering: the final transcript is markdown — a header followed by [HH:MM:SS] text lines (single-track) or [HH:MM:SS] [Me]/[Them] text lines (dual-track), one per merged segment.
- Transcript header lines are exactly "- Date:" and "- Duration:"; renderTranscript takes no offset parameter.
- The former "- Track offset: ±N ms" header (AUG-108) was removed as a user-facing technical detail; existing transcript.md files keep it until retranscribed.
- Dual-stream merge: mergeDualStream takes mic and system segments, tags them with roles (Me/Them), sorts chronologically, then applies the same dedup/join pipeline — joinAdjacentSameRole only joins segments with matching roles.
- Process tracking: whisper.ts maintains a Map<string, ChildProcess[]> keyed by session ID. Each whisper-cli child process is registered under its session key and deregistered in the execFile callback.
- Dual-track tracks run sequentially, so at most one batch whisper-cli process is registered and running at a time.
- Batch slot: transcribe() acquires a process-wide promise-chain slot in whisper.ts, so two sessions or two tracks never run GPU-backed whisper-cli concurrently.
- Cancellation generations: cancelTranscription(key) bumps a per-session generation; beginTranscriptionJob(key) returns an isCancelled check used by queued jobs and between the mic and system tracks.
- A cancelled job returns silently from its catch block, so a retranscribe started after the cancel is never marked failed by the old job.
- Cancellation: cancelTranscription(sessionId) kills all tracked child processes for that session. The cancel endpoint (POST /api/sessions/:id/cancel) calls this and sets status to "failed" with "Cancelled by user". The catch block in runTranscription/runDualTranscription skips overwriting if status is already "failed" to avoid a race with the cancel endpoint.
- Failed-session recovery: when a session is in "failed" state, the UI shows a "Transcribe again" button with language and boost options. Clicking it calls POST /api/sessions/:id/retranscribe, which runs a preflight check (whisper-cli binary exists, model file exists) before flipping the session to "transcribing". If audio files are missing, the endpoint returns 400 and the UI shows "Audio file no longer exists" with the action disabled. The header Redo node also triggers retranscription independently.
- Orphan recovery: recoverOrphanedSessions() runs on server startup — any session in "transcribing" state with no active tracked process is moved to "failed" with an explanatory error message.
- Transcription metadata: SessionMetadata includes transcriptionStartedAt (ISO timestamp) and estimatedDuration (seconds), both set synchronously in the upload/retranscribe endpoint before the response — ensures the client has timer data immediately.
- Audio boost preprocessing: boostAudio() in whisper.ts applies an ffmpeg filter chain (highpass 100Hz, lowpass 4000Hz, 5x volume gain, loudnorm normalization) and converts to 16kHz mono WAV. Used when the retranscribe endpoint receives boost=true. Boosted files are saved as {basename}-boosted.wav next to the original.
- Boosted files are deleted only after a successful transcript and are kept after failure or cancel so a retry can reuse them.
- Derived WAV reuse: ensureWav and boostAudio reuse an existing output when it is non-empty and its mtime ≥ the source mtime.
- Derived WAVs are written to {basename}-partial.wav or {basename}-boosted-partial.wav and renamed, so a killed ffmpeg never leaves a truncated file that looks fresh.
- ffmpeg availability: checkFfmpegAvailable() probes ffmpeg at runtime. The /api/health endpoint reports ffmpegAvailable and ffmpegMessage (the shared FFMPEG_MISSING_MESSAGE when unavailable); the client disables the boost toggle when false. Server startup also logs FFMPEG_MISSING_MESSAGE as a pre-flight check. The retranscribe endpoint validates ffmpeg presence before accepting a boost request.
- Performance tracking: server/src/services/performanceTracker.ts records the ratio of processing seconds to audio seconds fed to whisper after each completed transcription (dual-track audio = mic + system).
- perf-stats.json entries carry pipeline: 2 and gpu: boolean; entries without pipeline 2 (pre-AUG-125) are ignored; the last 10 entries are kept, separated by single vs dual track.
- ETA estimation: estimatedDuration = (mic + system seconds) × median perf ratio for the current GPU/CPU mode; defaults are 0.03 for Metal/GPU and 0.16 for CPU.
- The upload/retranscribe endpoint computes estimatedDuration synchronously before responding, so the client can render the Chronometer Ring immediately.
- Greedy decoding rationale: SplitVox measured beam search 1.6-3.4x slower with no quality gain; on Metal the encoder dominates so the gain is small, on CPU it is large.
- VAD: runWhisper adds --vad --vad-model only when opts.vad is set (transcribe() sets it; live chunks do not) and the model file exists; a missing model logs one warning and transcribes without VAD.
- VAD model path: config.whisperVadModelPath = WHISPER_VAD_MODEL_PATH env, else ggml-silero-v5.1.2.bin next to whisper-cli.
- session.json optional fields trackDurations {mic, system} (seconds, ffprobe of the 16 kHz WAVs) and trackWarning (string) exist for dual-track sessions only; both are backward compatible.
- prepareDualTracks() in routes/sessions.ts converts and measures both tracks, then sets duration, estimatedDuration, trackDurations and trackWarning before the response.
- Completion duration for dual-track = max(alignedDualDuration from trackDurations, last utterance end).
- Long single [Them] lines are expected when the mic track is silent or missing: joinAdjacentSameRole joins same-role segments closer than 2 s.
- Chronometer Ring UI: during transcribing state, the client renders a circular SVG progress ring with a requestAnimationFrame-driven MM:SS:mm countdown. Three visual phases: amber (normal), red (< 60 seconds remaining), zeroed (0:00:00 with "Exterminatus Initiated" banner and pulsing digits).

## Invariants

- TranscriptMerger constants are copied exactly from SplitVox's original C# implementation — never re-tune them without re-validating against known reference audio.
- FILLER_ONLY_TEXTS are dropped outright: blank audio, silence, music, typing, inaudible, no audio, background noise.
- HALLUCINATION_BLACKLIST phrases (e.g. "thank you", "thanks for watching") are dropped, plus a co-occurrence check that drops Russian subtitles-credit hallucinations when both "субтитры" and "dimatorzok" appear.
- The "Редактор субтитров А.Семкин Корректор А.Егорова" credit-line hallucination is handled by stripCreditHallucination (regex-based, case-insensitive, spacing/punctuation-tolerant) which replaces matched fragments with [OOPS] — not silently dropped like HALLUCINATION_BLACKLIST entries.
- stripCreditLines runs before dedupHallucinations in both mergeSingleStream and mergeDualStream, so [OOPS]-replaced segments participate correctly in dedup and join.
- The credit-line detection covers three patterns applied in order: full line (both halves), first half only ("Редактор субтитров" + "Семкин"), second half only ("Корректор" + "Егорова").
- Live transcription applies stripCreditHallucination to each chunk after the isLikelyFiller check, matching batch behavior.
- JOIN_GAP_THRESHOLD = 2.0 seconds — segments closer together than this are joined into one line.
- joinAdjacentSameRole respects the role field — segments are only joined when they share the same role AND are within the gap threshold.
- DEDUP_WINDOW = 30.0 seconds — near-duplicate text within this window is collapsed to one segment.
- NO_SPEECH_PROB_THRESHOLD = 0.6 — segments at or above this whisper.cpp no-speech probability are dropped.
- --max-context 0 on every invocation.
- GPU flag per services/gpuBackend.ts: Metal on Apple Silicon, Vulkan on Windows x64 with automatic CPU fallback, --no-gpu elsewhere; WHISPER_USE_GPU=0|1 pins it.
- Non-GPU whisper failures (bad audio, missing model, cancellation, timeout) are never retried — classification lives in classifyWhisperFailure() and must stay conservative.
- All whisper-cli spawning goes through runWhisper() — never duplicate invocation logic in callers.
- ffmpeg-missing errors use the shared FFMPEG_MISSING_MESSAGE with per-platform install commands.
- Transcription always runs as a background process — the API never blocks a request waiting for whisper-cli to finish.
- Timer metadata (transcriptionStartedAt, duration, estimatedDuration) must be set in the endpoint handler before responding — never in the fire-and-forget background function, or the client will miss the Chronometer Ring on first render.
- Retranscription reuses the session's existing audio file but allows a language override — the session's language field is updated to the chosen language.
- Retranscription defaults to Russian ('ru') when no language is explicitly specified in the request body.
- Retranscription cancels any active transcription for the session before starting a new one.
- Audio boost filter parameters are centralized in AUDIO_BOOST config (server/src/config.ts) — never hardcode filter values in the ffmpeg call.
- Boosted audio files ({basename}-boosted.wav) are deleted only after a successful transcript, never in a finally block, and survive failure or cancel for reuse.
- boostAudio replaces ensureWav in the pipeline when boost is active — it already produces 16kHz mono WAV output.
- The retranscribe API (POST /api/sessions/:id/retranscribe) accepts an optional boost boolean; when true, ffmpeg availability is validated before proceeding.
- The retranscribe endpoint validates whisper-cli and model presence before setting status to "transcribing" — prevents flip-then-fail loops.
- If the whisper model is mid-download, the retranscribe preflight returns the download percentage in the error message.
- A failed transcription never deletes or modifies the session's audio files.
- Completed sessions are never auto-deleted, regardless of duration; only an explicit DELETE /api/sessions/:id removes a session (AUG-121).
- When a failed session has no audio files on disk, the UI disables the "Transcribe again" button and shows an explanatory message.
- For dual-track sessions with boost enabled, ffmpeg boosts both mic and system tracks independently in parallel, but whisper itself still runs the tracks sequentially.
- The client renders a Chronometer Ring (Tomb Amber SVG progress ring) with MM:SS:mm countdown, elapsed time, and ETA during the transcribing state.
- The Chronometer Ring transitions from amber to red (#e05555) when < 60 seconds remain, and shows pulsing zeroed digits with "Exterminatus Initiated" at 0:00:00.
- When estimatedDuration is not available (no perf-stats.json yet), the client falls back to the original indeterminate shimmer bar.
- performanceTracker stores at most 10 entries, separates single-track from dual-track ratios, separates gpu from cpu ratios, and ignores entries without pipeline 2 — never mix them for estimation.
- Never run two batch whisper-cli processes at once; post-recording work goes through transcribe() and its batch slot.
- Never flip GpuState to CPU on a missing ggml_vulkan banner unless the build is Vulkan.
- Dual-track duration is computed from both tracks, never from the mic WAV alone.
- ETA inputs are the summed track seconds, never the transcript length.
- Keep --max-context 0 and greedy decoding on every invocation, including live chunks.
- The Cancel button calls POST /api/sessions/:id/cancel; the Restart button reuses the retranscribe endpoint with a language selection dropdown.

## Benchmarks (AUG-125)

- Reference session a49e4b18 (dual-track, mic 971.7 s, system 3257.2 s, 70 min audio total), M3 Pro 12 cores, Metal, whisper.cpp 1.8.4, ggml-large-v3-turbo-q8_0.
- Baseline Metal (beam 5, mic+system in parallel): 169 s wall-clock.
- Greedy + sequential: 163 s.
- Greedy + VAD + sequential, q8_0: 117-127 s (three runs; chosen pipeline).
- Greedy + VAD + sequential, f16 ggml-large-v3-turbo: 137 s, so q8_0 stays the model.
- Greedy + VAD + sequential with --no-flash-attn: 145 s, so flash attention stays on (whisper-cli default).
- Greedy + VAD with the two tracks in parallel: 114 s; sequential was kept to avoid two GPU contexts and CPU thread oversubscription on Windows Vulkan/CPU.
- 4 vs 11 threads on Metal: 118 s vs 117 s, no difference, so threadCount() stays cpu-1.
- Metal speedup of the new pipeline over the baseline is 1.3-1.4x; the ≥3x target is not reached on Metal because the encoder dominates on dense speech.
- CPU baseline (--no-gpu, beam 5, parallel): the 16-min mic track alone took 1584 s; the full session was not run to completion (>1 h).
- CPU new pipeline: mic track 22 s (VAD skips silence); a 300 s dense-speech system slice 48 s (ratio 0.16).
- End-to-end retranscribe of a copy of the reference session: 130 s actual vs 127 s estimatedDuration; max one whisper-cli process; duration 00:54:17; last [Them] text ends at 3257 s.
- Quality spot-check: greedy+VAD keeps equal [Them] word coverage per 5-min bucket (7177 vs 7276 words) and removes baseline hallucinations ("Thank you." every 30 s, an 8x repetition loop on the mic track).

## Root Causes (AUG-125)

- Slow transcription on macOS: runWhisper flipped GpuState to CPU after any GPU run whose stderr lacked the ggml_vulkan device banner, which Metal never prints.
- Every macOS job after the first one in a server run therefore ran with --no-gpu (log line "whisper-cli found no Vulkan device ... runs on CPU").
- Fix: ranOnCpuWithoutVulkanDevice() in gpuBackend.ts applies the banner rule to Vulkan builds only.
- Mic 16:11 vs system 54:17 in session a49e4b18: server capture started 16:00:02Z and the upload came at 16:58Z, so the call really lasted about 54 minutes.
- The mic webm packets are contiguous up to 971.6 s and then stop, while the system track has speech throughout; the mic device track stopped delivering audio mid-call (device switch/disconnect) and Chromium's MediaRecorder stopped advancing without firing stop.
- Fix (client FileUpload.tsx): the mic is recorded through a Web Audio graph (MediaStreamAudioDestinationNode) that keeps producing silence, so the mic file keeps wall-clock length.
- When the mic track fires 'ended', the recorder re-acquires the same mic or the default one, reconnects it to the graph and shows a mic notice.
- If the AudioContext cannot run (autoplay policy in a plain browser tab), recording falls back to the raw mic track.

## Route-Specific Constraints

- Never call a third-party speech-to-text API as a fallback or supplement to whisper.cpp — see project-context/architecture/README.md invariants.
- Timestamp offsets from whisper-cli --output-json-full in this build are milliseconds — convert correctly before formatting [HH:MM:SS] lines.
- On Windows, non-ASCII paths must be converted to 8.3 short paths via toSafePath; toSafePath is a passthrough on macOS.
- Dual-track sessions store audio as audio-mic.{ext} and audio-system.{ext}; single-track sessions store audio as audio.{ext}.
- alignDualSegments shifts the later-starting track forward by |systemOffsetMs| (positive → system segments, negative → mic segments) so the earlier track defines t=0; segments are clamped at 0.
- systemOffsetMs comes only from the server-capture upload path (captureId + micStartedAt); it is absent (treated as 0) for browser dual recordings and file uploads.
- Retranscribe re-applies the stored systemOffsetMs — never recompute it from file durations.
- Never add diagnostic lines (offsets, engine names, timings) to the transcript header; put such data in session.json metadata instead.
- ensureWav derives the output filename from the input basename — never hardcode audio.wav, which would collide in dual-track sessions.
- Boosted filenames use the pattern {basename}-boosted.wav — findAudioFiles must never match these as original audio (verified: startsWith('audio.') / 'audio-mic.' / 'audio-system.' excludes '-boosted' variants).
- On Windows, boostAudio must use toSafePath for both input and output paths — same non-ASCII crash risk as whisper-cli.

## Key files

- server/src/services/whisper.ts — runWhisper (single whisper-cli invocation), flags, JSON parsing, ffmpeg helpers.
- server/src/routes/sessions.ts — session API endpoints including upload and retranscribe.
- server/src/services/transcriptMerger.ts — filtering, dedup, join, and markdown rendering logic; also holds alignedDualDuration and describeTrackMismatch.
- server/src/services/gpuBackend.ts — GPU policy, fallback, and the Vulkan-only banner rule.
- client/src/components/FileUpload.tsx — mic Web Audio recording graph with re-acquire on 'ended'.
- client/src/components/TranscriptView.tsx — shows the session.trackWarning notice.
- server/src/services/performanceTracker.ts — rolling speed ratio tracking and ETA estimation.

## Child Routes

### Live Transcription
Real-time WebSocket-based transcription during a live call — chunked audio capture, server-side whisper invocation, and a slide-out transcript panel.
Directory Path: project-context/transcription/live-transcription/

### Whisper Setup
Per-platform whisper-cli binaries, the npm run setup script, model auto-download with SHA256 verification and SSE progress, and ffmpeg pre-flight.
Directory Path: project-context/transcription/whisper-setup/
