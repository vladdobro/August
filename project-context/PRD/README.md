# PRD

## TL;DR
- PRD is Product Requirements Document
- PRD is the source of truth for August's product vision, target audience, and core problems solved.
- Read this route when planning features, writing documentation, or understanding the product's value proposition.
- Use [REQUIRES PRODUCT FILLING: no data in the code] for any missing information — never hallucinate.
- Key file: project-context/PRD/README.md

This route documents the product requirements and vision for August.

## Product Overview

### Problem Statement
* Managers lose significant time on repetitive operational work: manually writing up meeting notes, scrubbing through recorded video to find the relevant part, and reviewing photos or screenshots one by one to find what matters.

### Objectives & Goals
* Launch an MVP web app that automates meeting transcription, video processing, and photo screening for managers.
* [REQUIRES PRODUCT FILLING: no data in the code] — specific success metrics for the MVP (e.g. time saved per week, adoption target).

### Value Proposition
* August gives managers back the hours they currently spend on transcription, video review, and photo triage, by automating it with self-hosted AI.

## Target Audience

* Primary: managers and team leads who run recurring meetings and handle recorded video or image content as part of their role.
* [REQUIRES PRODUCT FILLING: no data in the code] — secondary audience / company size or industry focus.
* Primary context: at a desk, reviewing meeting output and recorded content between or after meetings.

## Behaviours

* Manager uploads or connects a recorded meeting; the app transcribes it and produces structured notes.
* Manager uploads or connects a recorded video; the app processes it and surfaces the key content.
* Manager uploads a batch of photos; the app screens them and surfaces the relevant ones.
* [REQUIRES PRODUCT FILLING: no data in the code] — exact user flows, triggers (manual upload vs. auto-capture), and output format per feature.

## Design & UX

### Design Assets
* [REQUIRES PRODUCT FILLING: no data in the code]

### Responsive & Adaptive Breakpoints
* [REQUIRES PRODUCT FILLING: no data in the code]

### Accessibility (a11y)
* [REQUIRES PRODUCT FILLING: no data in the code]

### Animations & Micro-interactions
* [REQUIRES PRODUCT FILLING: no data in the code]

### Technical Details

All technical details are stored in context-router.md

## Non-Functional Requirements

### Browser Support Matrix
* [REQUIRES PRODUCT FILLING: no data in the code]

### Performance Metrics
* [REQUIRES PRODUCT FILLING: no data in the code]

### SEO (Search Engine Optimization)
* Not applicable for the MVP — August is an authenticated internal tool, not a public-facing site.

## Analytics & Tracking

### Event Tracking Plan
* [REQUIRES PRODUCT FILLING: no data in the code]

## Out of Scope

* Mobile-native apps are out of scope for the MVP — web app only.
* Third-party cloud AI APIs are out of scope — all AI inference is self-hosted per the project's data-handling rule.
* [REQUIRES PRODUCT FILLING: no data in the code] — any additional features intentionally deferred past MVP.

## Milestones & Timeline

* See project-context/roadmap/README.md for phase-by-phase breakdown.

## Route-Specific Constraints

- Keep this file clear and concise. 1 general change must be described in 1-2 sentences maximum. If more details are needed — update documentation in project-context/ and link it here.
- Do not use bold formatting in this file.
- Do not use table formatting in this file.
- MUST NOT invent, assume, or hallucinate any business logic or requirements.
- Use [REQUIRES PRODUCT FILLING: no data in the code] for missing information.
- MUST NOT add, remove, or modify any structural sections from this skeleton.
