# Live Transcription Domain

## TL;DR
- Live transcription streams real-time audio chunks over a WebSocket at /api/live-transcribe to either local whisper-cli or the Groq Whisper API.
- The user selects a transcription engine (Local or Groq) when choosing Live mode; Groq is shown only when GROQ_API_KEY is configured.
- The browser captures mic (Me) and system (Them) audio via ScriptProcessorNode, resamples to 16kHz, and sends 4-second chunks.
- A binary WebSocket protocol encodes speaker identity, language, and Float32 PCM in each frame.
- ChunkAccumulator uses 4s windows with 1s overlap and RMS-based VAD silence gate (threshold 0.006) before sending.
- The server queues at most 6 chunks per connection; 3 consecutive failures trigger interrupted status.
- Groq fallback: rate limit (20 req/min) falls back to local whisper per-chunk; API errors switch engine to local permanently for that connection.
- Key files: server/src/services/liveTranscription.ts, server/src/services/groqTranscription.ts, client/src/services/liveTranscriptionClient.ts.
- Post-recording full-file transcription remains local whisper only — Groq is exclusively a live mode option.
- Live panel buttons are a 2×2 grid: Pause (yellow) + Copy All (green) top row, Stop (red filled) + Clear All (red frame) bottom row.
- Stop and Clear All require a confirmation dialog ("Are you sure?") before executing.

One-sentence description: Real-time audio-to-transcript streaming during a live call via WebSocket, with pluggable transcription engines (local whisper-cli or Groq Whisper API).

## Purpose

Document the mechanics of the live transcription mode — how audio is captured in the browser, transported to the server, transcribed chunk-by-chunk, and displayed in a real-time panel alongside the existing recording UI.

## Core Concepts

