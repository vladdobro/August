# context-router.md Purpose

- context-router.md serves as the mandatory primary entry point and high-level compass for any LLM or AI agent interacting with this repository. It functions as a root router, directing the AI to the appropriate route-specific documentation to understand the project architecture, business logic, and execution rules. It ensures the AI loads only the necessary context by branching down into specific sub-routers.
- context-router.md is the Behavioral Rulebook and Architectural Compass for all AI agents or human beings working on this project.
- IMPLEMENTATION IS THE MAP, ROUTER IS THE COMPASS: Use search_project_context MCP tool and direct file reading to find WHERE files are. Use this context-router exclusively to understand WHY the architecture exists, HOW logical routes interact, and the strict rules you must follow.
- TRIGGER RULE: Whenever you work on a specific feature or entity, you MUST consult its corresponding route directory in this router to understand its business logic and constraints BEFORE making decisions, and completing the task.
- We don't need any other context, history, memory. We're starting from scratch!

August is a web and Electron desktop app that helps managers cut time lost to meeting transcription, video processing, and photo screening, built with a React frontend and a Node.js/Express backend, using self-hosted open-source AI models (whisper.cpp for transcription) for all inference. The app is now scaffolded with working client and server code; PostgreSQL is planned but the MVP currently uses file-based session storage.

# AI Agent Quick Start Protocol

Follow these steps in order before writing any code:

1. Read THIS file completely. The inline summaries below give you enough context to start.
2. Identify which routes your task touches using the Route Selection Guide below.
3. Read ONLY the README.md files for those routes (path given under each route entry).
4. Each route README starts with a TL;DR section — read that first. Go deeper only if your task requires it.
5. Use search_project_context MCP tool or read files directly to locate specific implementation files.
6. Begin implementation only after completing steps 1-5.

Do NOT read all routes. Do NOT skip straight to code. The TL;DR sections exist so you can quickly assess relevance without reading entire documents.

# Route Selection Guide

Match your task keywords to the routes you need to read:

| If your task involves... | Read these routes |
|---|---|
| product vision, target audience, MVP scope, feature planning | PRD |
| login, signup, manager accounts, sessions, permissions | Auth |
| meeting recordings, transcripts, meeting notes, speech-to-text | Meetings + Transcription |
| recorded video, video summaries, photo batches, image screening, vision models | Media Processing |
| what is this project, tech stack overview, onboarding a new agent | About |
| planned features, milestones, what shipped, what's next | Roadmap |
| meeting + media pipelines together (e.g. shared AI inference setup) | Meetings + Media Processing |
| web app structure, React, Node.js, Express, API, file upload, session storage | Architecture |
| whisper, transcription, speech-to-text, audio processing, transcript merging, hallucination filtering | Transcription |
| live transcription, real-time transcript, WebSocket audio, live recording mode, chunked whisper | Transcription > Live Transcription |
| whisper setup, npm run setup, whisper binary, model download, macOS, Windows, multiplatform, Metal GPU, ffmpeg install | Transcription > Whisper Setup |
| UI design, colors, theme, dark mode, light mode, CSS, styling, brandbook, emerald, jade | Frontend Design |
| preferences, settings, user defaults, auto-save, mic device, language selection, recording mode | Preferences |
| Electron, desktop app, installer, dmg, msi, tray, global hotkey, native notifications, auto-update, code signing, electron-builder | Desktop Shell |

# context-router.md terminology

- Context Router: This root file, providing a high-level map of the entire project.
- Route: A specific directory representing a business or technical module. It acts as a node in our architecture tree. Every route directory inherently contains its own context and must include a README.md file, which acts as its sub-router.
- Sub-router: The README.md file located inside any route directory. It acts exactly like the root context router but is isolated to its specific route. A sub-router can declare its own child routes (sub-directories), creating an infinitely deep nested structure where every node follows the same routing contract.

# Hierarchical routing principle

The routing system is a recursive tree with no depth limit. The flow is always: Router -> Route (Directory) -> Sub-router (README.md) -> Child Route (Directory) -> Child Sub-router (README.md), infinitely. Every node follows the exact same contract. Never skip a level when traversing. A route is never just a dead-end folder; if it has complexity, its sub-router will point you to the deeper child routes you need.

