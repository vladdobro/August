# Live Transcription Domain

## TL;DR
- Live transcription streams real-time audio chunks over a WebSocket at /api/live-transcribe to whisper-cli during recording.
- The browser captures mic (Me) and system (Them) audio via ScriptProcessorNode, resamples to 16kHz, and sends 4-second chunks.
- A binary WebSocket protocol encodes speaker identity, language, and Float32 PCM in each frame.
- ChunkAccumulator uses 4s windows with 1s overlap and RMS-based VAD silence gate (threshold 0.006) before sending.
- The server queues at most 6 chunks per connection; 3 consecutive whisper failures trigger interrupted status.
- Live transcription is fully isolated from the existing recording and post-recording transcription pipeline.
- Key files: server/src/services/liveTranscription.ts, client/src/services/liveTranscriptionClient.ts, client/src/components/LiveTranscriptPanel.tsx.
- The live panel supports hide/reopen: closing the panel hides it without stopping transcription; a LIVE badge in the recording bar reopens it.

One-sentence description: Real-time audio-to-transcript streaming during a live call via WebSocket and chunked whisper-cli invocations.

## Purpose

Document the mechanics of the live transcription mode — how audio is captured in the browser, transported to the server, transcribed chunk-by-chunk, and displayed in a real-time panel alongside the existing recording UI.

## Core Concepts

- Recording mode selection: when the user clicks Record, a RecordingModePicker modal offers Default (post-recording transcription) or Live Transcription mode.
- LiveTranscriptionClient: an imperative class (not a React hook) in client/src/services/liveTranscriptionClient.ts that owns the WebSocket connection and Web Audio graph.
- Audio capture: ScriptProcessorNode taps raw PCM from mic and system MediaStreams without modifying the MediaRecorder pipeline.
- Resampling: linear interpolation from the browser's native sample rate (typically 48kHz) down to 16kHz, because browsers do not reliably honor AudioContext sampleRate for graphs connected to existing MediaStreamTracks.
- ChunkAccumulator: accumulates resampled samples into fixed 64000-sample (4s) windows with 16000-sample (1s) overlap carried into the next window.
- RMS silence gate: chunks with RMS below 0.006 are discarded client-side and never sent to the server.
- Silent gain node: ScriptProcessorNode is routed through a GainNode with gain=0 to the AudioContext destination — required for onaudioprocess to fire reliably, but produces no audible output.
- Binary WebSocket frame format: byte 0 = speaker (0=Them, 1=Me), byte 1 = language string length (L), bytes 2..2+L = UTF-8 language code, remainder = Float32 PCM samples in little-endian.
- Server WebSocket handler: server/src/services/liveTranscription.ts upgrades HTTP connections at /api/live-transcribe using the ws library.
- Server-side transcription: each chunk is written as a temporary 16kHz mono 16-bit WAV file in server/data/live-tmp/, transcribed by whisper-cli with --output-json-full, then the temp files are deleted.
- Filler and hallucination filtering: the server reuses FILLER_ONLY_TEXTS, isHallucination, and normalize from transcriptMerger.ts to filter live chunks identically to the batch pipeline.
- JSON control messages: the client sends {type: "pause"}, {type: "resume"}, {type: "stop"} as text frames; the server sends {type: "transcript", speaker, text} and {type: "error", message} back.
- LiveTranscriptPanel: a fixed 340px right-side panel (client/src/components/LiveTranscriptPanel.tsx) displaying interleaved Me/Them lines with auto-scroll, pause/resume, copy-all, and explicit Stop button.
- Panel hide/reopen: closing the panel (×) sets liveHidden=true, hiding it without stopping the WebSocket or clearing lines. A pulsing LIVE badge appears in the recording info bar; clicking it sets liveHidden=false, reopening the panel with all accumulated lines intact. A separate Stop button in the panel calls handleLiveStop to fully terminate the live client.
- Line coalescing: consecutive transcript results from the same speaker append to the previous line rather than creating a new line.
- HTTP server upgrade: server/src/index.ts creates an http.Server wrapping the Express app, passes it to setupLiveTranscription() for WebSocket upgrade handling, then calls httpServer.listen().

## Invariants

- Live transcription never modifies the MediaRecorder streams or the existing upload/transcription pipeline.
- The WebSocket endpoint is /api/live-transcribe — it handles upgrade requests on the shared HTTP server.
- Live chunks are transcribed through the shared runWhisper() in whisper.ts, so flags (--max-context 0, platform GPU rule) always match the batch pipeline.
- Path safety (Windows 8.3 short paths) is handled inside runWhisper, not in liveTranscription.ts.
- Temporary WAV files are written to server/data/live-tmp/ (ASCII-safe), not os.tmpdir() which may resolve to a Cyrillic path.
- The server drops queued chunks beyond MAX_QUEUE_LENGTH (6) to prevent backpressure buildup.
- Three consecutive whisper-cli failures on a connection trigger an error message and interrupted status.
- The client reports onMicUnavailable when the mic stream is null or has no audio tracks — the panel shows "Them only" notice.
- Pause/resume is bidirectional: the client stops feeding chunks to the accumulator AND sends a JSON control message so the server can skip any queued work.
- LiveTranscriptionClient.stop() disconnects all Web Audio nodes, closes the AudioContext, sends a stop control message, and closes the WebSocket.
- The live panel closes automatically when recording stops (stopRecording sets liveActive and liveHidden to false).
- Closing the panel (×) hides it without stopping transcription — only the explicit Stop button or stopRecording terminates the live client.
- The Vite dev proxy must have ws: true on the /api proxy config for WebSocket upgrade forwarding.

## Route-Specific Constraints

- Never send live audio chunks to a third-party API — all transcription runs through the local whisper-cli binary.
- The binary frame format is alignment-sensitive: Float32 samples are written sample-by-sample via DataView to avoid TypedArray 4-byte alignment issues with variable-length headers.
- The ws npm package is a server dependency (server/package.json); the client uses the browser's native WebSocket API.
- RecordingModePicker is shown only when starting a new recording, never during an active recording.
- Live transcription errors (WebSocket failures, whisper crashes) set the panel to interrupted status but never stop or affect the underlying MediaRecorder recording.

## Key Files

- server/src/services/liveTranscription.ts — WebSocket server, chunk decoding, WAV writing, filtering; whisper invocation delegated to runWhisper().
- client/src/services/liveTranscriptionClient.ts — LiveTranscriptionClient class, ChunkAccumulator, resampling, binary encoding.
- client/src/components/LiveTranscriptPanel.tsx — real-time transcript display panel with auto-scroll and controls.
- client/src/components/RecordingModePicker.tsx — modal for choosing Default vs Live Transcription recording mode.
- client/src/components/FileUpload.tsx — integration point: mode selection, live client lifecycle, state management.
- server/src/index.ts — HTTP server creation and WebSocket upgrade setup.
