# Live Transcription Domain

## TL;DR
- Live transcription streams real-time audio chunks over a WebSocket at /api/live-transcribe to either local whisper-cli or the Groq Whisper API.
- The user selects a transcription engine (Local or Groq) when choosing Live mode; Groq is shown only when GROQ_API_KEY is configured.
- With System audio source = Browser, the browser taps mic (Me) and system (Them) MediaStreams via ScriptProcessorNode, resamples to 16kHz, and sends 4-second chunks.
- With System audio source = System (AUG-113), the server tees its own capture into the live pipeline as Them; the browser sends only mic chunks.
- Live mode with a server capture shows no screen picker; the client binds the capture with an attach-capture control frame.
- A binary WebSocket protocol encodes speaker identity, language, and Float32 PCM in each frame.
- ChunkAccumulator uses 4 s windows with 1 s overlap and a frame-based speech gate (hasEnoughSpeech) before sending, to local whisper or Groq (AUG-127).
- The server queues at most 6 chunks per connection; 3 consecutive failures trigger interrupted status.
- Groq fallback: rate limits (20 req/min) and transient errors (403 region/VPN, 5xx, network) fall back to local whisper for that chunk only, the next chunk tries Groq again; only a missing or rejected key (401) switches the connection to local permanently (AUG-164).
- Key files: server/src/services/liveTranscription.ts, server/src/services/groqTranscription.ts, client/src/services/liveTranscriptionClient.ts.
- Key files also include server/src/services/liveChunking.ts (server ChunkAccumulator, LivePcmFeeder, control-frame parser) and attachLiveSink in server/src/services/systemCapture.ts.
- Key files also include server/src/services/liveTextCorrection.ts and server/src/services/groqText.ts (AUG-164).
- Post-recording full-file transcription remains local whisper only — Groq whisper is exclusively a live mode option.
- Online text correction (AUG-164, opt-in with consent): when Settings → Transcription → Online text correction (Groq) is on, settled live chunks go to Groq openai/gpt-oss-20b.
- Settled chunks are at least 8 s old, never the newest, sent every 12 s, and replaced in place with a 2 s yellow flash.
- Live corrections are never persisted, and Groq limits or errors skip silently.
- Also known as: online text correction, live text correction, Groq LLM correction, groqText (AUG-164).
- Live transcript fills the whole main area while visible (AUG-154): a 48px top bar holds the rec dot + timer, status, Pause/Resume (yellow), Copy All (green), Clear All (red frame), Stop Live (red frame), End Recording (red filled) and × hide; the circuit diagram is hidden (not unmounted) behind it.
- Stop and Clear All require a confirmation dialog ("Are you sure?") before executing.
- Live local chunks run whisper-cli with Silero VAD (vad: true in transcribeChunk); a chunk with no detected speech emits no line (AUG-127).
- Live text has no overlap dedup, so words in the 1 s overlap appear twice in consecutive lines (AUG-126).
- Groq is called with response_format=text, so no_speech_prob is discarded and cannot gate hallucinations (AUG-126).
- Two tracks at a 3 s hop reach about 20 Groq requests per minute; overflow chunks fall back to local whisper with VAD (AUG-126, AUG-127).
- Fix proposals live in project-context/transcription/phantom-lines-research/.

One-sentence description: Real-time audio-to-transcript streaming during a live call via WebSocket, with pluggable transcription engines (local whisper-cli or Groq Whisper API).

## Purpose

Document the mechanics of the live transcription mode — how audio is captured in the browser, transported to the server, transcribed chunk-by-chunk, and displayed in a real-time panel alongside the existing recording UI.

## Core Concepts

