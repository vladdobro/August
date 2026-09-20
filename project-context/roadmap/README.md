# Roadmap Route

## TL;DR
- Roadmap tracks planned and completed work organized by phase and milestone using checkbox notation.
- Use - [ ] for planned or in-progress items and - [x] for completed items in every phase.
- Phases are ordered chronologically: completed phases first, then active, then future phases.
- Key file: project-context/roadmap/README.md

This route documents August's planned and completed milestones, features, and release phases.

## Purpose

Track and communicate project progress. Gives AI agents and team members a single source of truth for what has shipped, what is in progress, and what is planned.

## Core Concepts

- Phase: a named grouping of related milestones (e.g., "MVP Foundation", "Beta").
- Milestone: a significant deliverable within a phase with a clear done state.
- Item: a specific feature, fix, or improvement — always expressed as a checkbox line.

## Invariants

- Every item uses checkbox format: - [ ] planned, - [x] completed. No plain bullet items.
- Completed items are never deleted; they serve as a permanent completion log.
- Phases are sorted chronologically: oldest/completed phases at the top, future phases at the bottom.
- Each item is a single actionable unit — compound items must be split into separate lines.

## Route-Specific Constraints

- Item format: - [ ] Feature name — brief description (why it matters or what it unlocks)
- Completed item format: - [x] Feature name — brief description
- Phase heading format: ## Phase Name
- Each phase opens with a one-sentence description of its goal before listing items.
- Speculative or wish-list items belong in a ## Backlog section, not in versioned phases.
- Phase naming uses milestone names (MVP, Beta, GA) since August is not yet versioned.

## MVP Foundation

Stand up the core web app skeleton and auth so the AI-driven features have a place to plug in.

- [x] PraxisOS project scaffolding — context-router, project-context, and task board initialized.
- [x] React frontend skeleton — base app shell with Vite, routing, session list, upload, transcript viewer.
- [x] Node.js/Express API skeleton — base server, session CRUD, health check, file upload endpoint.
- [x] Electron desktop shell — embedded server, tray, global hotkey, notifications, electron-builder installers, GitHub Releases auto-update (AUG-114).
- [ ] Auth route — manager account creation and login.

## MVP Core Features

Ship the three pillars of the product so managers get real time savings.

- [ ] Meeting transcription — upload or connect a recorded meeting and produce a transcript and structured notes.
- [ ] Video processing — ingest a recorded video and surface a summary or key moments.
- [ ] Photo screening — upload a batch of photos and surface the relevant ones.
- [ ] Self-hosted AI inference pipeline — deploy and wire up the open-source models backing all three features.

## Backlog

Items not yet assigned to a phase.

- [ ] Team/workspace support for multiple managers sharing meetings and content.
- [x] Notifications when transcription completes — native desktop notifications in the Electron shell (AUG-114); video/photo pending.
- [ ] Usage analytics dashboard for managers.