- Recording mode selection: when the user clicks Record, a RecordingModePicker modal offers Default (post-recording transcription) or Live Transcription mode.
- Transcription engine selection: when Groq is available (GROQ_API_KEY configured, reported via /api/health's groqAvailable flag), RecordingModePicker shows a second sub-step ring (Local / Groq) after selecting Live mode.
- LiveEngine type: 'local' | 'groq' — chosen in the UI, sent to the server via a {type: "config", engine} JSON control message on WebSocket open.
- Groq transcription service: server/src/services/groqTranscription.ts POSTs audio chunks to Groq's /openai/v1/audio/transcriptions endpoint using whisper-large-v3 model; uses Node.js native fetch/FormData.
- Groq rate limiter: a sliding-window counter (20 requests per 60-second window) checked client-side on the server before each API call.
- LiveTranscriptionClient: an imperative class (not a React hook) in client/src/services/liveTranscriptionClient.ts that owns the WebSocket connection and Web Audio graph.
- Audio capture: ScriptProcessorNode taps raw PCM from mic and system MediaStreams without modifying the MediaRecorder pipeline.
- Resampling: linear interpolation from the browser's native sample rate (typically 48kHz) down to 16kHz, because browsers do not reliably honor AudioContext sampleRate for graphs connected to existing MediaStreamTracks.
- ChunkAccumulator: accumulates resampled samples into fixed 64000-sample (4s) windows with 16000-sample (1s) overlap carried into the next window.
- RMS silence gate: chunks with RMS below 0.006 are discarded client-side and never sent to the server.
- Silent gain node: ScriptProcessorNode is routed through a GainNode with gain=0 to the AudioContext destination — required for onaudioprocess to fire reliably, but produces no audible output.
- Binary WebSocket frame format: byte 0 = speaker (0=Them, 1=Me), byte 1 = language string length (L), bytes 2..2+L = UTF-8 language code, remainder = Float32 PCM samples in little-endian.
- Server WebSocket handler: server/src/services/liveTranscription.ts upgrades HTTP connections at /api/live-transcribe using the ws library.
- Server-side transcription: each chunk is written as a temporary 16kHz mono 16-bit WAV file in server/data/live-tmp/, routed to either local whisper-cli or Groq based on the connection's engine setting, then the temp files are deleted.
- Filler and hallucination filtering: the server reuses FILLER_ONLY_TEXTS, isHallucination, and normalize from transcriptMerger.ts to filter live chunks identically to the batch pipeline.
- JSON control messages: the client sends {type: "config", engine}, {type: "pause"}, {type: "resume"}, {type: "stop"} as text frames; the server sends {type: "transcript", speaker, text}, {type: "warning", message}, and {type: "error", message} back.
- LiveTranscriptPanel: a fixed 340px right-side panel (client/src/components/LiveTranscriptPanel.tsx) displaying interleaved Me/Them lines with auto-scroll and a 2×2 button grid.
- Panel button grid layout: Row 1 = Pause/Resume + Copy All; Row 2 = Stop + Clear All. CSS uses grid-template-columns: 1fr 1fr.
- Button color scheme: Pause = yellow frame default / yellow fill on hover; Copy All = green frame default / green fill on hover; Stop = red filled always; Clear All = red frame default / red fill on hover.
- Confirmation dialog: clicking Stop or Clear All shows an inline confirmation bar ("Are you sure?") with "Yes, proceed" (red) and "No, return" (green) buttons instead of executing immediately.
- Clear All action: clears all transcript lines (setLiveLines([])) without stopping the WebSocket or audio capture — the session continues recording.
- Panel hide/reopen: closing the panel (×) sets liveHidden=true, hiding it without stopping the WebSocket or clearing lines. A pulsing LIVE badge appears in the recording info bar; clicking it sets liveHidden=false, reopening the panel with all accumulated lines intact. A separate Stop button in the panel calls handleLiveStop to fully terminate the live client.
- Line coalescing: consecutive transcript results from the same speaker append to the previous line rather than creating a new line.
- HTTP server upgrade: server/src/index.ts creates an http.Server wrapping the Express app, passes it to setupLiveTranscription() for WebSocket upgrade handling, then calls httpServer.listen().

## Invariants

- Live transcription never modifies the MediaRecorder streams or the existing upload/transcription pipeline.
- The WebSocket endpoint is /api/live-transcribe — it handles upgrade requests on the shared HTTP server.
- When engine is 'local', live chunks are transcribed through the shared runWhisper() in whisper.ts, so flags (--max-context 0, platform GPU rule) always match the batch pipeline.
- When engine is 'groq', chunks are sent to the Groq Whisper API; the filler/hallucination filtering pipeline runs identically on both engines' output.
- Path safety (Windows 8.3 short paths) is handled inside runWhisper, not in liveTranscription.ts.
- Temporary WAV files are written to server/data/live-tmp/ (ASCII-safe), not os.tmpdir() which may resolve to a Cyrillic path.
- The server drops queued chunks beyond MAX_QUEUE_LENGTH (6) to prevent backpressure buildup.
- Three consecutive whisper-cli failures on a connection trigger an error message and interrupted status.
- Groq rate-limit fallback is per-chunk: the engine stays 'groq' and retries Groq on the next chunk after falling back to local for one chunk.
- Groq API errors (missing key, HTTP 500, network failures) permanently switch the connection's engine to 'local' for the remainder of the session.
- A warning message ({type: "warning"}) is sent to the client on first rate-limit fallback and on permanent engine switch — not on every fallback chunk.
- The client reports onMicUnavailable when the mic stream is null or has no audio tracks — the panel shows "Them only" notice.
- Pause/resume is bidirectional: the client stops feeding chunks to the accumulator AND sends a JSON control message so the server can skip any queued work.
- LiveTranscriptionClient.stop() disconnects all Web Audio nodes, closes the AudioContext, sends a stop control message, and closes the WebSocket.
- The live panel closes automatically when recording stops (stopRecording sets liveActive and liveHidden to false).
- Closing the panel (×) hides it without stopping transcription — only the explicit Stop button or stopRecording terminates the live client.
- Clear All clears displayed lines without stopping transcription, audio capture, or the WebSocket connection.
- Stop and Clear All both gate behind a shared confirmAction state ('stop' | 'clearAll' | null) — only one confirmation dialog can be active at a time.
- The Vite dev proxy must have ws: true on the /api proxy config for WebSocket upgrade forwarding.

## Route-Specific Constraints

- Live audio chunks may be sent to the Groq Whisper API only when the user explicitly selects the Groq engine — this is an opt-in toggle, never a default.
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
- client/src/components/RecordingModePicker.tsx — two-step ring modal: mode selection (Default/Live) then engine selection (Local/Groq).
- client/src/components/FileUpload.tsx — integration point: mode selection, engine wiring, live client lifecycle, state management.
- server/src/index.ts — HTTP server creation and WebSocket upgrade setup.
- server/src/config.ts — groqApiKey config read from GROQ_API_KEY env var.
- server/src/routes/health.ts — exposes groqAvailable flag in health endpoint response.