- Recording mode selection: when the user clicks Record, a RecordingModePicker modal offers Default (post-recording transcription) or Live Transcription mode.
- Transcription engine selection: when Live is selected, RecordingModePicker keeps the mode ring visible (DEFAULT dimmed, LIVE active) and shows two engine sub-arcs on an outer ring to the right — top: LOCAL (green), bottom: GROQ (red). Groq arc appears dimmed with "setup required" sublabel when GROQ_API_KEY is not configured.
- LiveEngine type: 'local' | 'groq' — chosen in the UI, sent to the server via a {type: "config", engine} JSON control message on WebSocket open.
- Groq transcription service: server/src/services/groqTranscription.ts POSTs audio chunks to Groq's /openai/v1/audio/transcriptions endpoint using whisper-large-v3 model; uses Node.js native fetch/FormData.
- Groq rate limiter: a sliding-window counter (20 requests per 60-second window) checked client-side on the server before each API call.
- LiveTranscriptionClient: an imperative class (not a React hook) in client/src/services/liveTranscriptionClient.ts that owns the WebSocket connection and Web Audio graph.
- Audio capture: ScriptProcessorNode taps raw PCM from mic and system MediaStreams without modifying the MediaRecorder pipeline.
- Resampling: linear interpolation from the browser's native sample rate (typically 48kHz) down to 16kHz, because browsers do not reliably honor AudioContext sampleRate for graphs connected to existing MediaStreamTracks.
- ChunkAccumulator: accumulates resampled samples into fixed 64000-sample (4s) windows with 16000-sample (1s) overlap carried into the next window.
- Speech gate (AUG-127): a window is sent only when it holds at least 200 ms of speech; otherwise it is discarded before any engine sees it.
- Speech gate frames: 20 ms (320 samples); a frame is loud when its RMS exceeds 0.006.
- Speech gate runs: only contiguous loud runs of at least 160 ms count as speech; shorter runs are transients (clicks, thumps, keystrokes).
- Speech gate why: whole-window RMS let one transient in a silent 4 s mic window through, and whisper hallucinated "Okay." on it (AUG-126).
- Speech gate thresholds come from session e1ebe18a: phantom window 1330 s has 440 ms of scattered transients (longest run 140 ms); real word window 1876 s has one 220 ms run.
- Do not raise the RMS level instead: quiet speech near window RMS 0.006–0.01 would be lost; the frame gate keeps a quiet 1.5 s utterance at window RMS 0.005.
- Do not blacklist "okay"/"so" to fight phantoms: real short replies are valid; the fix judges audio, not words.
- The gate exists twice and must stay identical: client/src/services/liveTranscriptionClient.ts (browser mic/system) and server/src/services/liveChunking.ts (server-captured system, unit-tested).
- ChunkAccumulator.flush (server only) applies the same speech gate to the partial tail window.
- Silero VAD on live chunks: a missing VAD model logs one warning per process and live keeps transcribing without VAD.
- The speech gate cannot reject loud non-speech events (~1 s breath/noise); on local whisper Silero VAD removes them, on Groq they still cost a request and may produce text.
- Replay result (AUG-127, mic 1300–1900 s): zero emitted "Okay." lines; real speech windows 1864–1879 s all produce text.
- Groq rate on e1ebe18a (both tracks, 197 min): mean 19.7 → 19.1 req/min, max 34 → 31, minutes over 20: 58 → 54; replay slice max 20 → 19.
- Silent gain node: ScriptProcessorNode is routed through a GainNode with gain=0 to the AudioContext destination — required for onaudioprocess to fire reliably, but produces no audible output.
- Binary WebSocket frame format: byte 0 = speaker (0=Them, 1=Me), byte 1 = language string length (L), bytes 2..2+L = UTF-8 language code, remainder = Float32 PCM samples in little-endian.
- Server WebSocket handler: server/src/services/liveTranscription.ts upgrades HTTP connections at /api/live-transcribe using the ws library.
- Server-side transcription: each chunk is written as a temporary 16kHz mono 16-bit WAV file in server/data/live-tmp/, routed to either local whisper-cli or Groq based on the connection's engine setting, then the temp files are deleted.
- Filler and hallucination filtering: the server reuses FILLER_ONLY_TEXTS, isHallucination, and normalize from transcriptMerger.ts to filter live chunks identically to the batch pipeline.
- JSON control messages: the client sends {type: "config", engine}, {type: "pause"}, {type: "resume"}, {type: "stop"} as text frames; the server sends {type: "transcript", id, speaker, text}, {type: "correction", id, text} (AUG-164), {type: "warning", message}, and {type: "error", message} back.
- attach-capture control frame (AUG-113): the client sends {type: "attach-capture", captureId, language} as a text frame right after the config frame when the recording uses a server capture; the server replies {type: "capture-attached", captureId} or a {type: "warning"} ("System audio not attached (...) — live transcript continues with the microphone only") when the captureId is unknown, already stopped, not started with live: true, or already attached.
- Server PCM tee: POST /api/capture/start { live: true } adds a second ffmpeg output (-f s16le -ac 1 -ar 16000 pipe:1) next to the unchanged WAV; systemCapture.ts drains stdout from spawn and forwards bytes to at most one CaptureLiveSink.
- LivePcmFeeder (server/src/services/liveChunking.ts) converts the s16le bytes to Float32 (carrying an odd trailing byte between chunks) and feeds a server-side ChunkAccumulator with the same 64000/16000/0.006 constants as the browser one; full windows are queued as speaker Them on the same per-connection queue and engine as mic chunks.
- LiveTranscriptPanel (client/src/components/LiveTranscriptPanel.tsx): an in-flow flex panel inside FileUpload's `.circuit-layout.live-open` that takes the full main area, with a 48px top bar and a scan-lined transcript canvas of interleaved Me/Them lines (15px, max-width 860px, accent left border on the latest line) with auto-scroll. FileUpload adds `live-open` only when liveActive && !liveHidden, and CSS hides every other circuit child except `.mic-notice` and `.upload-error`.
- Top bar button order: Pause/Resume, Copy All, Clear All, Stop Live, End Recording. Stop Live calls handleLiveStop (ends live transcription, recording continues); End Recording calls FileUpload's stopRecording (same as the circuit STOP node) with no confirmation. FileUpload passes `elapsed={formatTime(elapsedSeconds)}` and `onEndRecording={stopRecording}`.
- Button color scheme: Pause = yellow frame default / yellow fill on hover; Copy All = green frame default / green fill on hover; Stop Live and Clear All = red frame default / red fill on hover; End Recording = red filled (dark theme has explicit overrides so the generic dark .live-panel-btn reset does not drop the red).
- Confirmation dialog: clicking Stop Live or Clear All shows an inline confirmation bar ("Are you sure?") with "Yes, proceed" (red) and "No, return" (green) buttons instead of executing immediately.
- Clear All action: clears all transcript lines (setLiveLines([])) without stopping the WebSocket or audio capture — the session continues recording.
- Panel hide/reopen: closing the panel (×) sets liveHidden=true, hiding it without stopping the WebSocket or clearing lines. A pulsing LIVE badge appears in the recording info bar; clicking it sets liveHidden=false, reopening the panel with all accumulated lines intact. A separate Stop Live button in the top bar calls handleLiveStop to fully terminate the live client.
- Line coalescing: consecutive transcript results from the same speaker append to the previous line rather than creating a new line.
- HTTP server upgrade: server/src/index.ts creates an http.Server wrapping the Express app, passes it to setupLiveTranscription() for WebSocket upgrade handling, then calls httpServer.listen().

