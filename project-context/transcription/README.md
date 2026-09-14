# Transcription Route

## TL;DR
- whisper-cli (whisper.cpp), built for Windows and macOS, transcribes session audio locally; output is raw timestamped segments in milliseconds.
- runWhisper() in whisper.ts is the single whisper-cli invocation path for both batch and live transcription.
- TranscriptMerger filters hallucinations and filler, dedupes near-duplicate segments, and joins nearby segments into readable lines.
- stripCreditHallucination replaces the "Редактор субтитров А.Семкин Корректор А.Егорова" hallucination with [OOPS] via regex, not silent drop.
- A session moves through uploading, transcribing, then completed or failed — the client polls status until it leaves transcribing.
- Failed sessions can be retranscribed from the UI; the retranscribe endpoint runs a whisper-cli and model preflight check before flipping status.
- Dual-track recording (mic + system) produces one session; mergeDualStream interleaves both streams with [Me]/[Them] role labels.
- TranscriptMerger constants are a faithful port from SplitVox's C# implementation — never re-tune without re-validating against known audio.
- Single-track transcripts have no role prefix; dual-track transcripts prefix each line with [Me] or [Them].
- Active whisper child processes are tracked per session in a Map; cancelTranscription kills all tracked processes for a session.
- Audio boost mode applies ffmpeg preprocessing (highpass, lowpass, volume gain, loudnorm) to quiet mic tracks before whisper runs.
- performanceTracker.ts tracks rolling processingTime/audioDuration ratios (last 10) in data/perf-stats.json for ETA estimation.
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
- Dual-stream merge: mergeDualStream takes mic and system segments, tags them with roles (Me/Them), sorts chronologically, then applies the same dedup/join pipeline — joinAdjacentSameRole only joins segments with matching roles.
- Process tracking: whisper.ts maintains a Map<string, ChildProcess[]> keyed by session ID. Each transcribe() call registers its child process; dual-track sessions register two processes under the same key. Processes are deregistered in the execFile callback.
- Cancellation: cancelTranscription(sessionId) kills all tracked child processes for that session. The cancel endpoint (POST /api/sessions/:id/cancel) calls this and sets status to "failed" with "Cancelled by user". The catch block in runTranscription/runDualTranscription skips overwriting if status is already "failed" to avoid a race with the cancel endpoint.
- Failed-session recovery: when a session is in "failed" state, the UI shows a "Transcribe again" button with language and boost options. Clicking it calls POST /api/sessions/:id/retranscribe, which runs a preflight check (whisper-cli binary exists, model file exists) before flipping the session to "transcribing". If audio files are missing, the endpoint returns 400 and the UI shows "Audio file no longer exists" with the action disabled. The header Redo node also triggers retranscription independently.
- Orphan recovery: recoverOrphanedSessions() runs on server startup — any session in "transcribing" state with no active tracked process is moved to "failed" with an explanatory error message.
- Transcription metadata: SessionMetadata includes transcriptionStartedAt (ISO timestamp) and estimatedDuration (seconds), both set synchronously in the upload/retranscribe endpoint before the response — ensures the client has timer data immediately.
- Audio boost preprocessing: boostAudio() in whisper.ts applies an ffmpeg filter chain (highpass 100Hz, lowpass 4000Hz, 5x volume gain, loudnorm normalization) and converts to 16kHz mono WAV. Used when the retranscribe endpoint receives boost=true. Boosted files are saved as {basename}-boosted.wav next to the original and deleted after transcription completes.
- ffmpeg availability: checkFfmpegAvailable() probes ffmpeg at runtime. The /api/health endpoint reports ffmpegAvailable and ffmpegMessage (the shared FFMPEG_MISSING_MESSAGE when unavailable); the client disables the boost toggle when false. Server startup also logs FFMPEG_MISSING_MESSAGE as a pre-flight check. The retranscribe endpoint validates ffmpeg presence before accepting a boost request.
- Performance tracking: server/src/services/performanceTracker.ts records the ratio of processing time to audio duration after each completed transcription. Stores the last 10 entries in data/perf-stats.json, separated by single vs dual track. Used to estimate future transcription durations.
- ETA estimation: the upload/retranscribe endpoint calls getAudioDuration() (ffprobe) then getEstimatedDuration() (rolling average ratio: default 1.5x single, 2.85x dual-track) synchronously before responding — the response includes estimatedDuration so the client can render the Chronometer Ring immediately.
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
- --no-gpu on every platform except macOS Apple Silicon, which uses Metal.
- All whisper-cli spawning goes through runWhisper() — never duplicate invocation logic in callers.
- ffmpeg-missing errors use the shared FFMPEG_MISSING_MESSAGE with per-platform install commands.
- Transcription always runs as a background process — the API never blocks a request waiting for whisper-cli to finish.
- Timer metadata (transcriptionStartedAt, duration, estimatedDuration) must be set in the endpoint handler before responding — never in the fire-and-forget background function, or the client will miss the Chronometer Ring on first render.
- Retranscription reuses the session's existing audio file but allows a language override — the session's language field is updated to the chosen language.
- Retranscription defaults to Russian ('ru') when no language is explicitly specified in the request body.
- Retranscription cancels any active transcription for the session before starting a new one.
- Audio boost filter parameters are centralized in AUDIO_BOOST config (server/src/config.ts) — never hardcode filter values in the ffmpeg call.
- Boosted audio files ({basename}-boosted.wav) are temporary artifacts deleted in a finally block after transcription completes or fails.
- boostAudio replaces ensureWav in the pipeline when boost is active — it already produces 16kHz mono WAV output.
- The retranscribe API (POST /api/sessions/:id/retranscribe) accepts an optional boost boolean; when true, ffmpeg availability is validated before proceeding.
- The retranscribe endpoint validates whisper-cli and model presence before setting status to "transcribing" — prevents flip-then-fail loops.
- If the whisper model is mid-download, the retranscribe preflight returns the download percentage in the error message.
- A failed transcription never deletes or modifies the session's audio files — the <30s auto-delete rule applies only after successful completion.
- When a failed session has no audio files on disk, the UI disables the "Transcribe again" button and shows an explanatory message.
- For dual-track sessions with boost enabled, both mic and system tracks are boosted independently in parallel.
- The client renders a Chronometer Ring (Tomb Amber SVG progress ring) with MM:SS:mm countdown, elapsed time, and ETA during the transcribing state.
- The Chronometer Ring transitions from amber to red (#e05555) when < 60 seconds remain, and shows pulsing zeroed digits with "Exterminatus Initiated" at 0:00:00.
- When estimatedDuration is not available (no perf-stats.json yet), the client falls back to the original indeterminate shimmer bar.
- performanceTracker stores at most 10 entries and separates single-track from dual-track ratios — never mix them for estimation.
- The Cancel button calls POST /api/sessions/:id/cancel; the Restart button reuses the retranscribe endpoint with a language selection dropdown.

## Route-Specific Constraints

- Never call a third-party speech-to-text API as a fallback or supplement to whisper.cpp — see project-context/architecture/README.md invariants.
- Timestamp offsets from whisper-cli --output-json-full in this build are milliseconds — convert correctly before formatting [HH:MM:SS] lines.
- On Windows, non-ASCII paths must be converted to 8.3 short paths via toSafePath; toSafePath is a passthrough on macOS.
- Dual-track sessions store audio as audio-mic.{ext} and audio-system.{ext}; single-track sessions store audio as audio.{ext}.
- ensureWav derives the output filename from the input basename — never hardcode audio.wav, which would collide in dual-track sessions.
- Boosted filenames use the pattern {basename}-boosted.wav — findAudioFiles must never match these as original audio (verified: startsWith('audio.') / 'audio-mic.' / 'audio-system.' excludes '-boosted' variants).
- On Windows, boostAudio must use toSafePath for both input and output paths — same non-ASCII crash risk as whisper-cli.

## Key files

- server/src/services/whisper.ts — runWhisper (single whisper-cli invocation), flags, JSON parsing, ffmpeg helpers.
- server/src/routes/sessions.ts — session API endpoints including upload and retranscribe.
- server/src/services/transcriptMerger.ts — filtering, dedup, join, and markdown rendering logic.
- server/src/services/performanceTracker.ts — rolling speed ratio tracking and ETA estimation.

## Child Routes

### Live Transcription
Real-time WebSocket-based transcription during a live call — chunked audio capture, server-side whisper invocation, and a slide-out transcript panel.
Directory Path: project-context/transcription/live-transcription/

### Whisper Setup
Per-platform whisper-cli binaries, the npm run setup script, model auto-download with SHA256 verification and SSE progress, and ffmpeg pre-flight.
Directory Path: project-context/transcription/whisper-setup/