# Project terminology

- Application: the React frontend and Node.js/Express backend code that runs deterministically with no AI involvement — auth, data storage, routing, and UI. When a requirement states "Application must do X", the standard codebase handles X with no LLM or agent participation.
- Agent / Copilot / LLM: the self-hosted AI models (speech-to-text, vision) that process meeting audio, video, and photos. When a requirement states "Agent must do X" or "the model must do X", it means the self-hosted AI pipeline handles X, never a third-party AI API.

# Mandatory Execution Rules

- Always start context gathering from this file.
- Never guess or hallucinate business logic. You must navigate to the relevant route directory and read its sub-router (README.md) to acquire the correct context.
- Traverse the routing tree recursively. Every route directory may contain a README.md sub-router that declares its own child routes. Follow each relevant route downward, reading sub-routers at every level, until you reach the granularity required for the task. There is no depth limit; the hierarchy branches as deep as the project requires.
- PROJECT SPECIFIC RULE: Meeting recordings, video, photos, and transcripts must never be sent to a third-party AI API — all AI inference (transcription, video processing, photo screening) must run on self-hosted open-source models within our own infrastructure.
- Load Selectively: Open ONLY the specific documentation directories strictly required for your task/role. Do not load the entire project context.
- UPDATE TRIGGER (CRITICAL): If your task changes the fundamental business logic, data structure, or rules of a route, OR produces any important finding (architectural constraint, bug root cause with systemic implications, technical behavior that future agents must know to avoid mistakes), you MUST update the corresponding route documentation in project-context/ to reflect this new reality.
- Avoid files more than 500 strings in size for better performance and reliability.

# Project context map (Routes)

## About
High-level overview of what August is, who it is for, and its core tech stack.
Directory Path: project-context/about/README.md

## PRD (Product Requirements Document)
The source of truth for the product vision. It explains WHAT we are building, WHO we are working for, and the core problems we solve.
ALWAYS read this if your task involves planning new features, writing documentation, or understanding the product's core value proposition.
Directory Path: project-context/PRD/README.md

# Core Business Routes (Behavioral Rules)
ALWAYS read the corresponding route README.md before proceeding with the task related to it. Each README starts with a TL;DR — scan that first to confirm relevance, then read deeper sections as needed.

## Auth Route
Rules for manager account creation, login, sessions, and data-access scoping.
Directory Path: project-context/auth/README.md

## Meetings Route
Rules for turning recorded or live meetings into transcripts and structured notes via self-hosted AI.
Directory Path: project-context/meetings/README.md

## Media Processing Route
Rules for processing recorded video into key content and screening photo batches via self-hosted AI.
Directory Path: project-context/media-processing/README.md

## Architecture Route
Technical architecture of the React + Node.js web app, whisper.cpp integration, and file-based session storage.
Directory Path: project-context/architecture/README.md

## Transcription Route
Rules for the audio-to-transcript pipeline: whisper.cpp CLI integration, TranscriptMerger filtering, and session lifecycle.
Directory Path: project-context/transcription/README.md

## Frontend Design Route
Jade-emerald design system, CSS custom properties, dark/light theme toggle, and brandbook-derived visual patterns.
Directory Path: project-context/frontend-design/README.md

## Preferences Route
Server-side persistence of user preferences (language, mic, recording mode, etc.) with a Settings UI for review and reset.
Directory Path: project-context/preferences/README.md

## Desktop Shell Route
Electron desktop application: embedded Express server, tray, global record hotkey, native notifications, electron-builder packaging and GitHub Releases auto-update.
Directory Path: project-context/desktop-shell/README.md

## Roadmap
Planned and completed work items organized by phase and milestone.
Directory Path: project-context/roadmap/README.md

## AI Skills and Agents
Available tools and automated skills for the AI agent (e.g., setup scripts, actualizers).
Directory Path: .agents/skills/

# Rules for this file (context-router.md)

- Never use bold formatting in this file.
- Keep this file clear and concise.
- Never add granular feature-level routes to this file. Use search_project_context for detailed routing.
- For proper update of this file you MUST ALWAYS use .agents/skills/context-router-actualizer/SKILL.md