### Online text correction (AUG-164)

- LiveTextCorrector (server/src/services/liveTextCorrection.ts) is created per WebSocket connection only when isGroqTextActive() at connect time.
- Toggling Online text correction mid-session takes effect on the next live session.
- It applies to both live engines (local and Groq whisper); the Settings toggle is the opt-in.
- Every 12 s (LIVE_CORRECTION_INTERVAL_MS) it takes up to 8 chunks at least 8 s old (LIVE_SETTLE_MS), never the newest chunk, oldest first.
- Skipped batches are retried on the next tick until chunks are 90 s old (LIVE_MAX_AGE_MS), then dropped.
- Server transcript frames carry an id; corrections are sent as {type: "correction", id, text}.
- Client LiveLine has parts[] ({id, text, correctedAt}); a speaker line still merges consecutive chunks.
- A correction replaces one part in place and the line text is rebuilt.
- The correction unit is one chunk (a part of a line), not a whole merged speaker line.
- The corrected part stays in var(--status-uploading) with a dotted underline; hovering shows the recognized original in a CSS tooltip (data-original + ::after, "Original: …"; native title is unreliable in Electron; kept in LiveLinePart.original); the underline flashes for 2 s on arrival (CSS animation live-line-corrected); no dialog.
- Corrected text goes through Groq openai/gpt-oss-20b via groqText; consent, limits and skip reasons are documented in the architecture and preferences routes.

## Components

- LiveTextCorrector (component): part of liveTranscription; depends on groqText (AUG-164).

## Invariants

