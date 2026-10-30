# About Route

## TL;DR
- August is a web app that helps managers cut time lost to meeting transcription, video review, and photo screening.
- Target audience is managers and team leads who run frequent meetings and review recorded video or image content.
- Core stack is React 18 + Vite client, Node.js/Express + TypeScript server, and local whisper.cpp v1.8.4 for transcription.
- The web app has working client/ and server/ directories; PostgreSQL and auth are still planned, not implemented.
- An Electron desktop shell in electron/ packages the same client and server into .dmg and .msi/.exe installers (see project-context/desktop-shell/README.md).
- Key files: project-context/PRD/README.md, project-context/roadmap/README.md, project-context/architecture/README.md

This route gives any agent a one-page orientation to what August is, who it serves, and what it is built with.

## Purpose

August exists to remove repetitive manual work from a manager's day: writing up meeting notes, scrubbing through recorded video for the relevant moment, and manually reviewing screenshots or photos taken during work. It automates these with AI so managers spend their time on decisions, not transcription.

## Core Concepts

- Manager: the primary user — a team lead or project manager running meetings and reviewing recorded content.
- Meeting transcription: converting recorded or live meeting audio into text and structured notes.
- Video processing: ingesting recorded video and extracting the information a manager needs from it (summaries, key moments).
- Photo screening: reviewing a batch of images to surface relevant ones and filter out noise.
- Local-first AI: all transcription, video, image and text inference runs on open-source models on the user's machine by default; a cloud engine (today Groq) is used only inside features the user explicitly opts into after a consent screen. Transcription currently runs via whisper.cpp (whisper-cli.exe) called locally by the server.

## Invariants

- August is a web application (React + Node.js), not a desktop or mobile-native app, for the MVP.
- Rule: everything is local unless the user decides otherwise; opt-in cloud features are off by default, need the user's own API credential, and never upgrade to a paid tier silently.
- Sessions are stored as file-based folders for the MVP — no PostgreSQL yet, and no auth yet; both are planned (see project-context/roadmap/README.md).

## Route-Specific Constraints

- This route is informational only — it does not define business logic, only project identity and orientation.
- Detailed product scope lives in project-context/PRD/README.md, not here.
- Detailed technical architecture lives in project-context/architecture/README.md, not here.
