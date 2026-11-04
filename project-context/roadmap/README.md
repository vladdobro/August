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

## Rodion feedback (Nov 2026)

Turn the 1–2 Nov 2026 user feedback (@docs/feedback/2026-11-rodion-feedback.md) into agreed work: every item starts as a research task, and a research task closes only when an agreed implementation task is created — its ID is then appended to the item line as "→ impl AUG-NNN". UI items are agreed on a self-contained HTML mockup in docs/mockups/AUG-NNN/, and the implementation task links the chosen variant.

### M1 Quick fixes

- [x] z-index overlap on Recording completed screen — Copy/Export menus are covered; research AUG-170 → impl AUG-180.
- [ ] Remember Praxis projects picked by folder — no re-picking the path in Send to Praxis; research AUG-171.
- [ ] Resizable Default Prompt field — see the whole prompt while editing; research AUG-172.
- [ ] Split Online text correction toggle — live line correction and live action items on separate checkboxes; research AUG-173.

### M2 Live session control

- [x] Mic mute/unmute during a meeting — keep office noise out of the transcript without stopping recording; research AUG-174 → impl AUG-181 (macOS check pending in a release build).
- [x] Live mode Copy & Clear / Clear + clear confirmation + Stop Live protection — manage the live window without accidental loss; research AUG-175 → impl AUG-182 (one stop mechanic: every Stop Live Text / End Meeting control is a 1.5 s hold, incl. Ghost; wired Skip Clear Confirmation; Windows check passed, macOS pending).
- [x] Ghost Mode free X/Y drag + Stop Meeting protection — place the overlay anywhere, no accidental stop; research AUG-176 → impl AUG-187 (A magnetic edges, caption width resize, position in window-state.json; stop protection done in AUG-182: hold-to-stop END MEETING in Ghost Caption and Ghost Coin); Windows verified 2026-11-04, macOS pending in a release build.
- [ ] Post-100% processing spinner — show the job is still running after the progress bar ends; research AUG-177 → impl AUG-189 (Variant B tick sweep + server stage label under the ring; mockup docs/mockups/AUG-177/processing-spinner.html).

### M3 Compact Mode

- [ ] Compact Mode daily-use controls — add the buttons that make Compact Mode usable every day; research AUG-178 → impl AUG-188 (in-place widget switch, Start Live Text again, Ghost Caption copy + text size/opacity, Dock Square pause, action items → Praxis via the modal; mockup docs/mockups/AUG-178/compact-controls.html).

## Backlog

Items not yet assigned to a phase.

- [ ] Team/workspace support for multiple managers sharing meetings and content.
- [x] Notifications when transcription completes — native desktop notifications in the Electron shell (AUG-114); video/photo pending.
- [ ] Usage analytics dashboard for managers.
- [x] Compact Mode on recording — Settings → Compact mode; Variant A (Dock Strip / Dock Square, same window) and Variant B (Ghost Caption / Ghost Coin, ghost overlay with August in the tray); designed in AUG-155, implemented in AUG-156 (interactive verification on Windows and macOS pending).
