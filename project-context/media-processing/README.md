# Media Processing Route

## TL;DR
- Media Processing owns turning recorded video into surfaced key content and screening photo batches for relevance.
- Video and photo inference both run on self-hosted open-source models, never a third-party AI API.
- Video processing and photo screening are two distinct pipelines sharing the same self-hosted AI constraint.
- Key files: not yet created — planned per project-context/roadmap/README.md MVP Core Features phase.

This route governs how recorded video and photo batches are processed so a manager doesn't have to review them manually.

## Purpose

Scrubbing through recorded video and reviewing photos one by one are the second and third time-sinks August targets. This route owns the pipelines that turn raw video and image input into something a manager can quickly act on.

## Core Concepts

- Video job: a recorded video submitted by a manager to be processed into a summary or key moments.
- Photo batch: a set of images submitted by a manager to be screened for relevance.
- Screening result: the filtered/ranked output of a photo batch — the images the model surfaced as relevant.
- Processing pipeline: the self-hosted AI step behind both video and photo jobs.

## Invariants

- Video and photo content are never sent to a third-party AI API — inference is self-hosted only.
- A video job or photo batch belongs to exactly one manager and is only ever readable by that manager.
- Both pipelines must run asynchronously — the manager submits content and is notified when processing completes.

## Route-Specific Constraints

- [REQUIRES PRODUCT FILLING: no data in the code] — exact output format for video processing (e.g. summary text, timestamped highlights, clip extraction).
- [REQUIRES PRODUCT FILLING: no data in the code] — what "relevant" means for photo screening (e.g. keyword/tag match, quality filter, duplicate removal).
- [REQUIRES PRODUCT FILLING: no data in the code] — which self-hosted vision model(s) are used and their resource requirements.
- [REQUIRES PRODUCT FILLING: no data in the code] — retention policy for raw video/photos after processing completes.
