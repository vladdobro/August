# Meetings Route

## TL;DR
- Meetings owns turning a recorded or live meeting into a transcript and structured notes for a manager.
- Transcription runs on a self-hosted open-source speech-to-text model, never a third-party AI API.
- A meeting record always belongs to exactly one manager and is never shared across accounts in the MVP.
- Key files: not yet created — planned per project-context/roadmap/README.md MVP Core Features phase.

This route governs how meeting audio becomes a transcript and structured notes a manager can act on.

## Purpose

Manually writing up meeting notes is one of the three core time-sinks August targets. This route owns the pipeline from a recorded meeting to a usable transcript, and the rules for how that data is stored and scoped.

## Core Concepts

- Meeting: a single recorded or live audio/video session submitted by a manager for transcription.
- Transcript: the raw speech-to-text output for a meeting.
- Structured notes: a summarized, organized version of the transcript (e.g. key points, action items).
- Processing pipeline: the self-hosted AI step that turns a meeting recording into a transcript and notes.

## Invariants

- Meeting audio, video, and transcripts are never sent to a third-party AI API — inference is self-hosted only.
- A meeting belongs to exactly one manager and is only ever readable by that manager.
- Transcription must run asynchronously — the manager submits a meeting and is notified when processing completes, never blocked waiting on it.

## Route-Specific Constraints

- [REQUIRES PRODUCT FILLING: no data in the code] — exact input method (file upload vs. live capture vs. calendar/meeting-tool integration).
- [REQUIRES PRODUCT FILLING: no data in the code] — which self-hosted speech-to-text model is used and its resource requirements.
- [REQUIRES PRODUCT FILLING: no data in the code] — retention policy for raw audio/video after transcription completes.