- Live transcription never modifies the MediaRecorder streams or the existing upload/transcription pipeline.
- The WebSocket endpoint is /api/live-transcribe — it handles upgrade requests on the shared HTTP server.
- When engine is 'local', live chunks are transcribed through the shared runWhisper() in whisper.ts, so flags (--max-context 0, GPU mode) always match the batch pipeline.
- Live chunks use the same process-wide GPU mode as batch jobs (GpuState in services/gpuBackend.ts); after a Vulkan failure flips the mode, every later chunk runs --no-gpu directly with no per-chunk retry.
- When engine is 'groq', chunks are sent to the Groq Whisper API; the filler/hallucination filtering pipeline runs identically on both engines' output.
- Path safety (Windows 8.3 short paths) is handled inside runWhisper, not in liveTranscription.ts.
- Temporary WAV files are written to server/data/live-tmp/ (ASCII-safe), not os.tmpdir() which may resolve to a Cyrillic path.
- The server drops queued chunks beyond MAX_QUEUE_LENGTH (6) to prevent backpressure buildup.
- Three consecutive whisper-cli failures on a connection trigger an error message and interrupted status.
- Groq rate-limit fallback is per-chunk: the engine stays 'groq' and retries Groq on the next chunk after falling back to local for one chunk.
- Groq API errors: a missing key or HTTP 401 (GroqApiError.fatal) permanently switches the connection's engine to 'local'; any other error (403, 5xx, network) is transient — that chunk is transcribed locally, the next one goes to Groq again, and one warning 'Groq did not respond — this part was transcribed locally' is shown per connection (AUG-164).
- A warning message ({type: "warning"}) is sent to the client on first rate-limit fallback and on permanent engine switch — not on every fallback chunk.
- The client reports onMicUnavailable when the mic stream is null or has no audio tracks — the panel shows "Them only" notice.
- Pause/resume is bidirectional: the client stops feeding chunks to the accumulator AND sends a JSON control message so the server can skip any queued work.
- LiveTranscriptionClient.stop() disconnects all Web Audio nodes, closes the AudioContext, sends a stop control message, and closes the WebSocket.
- The live panel closes automatically when recording stops (stopRecording sets liveActive and liveHidden to false).
- Closing the panel (×) hides it without stopping transcription — only the explicit Stop Live button or stopRecording (End Recording / circuit STOP) terminates the live client.
- Clear All clears displayed lines without stopping transcription, audio capture, or the WebSocket connection.
- Stop and Clear All both gate behind a shared confirmAction state ('stop' | 'clearAll' | null) — only one confirmation dialog can be active at a time.
- The Vite dev proxy must have ws: true on the /api proxy config for WebSocket upgrade forwarding.
- The binary WebSocket audio frame format is unchanged by AUG-113; attach-capture is a separate JSON text frame parsed by parseLiveControlFrame (malformed frames are ignored).
- Detach/flush order on stop: stopCapture() ends the tee first (sink.onEnd('stop') flushes the accumulator's partial window into the transcription queue when ≥0.5 s of fresh audio arrived), then stops ffmpeg and finalizes the WAV, so the post-recording dual-track transcript is produced exactly as for a non-live capture.
- Closing the WebSocket or sending stop only detaches the sink — the server capture keeps recording until POST /api/capture/stop; a WAV from a live-attached capture is format-identical (16 kHz mono pcm_s16le, 44-byte header) to a non-live one.
- One sink per capture: a second attach-capture for the same captureId gets a warning and the first binding stays.

## Route-Specific Constraints

- Data goes to Groq only through an explicit user choice: live audio only when the user selects the Groq engine, transcript text only when the user turned on Online text correction and accepted its consent (AUG-164). Neither is a default.
- Live corrections apply in place without dialogs and are never saved; transcript.md is built only by the batch path (AUG-164).
- Post-recording transcription remains strictly local whisper-cli — Groq is never used for full-file transcription (25MB limit makes it impractical).
- The Groq API key (GROQ_API_KEY) is read from environment variables only — never hardcoded or committed.
- The binary frame format is alignment-sensitive: Float32 samples are written sample-by-sample via DataView to avoid TypedArray 4-byte alignment issues with variable-length headers.
- The ws npm package is a server dependency (server/package.json); the client uses the browser's native WebSocket API.
- RecordingModePicker is shown only when starting a new recording, never during an active recording.
- Live transcription errors (WebSocket failures, whisper crashes) set the panel to interrupted status but never stop or affect the underlying MediaRecorder recording.

## Key Files

- server/src/services/liveTranscription.ts — WebSocket server, chunk decoding, WAV writing, engine routing, filtering; local whisper delegated to runWhisper().
- server/src/services/groqTranscription.ts — Groq Whisper API client with sliding-window rate limiter and typed error classes.
- client/src/services/liveTranscriptionClient.ts — LiveTranscriptionClient class, ChunkAccumulator, resampling, binary encoding, engine config messaging.
- client/src/components/LiveTranscriptPanel.tsx — real-time transcript display panel with auto-scroll, controls, and warning display.
- client/src/components/RecordingModePicker.tsx — two-step ring modal: inner ring (Default/Live), outer right-side sub-arcs (Local green / Groq red) when Live is active.
- client/src/components/FileUpload.tsx — integration point: mode selection, engine wiring, live client lifecycle, state management.
- server/src/index.ts — HTTP server creation and WebSocket upgrade setup.
- server/src/config.ts — groqApiKey config read from GROQ_API_KEY env var.
- server/src/routes/health.ts — exposes groqAvailable flag in health endpoint response.
- server/src/services/liveChunking.ts — ChunkAccumulator, speech gate (speechDurationMs/hasEnoughSpeech), PCM feeder, control-frame parser; tests in liveChunking.test.ts.
- server/src/services/systemCapture.ts — live PCM tee (LIVE_TEE_ARGS, CaptureLiveSink, attachLiveSink) for server-fed Them audio.
- server/src/services/liveTextCorrection.ts — LiveTextCorrector: per-connection batching of settled chunks, retry/drop by age, correction frames (AUG-164).
- server/src/services/groqText.ts — Groq openai/gpt-oss-20b text client with its own rate limiter and correction guard (AUG-164).
- client/src/components/GroqTextConsentModal.tsx — consent modal shown when the Online text correction toggle is turned on (AUG-164).
