# Architecture Route

## TL;DR
- August web app is a React + Vite client talking to a Node.js/Express + TypeScript server over REST.
- Speech-to-text runs locally via whisper-cli (whisper.cpp) on Windows x64 and macOS arm64/x64, never a third-party AI API.
- Sessions are stored as folders on disk for the MVP — no PostgreSQL yet, no auth yet.
- Session CRUD includes create, list, get, delete, and rename (PATCH title update) via the REST API.
- Transcription runs as a background child process; the client polls session status every 5 seconds.
- Dev mode: server on port 3001 redirects non-API requests to Vite dev server on port 5173; open 5173 for the latest UI.
- Production mode: server serves the built client from client/dist via express.static.
- Agentation widget is mounted in App.tsx for dev mode only, gated by import.meta.env.DEV.
- The server loads the repo-root .env from config.ts before building config.

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

## Key implementation details

- Binaries live in whisper/bin/{win-x64,darwin-arm64,darwin-x64}/, installed by npm run setup (whisper.cpp v1.8.4), git-ignored.
- The whisper model ggml-large-v3-turbo.bin (~1.6GB) lives at whisper/models/ and is auto-downloaded on first server start — see project-context/transcription/whisper-setup/.
- Windows non-ASCII paths are converted to 8.3 short paths via a toSafePath helper before invoking the binary; toSafePath is a passthrough on macOS.
- The repo-root .env is loaded in config.ts before config is built; WHISPER_BIN_PATH and WHISPER_MODEL_PATH env vars override the default binary and model paths.
- Timestamp offsets in this build's whisper-cli --output-json-full output are milliseconds, not centiseconds — do not assume centiseconds when reading segment timestamps.
- The browser recorder supports selecting a microphone and an optional "Capture system audio" toggle — when enabled, getDisplayMedia() captures system audio and both tracks are recorded as separate files, then uploaded together in a single request to create one session with dualTrack: true.
- Dual-track sessions transcribe mic and system audio in parallel, then mergeDualStream interleaves segments chronologically with [Me]/[Them] role labels.
- Sessions shorter than 30 seconds are auto-deleted by the server after transcription completes (likely wrong audio source in dual-track recording).
- Sessions can be renamed via PATCH /api/sessions/:id with a JSON body { title }; the client triggers this by double-clicking the session title in the sidebar.
- Dev/prod static serving: when NODE_ENV !== 'production' (dev mode), server/src/index.ts redirects browser requests to the Vite dev server at http://127.0.0.1:5173 instead of serving stale client/dist files; in production, express.static serves client/dist normally.

## Key files

- server/src/index.ts — Express app entry point and route wiring.
- server/src/services/whisper.ts — whisper-cli child_process invocation (runWhisper) and JSON output parsing.
- server/src/services/transcriptMerger.ts — filtering, dedup, and join logic that turns raw segments into a transcript.
- server/src/services/sessionManager.ts — session folder lifecycle (create, read, update status).
- client/src/App.tsx — client app shell and top-level routing/state.
- client/src/vite-env.d.ts — Vite client type declarations (import.meta.env).
- server/src/config.ts — platform binary resolution, model constants, .env loading.

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
