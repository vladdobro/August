# AI Assistants (Meeting Copilot and Active project session)

> Research (AUG-193, 2026-11-05). Implemented so far: the Settings → AI assistants tab, the status probe and the assistant preferences / consents (AUG-198, 2026-11-06); the Active session, the august MCP server, LiveFeed, the side-by-side live columns and the compact Copilot / Assistant windows (AUG-199, 2026-11-06); the copilot engine, gate g2, hint cards and the compact Copilot window (AUG-197, 2026-11-06). Mockups: @docs/mockups/AUG-193/ai-assistants-settings.html and @docs/mockups/AUG-193/assistant-panel.html. User decision 2026-11-05: Copilot V3 (not V1 first), Active session as a persistent `claude -p` child under the user's Claude Code browser login (no API key), P1 overlay, Settings Option A with Sonnet default. Follow-up research with precise mockups: AUG-194 (Settings tab, done 2026-11-06 → implemented in AUG-198; final spec @docs/mockups/AUG-194/findings.md, mockup @docs/mockups/AUG-194/ai-assistants-tab.html), AUG-195 (Active session, done 2026-11-06 → impl AUG-199; spec @docs/mockups/AUG-195/findings.md, mockup @docs/mockups/AUG-195/assistant-overlay.html), AUG-196 (Copilot, done 2026-11-05 → impl AUG-197); implementation tasks come out of those. AUG-195 supersedes the P1 overlay of D4 and the AUG-196 compact A3/B3 widgets (D12). AUG-196 supersedes the copilot parts of D3, D7 and the Compact Mode rule below — its full spec (gate numbers, prompts, contracts) is @docs/mockups/AUG-196/findings.md; mockups @docs/mockups/AUG-196/copilot-hints.html and @docs/mockups/AUG-196/compact-assistant.html.

## TL;DR

- Two optional, default-off features: Meeting Copilot (watches the live transcript, surfaces matching notes from a chosen PraxisOS project) and Active project session (a chat with Claude Code bound to a chosen project during the meeting, can answer from project context, add action items and create Praxis tasks).
- Recommended architecture: one server-side `LiveFeed` per liveKey (ring buffer + subscribers) fed from liveTranscription.ts.
- Copilot (AUG-196 decision): four modes `aiCopilotMode` — Off (default) / Local hints / Claude explains (recommended) / Always-on Claude; choosing a Claude mode is the consent; model `aiCopilotModel` Haiku/Sonnet/Opus (Sonnet default), mode and model switchable during the meeting from the COPILOT column.
- Measured on real transcripts (AUG-196): local search alone with Russian speech against English project-context gave 0 [exact] hits in 28 searches; Claude (Sonnet) searching itself found the real note. Local-only mode stays for privacy but finds little in cross-language meetings.
- Copilot runs its own Claude child per (liveKey, project), separate from the chat child; it does not need the Active session to be on.
- Active session = one persistent `claude -p --input-format stream-json` child process per (liveKey, project); Praxis is reached by Claude itself through `--mcp-config` (http://127.0.0.1:7865/stream).
- Verified on Windows (AUG-195, 2026-11-06): the child works under the browser (OAuth) login with no API key; turn 1 with Praxis search 9.9 s / $0.12, later turns 3.6–4.3 s / $0.01; `--resume` after a hard kill keeps memory; `total_cost_usd` is cumulative per process. macOS is pending (Keychain).
- Layout (AUG-195 user decision): Action items, Copilot and Assistant are side-by-side columns, each collapsible, hideable and resizable during the meeting; in Compact Mode, Copilot and Assistant are separate movable, resizable windows that never overlap; the panel shows no money.
- August's own tiny MCP server (`august`) gives Claude `get_recent_transcript`, `list_action_items`, `add_action_item`.
- Measured on 2026-11-05 (Windows, Claude Code 2.1.318, Praxis MCP 1.30.0): Praxis MCP tool calls 0.07–0.15 s; one-shot `claude -p` 4–6 s wall; persistent stream-json session 3.2 s first turn, then 1.7–2.3 s per turn; one-shot with one Praxis tool call costs $0.003 on Haiku and re-sends ~15k system/tool tokens per spawn.
- Latency target for a copilot hint: ≤ 10 s from the spoken phrase (4–9 s of that is the existing 4 s chunk window + whisper), ≤ 1 s from the transcript line; with Claude explanation ≤ 15 s.
- Project is chosen after the session starts, in the ASSISTANT column; N projects = N tabs; ≤ 3 Claude child processes at once; copilot search loops are cheap and unlimited.
- Settings → new tab "AI assistants" (AUG-194 final, user-approved 2026-11-06): a Status section on top (Claude Code signed-in state + PraxisOS reachability, one Recheck button), the four-mode copilot list (AUG-196), the Active session toggle with Model / Spending limit per meeting / Transcript window children and a consent modal only for the session; both spending limits are free number fields in USD (real `.settings-input`), 0 = no limit; the Settings card widens to 680 px for all tabs; Claude copilot modes are disabled-but-visible while Claude Code is unusable.
- Claude Code detection (AUG-194): `claude --version` (55 ms) proves "installed"; `claude auth status` (JSON, `loggedIn`, 0.35 s) proves "signed in"; the probe env drops ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so billing stays on the user's Claude login; PraxisOS reachability = tokenless `GET http://127.0.0.1:7865/health`.
- Implemented (AUG-198): routes/assistant + claudeCli + assistantState on the server, AiAssistantsTab in Settings; the probe runs lazily on the first status request and is cached until Recheck; the copilot and the session read status and preferences from here.
- Implemented (AUG-199): one `claude -p` stream-json child per (liveKey, project) via ClaudeTransport + assistantSession; august MCP at POST /api/assistant/mcp/:token (loopback, token per tab, dies with the tab); LiveFeed fed from liveTranscription; ASSISTANT / COPILOT / ACTION ITEMS side-by-side columns; compact Copilot and Assistant windows. Not yet verified in a live meeting on Windows or macOS.
- Implemented (AUG-197): copilotEngine per (liveKey, project) fed by LiveFeed; gate g2 + keyword builder + limiter in copilotGate; local search over praxisMcpClient; Claude explains / Always-on children via buildCopilotArgs; copilot-* frames; COPILOT column hint cards and compact Copilot window. Unit-tested and typechecked only — not yet run in a live meeting on Windows or macOS.
- Default-mode recordings (AUG-200, 2026-11-06): a recording without a Live Text client (Default mode, or after Stop Live Text) opens a meeting-only socket on /api/live-transcribe (`action-items-init {meetingOnly: true}`) bound to the recording's liveKey; the main window shows ACTION ITEMS + ASSISTANT (no COPILOT) in a `mode="meeting"` LiveTranscriptPanel; items come only from the user and the Assistant; `get_recent_transcript` returns `lines: []` + a note. Unit-tested and typechecked only — not run in a real meeting on Windows or macOS.
- Also known as: copilotEngine, copilotGate, gate g2, praxisMcpClient, CopilotLimiter, CopilotChild, buildCopilotArgs, copilot-hint, copilot-status, copilot-open, copilot-dismiss, copilot-mode, AlwaysOnConfirmModal, hint card, checked silently, ASSISTANT column, COPILOT column, side-by-side columns, assistant overlay (superseded), compact Copilot window, compact Assistant window, assistant-task, error_max_budget_usd, session-proto, meeting copilot, copilot hints, context hints, active session, assistant panel, Claude session, claude -p, stream-json, Agent SDK, LiveFeed, august MCP server, add_action_item, AI assistants tab, Status section, Recheck, claude auth status, loggedIn, resolveClaudeCli, probeClaudeCli, Claude Code detection, not signed in, No limit, aiSessionEnabled, aiConsent, aiModel, aiSessionBudgetUsd, aiTranscriptWindowMin, aiCopilotMode, aiCopilotModel, aiCopilotAlwaysBudgetUsd, aiCopilotConsent, aiCopilotAlwaysAck, GET /api/assistant/status, POST /api/assistant/copilot-mode, AiAssistantsTab, assistantState, buildClaudeEnv, logged-out auth status, ClaudeTransport, assistantSession, aiChildPool, augustMcp, liveFeed, assistantStore, liveColumnsStore, assistantChannel, panelGeometry, assistant-task-done, assistant-item, meeting-only socket, meetingOnly, startMeeting, Default-mode action items, controlClient (AUG-193, AUG-194, AUG-195, AUG-196, AUG-198, AUG-199).

## Purpose

- Give any agent the agreed design, the measured numbers and the rejected paths for the Praxis deep-integration features, so implementation tasks don't re-decide launch mode, subscription point or consent model.

## Core Concepts

- Current live pipeline (verified in code): browser or server PCM → 4 s windows (1 s overlap, speech gate) → WebSocket `/api/live-transcribe` (server/src/services/liveTranscription.ts) → whisper-cli or Groq → filler filter → `send({type:'transcript', id, speaker, text})` at liveTranscription.ts:255-259.
  - Immediately followed by `corrector?.add(id, text)` (LiveTextCorrector, AUG-164) and `actionExtractor?.addTranscript(id, speaker, text)` (LiveActionItemsExtractor, AUG-165).
  - Corrections come back through the corrector callback (:195) and `noteCorrection`.
  - Prefs are read once per connection by `liveGroqTextFeatures()` (:191).
  - Stores are keyed by `liveKey` (client UUID per recording, shared by reconnects and Start Live Text again) in liveActionItems.ts (registry with refcount, pending file, retarget on upload).
  - Live text itself is never persisted.
- Subscription point (D1): a new `LiveFeed` per liveKey, pushed from the same three lines (transcript + correction).
  - Ring buffer of lines {id, speaker, text, at, corrected?} capped at 20 minutes or 6,000 words.
  - `subscribe(listener)` and `snapshot(windowMs)`.
  - Both assistants consume it; the existing corrector/extractor are untouched.
- Praxis access paths compared (D2):
  - A. Direct MCP Streamable HTTP from the August server: `POST http://127.0.0.1:7865/stream` with JSON-RPC (`initialize` → `mcp-session-id` header → `notifications/initialized` → `tools/call`).
    - Measured: initialize 0.20 s, `search_project_context` 0.15 s, `query_project_graph find` 0.09 s, `read_context_route tldr` 0.07 s, `health` answers "Claude CLI: available".
    - Dependencies: none beyond Node fetch.
    - Praxis off: ECONNREFUSED at once → feature shows "PraxisOS is not running" and retries every 30 s.
  - B. Claude CLI run in project_root with Praxis via `--mcp-config`: 4–6 s per one-shot, $0.003+ per call, needs Claude login; right for the Active session (Claude does its own retrieval), wrong for the copilot gate that may fire 12×/hour.
  - C. Reading project-context/ directly with an own BM25: fastest and works offline, but duplicates Praxis's search semantics (field boosts, fuzzy, graph) and drifts; rejected for v1, backlog if offline use matters.
  - Verdict: Copilot = A; Active session = B (Claude's own MCP connection).
  - Task creation from the UI button keeps the existing direct-file path (`createPraxisTask`, praxisIntegration.ts), which works without the Praxis server.
- Copilot loop (D3), three variants:
  - V1 "Local gate + Praxis search, no LLM" (recommended MVP).
    - Gate on the last ≤ 60 words of the feed: (a) reference phrases list `COPILOT_TRIGGERS` (ru: договаривались, договорились, в прошлый раз, как обсуждали, мы же решили, ты обещал, помнишь, на прошлой встрече, по задаче; en: we agreed, last time, as discussed, you promised, remember when, the ticket, the task), or (b) an explicit entity: task id `[A-Z]{2,4}-\d+`, `CMT-\d+`, quoted words, Latin capitalized words ≥ 4 chars.
    - Keywords = content words of the last 2 lines minus ru/en stopwords, ≤ 6 of them.
    - Calls `search_project_context(query)` and `query_project_graph(find, top keyword)`.
    - A card is shown only when the top hit is `[exact]` or ≥ 2 `[partial]` hits share one route.
    - Card: route name, up to 2 matching `L<N>` lines (≤ 160 chars each), buttons Open route (fetches `read_context_route tldr` on click), Ask assistant (prefills the active session), Dismiss (suppresses that route for the rest of the meeting).
    - Debounce: ≥ 20 s between searches per liveKey, ≤ 1 card per route per 5 min, ≤ 12 cards per hour, dedupe by route+line.
    - Latency ≤ 1 s after the transcript line. Cost 0, nothing leaves the machine, no consent needed.
  - V2 "Always-on Claude copilot": a persistent Claude session receives every ~45 s window and decides itself.
    - Best quality, but 8–20 s per window, ≈ 80 windows/hour × $0.01–0.03 ≈ $1–2.5/hour on Sonnet, and the whole meeting streams to Anthropic.
    - Rejected as the default.
  - V3 "V1 gate → Claude explains" (phase 2, child checkbox "Explain hints with Claude"):
    - V1 decides when and finds candidates; the active session gets an injected turn with the trigger lines + the hits and returns a 1–2 sentence card ("On 2026-10-28 you agreed X (CMT-012)").
    - ≤ 15 s end to end, ≤ 12 turns/hour ≈ $0.15/hour on Sonnet.
    - Requires the Active session consent.
  - Verdict (AUG-193): V1 now, V3 next, V2 rejected — superseded by AUG-196 below.
- Copilot final design (AUG-196, decided 2026-11-05):
  - Why the AUG-193 gate changed:
    - On the 57-min Support Weekly, the AUG-193 gate fired 74 times/h and 100 times/h on a game video.
    - 64 of 71 fires came from the Latin-capitalized-word rule ("Slack" ×26, brand names transliterated five ways). The quoted rule only fired on UI labels.
    - Both rules are dropped. Gate g2 = ru stem triggers (only reflexive `договорил(ись|ась|ся)`, because «договорил» means "finished speaking") + en phrases + task ids.
    - Result: 17.7 fires/h, about 7 % false positives after the reflexive fix, 0 fires on non-meeting audio.
  - Retrieval is the bottleneck, not the gate:
    - Russian keywords against English notes return nothing useful.
    - The task board (`find_task_by_keywords`, Russian prefixes, 3–15 ms) is searched alongside project-context, because past agreements reach the board through Send to Praxis.
    - Project-lexicon terms (route names, "Also known as" entries) feed the keywords.
  - Claude is both the explainer and the relevance filter:
    - Both Haiku and Sonnet rejected an irrelevant partial hit.
    - With no local hit, Claude searches Praxis itself with English keywords ("assist" shape).
    - Haiku missed the one real match that Sonnet found, so Sonnet is the default.
  - Thresholds confirmed: ≥ 20 s between searches (it merges duplicate fires), ≤ 1 card per route per 5 min, ≤ 12 per hour. The hourly cap now applies to Claude turns, because those carry the cost.
  - Always-on (V2) is allowed as a user-chosen mode with its own per-meeting spending limit. At the limit it falls back to Claude explains and never resumes on its own. It is never the default.
  - Contracts (LiveFeed API, copilotEngine, frames copilot-hint/status/dismiss/mode, child flags, payload ≤ 80 words + ≤ 3 candidates, prompt, timeouts 6 s / 12 s with plain-hit fallback, log line without text): see @docs/mockups/AUG-196/findings.md §3–§5.
- Active session launch mode (D4), compared:
  - One-shot `claude -p` per question: wall 4–6 s measured, no memory, ~15k system/tool tokens re-sent per spawn (cached, still paid as cache reads). Rejected.
  - `claude -p --resume <id>` per question: memory, but still a spawn per question. Kept only as crash recovery.
  - Persistent `claude -p --input-format stream-json --output-format stream-json --include-partial-messages` (recommended): measured turn 1 3.2 s, turn 2 2.3 s, turn 3 1.7 s wall; the process stays alive between turns and exits 0 when stdin is closed; prompt cache stays hot; tokens stream to the UI.
  - Agent SDK `@anthropic-ai/claude-agent-sdk` 0.3.318 (deps zod, @anthropic-ai/sdk, @modelcontextprotocol/sdk): same engine as a library (`query()` with streaming input, `canUseTool`, in-process MCP tools).
    - Adds a server dependency that ships its own CLI copy inside the Electron build and its auth path must be verified.
    - Designated replacement for the transport layer if JSONL parsing proves brittle.
    - Keep a `ClaudeTransport` interface so the swap stays local.
  - Flags for the child (final list: @docs/mockups/AUG-195/findings.md §2):
    - `--model <aiModel>`, `--max-budget-usd <limit − spent this meeting>`, `--permission-prompts none`, `--tools Read,Grep,Glob` (comma form verified).
    - `--allowedTools` = Read Grep Glob, `mcp__august__*` and only the praxis tools search_project_context, query_project_graph, read_context_route, find_task_by_keywords, get_task, create_task; `--disallowedTools` = every other praxis tool. Why: all 21 Praxis tool definitions made turn 1 cost $0.12 (26k tokens of cache write), and `mcp__praxis__*` would let the child call update_task_status, update_settings or start_new_session.
    - `--strict-mcp-config --mcp-config <JSON built with JSON.stringify: praxis http + august http>`.
    - `--setting-sources ""` (no user hooks, plugins or MCP; the project's CLAUDE.md still loads).
    - `--session-id <uuid we generate>` on the first spawn, `--resume <uuid>` on every later spawn (never both); verified: the resumed init carries the same session_id and the history.
    - `--append-system-prompt` (meeting assistant for project X; answer briefly in the meeting's language; the transcript is the live meeting; create tasks only through praxis `create_task` with the given project_root; record action items through august `add_action_item`; never edit files).
    - `cwd` = project root.
    - NOT `--bare`: it forces ANTHROPIC_API_KEY auth and ignores the user's login (measured: api_error in 1.2 s).
  - Transcript hand-off:
    - Each question message carries `<recent_transcript window=N min>` from the LiveFeed plus the question.
    - Nothing is streamed between questions (cost and privacy: the question is the consent moment per turn).
    - Pref `aiTranscriptWindowMin` 2/5/10/15, default 5.
    - V3 explanation turns carry only the trigger lines and the search hits.
  - Lifecycle (full table: AUG-195 findings §2):
    - Spawned lazily on the first question of a (liveKey, project) tab; idle stop after 10 minutes (same pattern as llmServer.ts), the next question resumes with `--resume`; stopped on End Meeting; kept 60 s after the last WebSocket of the liveKey closes (reconnects); one automatic `--resume` after a crash, the unanswered question is not re-sent (UI "Ask again").
    - Result signals (measured): budget → `result.subtype === 'error_max_budget_usd'` with empty text, the process stays alive and fails every later turn at $0, so August stops it; not signed in → `is_error: true` with subtype `success` and text "Not logged in · Please run /login"; PraxisOS down → init `mcp_servers` praxis `failed`, the child still answers; stderr stays empty, errors come only as `result` messages; `system/init` arrives only after the first user message.
    - Spend: per-turn cost = delta of `total_cost_usd` inside one process (it restarts at 0 after a respawn); August sums it per liveKey.
    - At most 3 children (`AI_MAX_SESSIONS`); the least recently used idle one is stopped when a fourth is requested.
    - stdin end first, kill after 5 s, Windows `taskkill /PID /T /F` if anything lingers.
  - Window (D4 UI, final in AUG-195 D12):
    - AUG-193 picked P1 (a 420 px right overlay); in the AUG-195 review the user rejected it because it covered the Action items column and left no place for the Copilot.
    - Final: side-by-side columns Transcript (≥ 360 px) | ACTION ITEMS (300) | COPILOT (300) | ASSISTANT (380); nothing overlaps; each column collapses to a 28 px rail, hides (`×`) and comes back from pin-bar toggles, and resizes by its left splitter (240–560 px); the layout is a client preference in localStorage. Ctrl/Cmd+3 = ASSISTANT, Ctrl/Cmd+4 = COPILOT; `CTX n` shows COPILOT.
    - COPILOT column = AUG-196 mode strip + Hints, following the active ASSISTANT tab. ASSISTANT column = project tabs (`●` running, `○` not started, `!` unavailable), picker, chat with plain-language tool chips, `→ Action item` / `→ Praxis task` / `Copy`, Stop, Stop session.
    - No money in the panel (user decision): only the state "Spending limit reached for this meeting". Chat model is chosen in Settings only.
    - Compact Mode (AUG-195 user decision, supersedes the AUG-196 A3 drawer and B3 card): Dock Strip (or Ghost Caption), Copilot and Assistant are three separate frameless windows; each is movable (X/Y) and resizable, bounds saved per window in window-state.json; a window dropped or resized over another is moved to the nearest free side, edges snap within 12 px; Dock Strip gets `[ CP ]` / `[ AS ]` toggles. Copilot and Assistant become new BrowserWindows owned by `CompactController` (electron/src/compact.ts) and talk to the main renderer over IPC. Dock Square and Ghost Coin keep a `CTX n` badge.
  - Transport to the UI: new JSON frames on the existing live WebSocket.
    - client→server: `assistant-open {projectPath}`, `assistant-ask {projectPath, text, askId}`, `assistant-task {projectPath, askId, messageId}`, `assistant-stop {projectPath, interrupt?}`.
    - server→client: `assistant-status` (state, `praxis` flag; spend fields are for the server cap and are not rendered), `assistant-delta`, `assistant-tool` (plain-language label; tool names never reach the client), `assistant-message`, `assistant-error`, `copilot-hint`, `copilot-status`. Full shapes: AUG-195 findings §3.
- Project chosen after start (D5):
  - The panel header lists praxisProjects (default first), praxisRecentPaths (AUG-192) and Open… (existing POST /api/praxis/browse).
  - Picking a project opens a tab keyed `${liveKey}:${resolved path, lower-case}`; the copilot loop for that project starts at once (if enabled), the Claude child only on the first question.
  - Switching tabs stops nothing; closing a tab stops its child.
  - A folder picked through Open… is added to praxisRecentPaths only after the first successful answer (same rule as AUG-192).
  - A Claude child cannot be re-pointed: cwd is fixed at spawn, so another project is another tab.
- Action items contract (D6): August exposes a minimal MCP server `august` (Streamable HTTP through `@modelcontextprotocol/sdk`, mounted at `/api/assistant/mcp/<sessionToken>`, loopback-only guard like routes/capture.ts; the token binds the connection to one liveKey).
  - Tools: `get_recent_transcript({minutes})`, `list_action_items()`, `add_action_item({text, owner?, praxisTaskId?, projectPath?})`.
  - `add_action_item` → `LiveActionItemsStore.addAssistantItem`: exact `normalizeForCompare` match or `actionTextSimilarity ≥ 0.6` (ACTION_MERGE_MIN_SIMILARITY) against an existing item returns `{status:'duplicate', id}` and, when praxisTaskId is given, marks that item's `praxis {taskId, projectPath, sentAt}`.
  - Otherwise creates `{manual: true, locked: {text: true, owner: true}, source: 'Me', assistant: {projectPath, at}}` and returns `{status:'created', id}`.
  - The optional `assistant` field is kept by the tolerant reader and shown as a small `AI` tag in ActionItemsPanel.
  - A REST mirror `POST /api/live/:liveKey/action-items` with the same body and semantics backs the UI button "→ Action item" on an assistant message.
  - Praxis task creation by Claude goes through Praxis `create_task` (server-side counter) followed by `add_action_item({praxisTaskId})` so the existing praxis badge appears.
  - The UI button "→ Praxis task" on a Claude message (AUG-195 user decision): first a Claude turn that calls `create_task` (richer task text); fallback to the existing direct path (POST /api/praxis/action-items, `createPraxisTask`) when PraxisOS is unreachable, Claude Code is unavailable, the limit is reached, the child is busy > 30 s or the turn made no `create_task` call; the UI says "(created directly)".
- Settings (D7, final in AUG-194 — spec @docs/mockups/AUG-194/findings.md §1–3, mockup @docs/mockups/AUG-194/ai-assistants-tab.html): tab `assistants` "AI assistants" between Projects and Compact mode; `.settings-card` becomes `min(680px, 100%)` for all tabs because six tabs need ≈ 680 px with today's tab CSS (user chose the wider card over tighter tabs or a shorter label).
  - Section Status: rows Claude Code (`Signed in · <version>` / `Installed, not signed in` / `Not installed` / `Too old (<version>) — update it` / `Checking…`) and PraxisOS (`Running` / `Not running`); warn hint + one Recheck button only when something is wrong (`GET /api/assistant/status?recheck=1`). Replaces the AUG-193 per-row Claude Code hints.
  - Section Meeting Copilot: the AUG-196 four-mode radio list (`.settings-choice-list` / `.settings-choice`), price/privacy line per mode, children Model under Claude explains, Model + Spending limit per meeting (`aiCopilotAlwaysBudgetUsd`, free number field, 0 = no limit) under Always-on. Claude modes are disabled-but-visible while Claude Code is unusable; a saved Claude mode stays selected with a warning and runs as Local hints. Choosing Claude explains is the consent; Always-on opens its checkbox-gated red modal every time.
  - Section Active session (Claude): toggle → consent modal → `POST /api/assistant/enable {accept:true}` writes `aiSessionEnabled: true` + `aiConsent {acceptedAt, version}`; `/disable` deletes the consent; children Model `aiModel` (sonnet default | haiku | opus), Spending limit per meeting `aiSessionBudgetUsd` (free number field, `$` prefix, default 2, 0 = no limit → no `--max-budget-usd`, committed on blur / Enter), Transcript window `aiTranscriptWindowMin` (2 / 5 default / 10 / 15). Toggle disabled with "Needs Claude Code — see Status above." while Claude Code is unusable; a stale consent (version bump) shows OFF + a warn hint and re-asks.
  - Preferences: `aiCopilotModel`, `aiCopilotAlwaysBudgetUsd`, `aiModel`, `aiSessionBudgetUsd`, `aiTranscriptWindowMin` go through PATCH with `sanitizeAssistantPreferences()` (enum drop, budget: non-finite or negative dropped, rounded to cents, capped at 1000, 0 = no limit; window snapped to 2/5/10/15); `aiCopilotMode`, `aiCopilotConsent`, `aiCopilotAlwaysAck`, `aiSessionEnabled`, `aiConsent` are NOT in ALLOWED_KEYS and are written only by routes/assistant (a Claude mode must never exist without its consent record). `aiCopilotEnabled` and `aiCopilotExplain` (AUG-193 draft) do not exist.
  - Consent versions: `AI_SESSION_CONSENT_VERSION` and `AI_COPILOT_CONSENT_VERSION` (both 1); bumping one is the only way to re-ask existing users. `DELETE /api/preferences` drops every ai* key.
  - Option B (rejected): one master "AI assistants" consent toggle with two children, like the Groq pattern of AUG-190 — rejected because Copilot v1 sends nothing outside and must not be gated behind an Anthropic consent.
  - All defaults off → no behavior change for existing users.
- Consent text (modal "Active session (Claude)", final AUG-194, Groq-modal pattern with lettered lines; live window and limit values):
  - "A) When you ask a question during a live recording, the last N minutes of the transcript, the participant names you entered, the collected action items and your question are sent to Anthropic. Nothing is sent until you ask. B) It goes through Claude Code under your own Claude account, the same way as using Claude Code in a terminal. Claude may also read files in the project folder you pick for the meeting. C) Usage counts against your Claude plan — no API key is needed. The session stops at your spending limit of $N per meeting." (No limit: "You chose no spending limit, so usage is capped only by your plan.")
  - Hint: "You can turn this off at any time here. Meeting Copilot hints are covered by the mode you choose above, not by this consent." Buttons: Cancel / Agree and enable.
- Privacy and cost (D8):
  - Copilot v1 — nothing leaves the machine, cost 0.
  - Active session per question — system prompt + tool definitions ≈ 15k tokens (cached after the first turn), transcript window (5 min ≈ 750 words ≈ 2.2k tokens in Cyrillic), the question, tool results (route TL;DRs 1–3k), output 200–600 tokens.
  - Prices (2026-10): Sonnet 5.5 $2 / $10 per MTok (cache read $0.20), Haiku 5.5 $0.10 / $0.50, Opus 5.5 $4 / $20.
  - Measured (AUG-195, Sonnet, Windows): first turn with Praxis search $0.12 (the AUG-193 estimate of $0.04 was too low: 26k tokens of cache write, mostly Praxis tool definitions; the explicit allowed-tools list should cut it, not yet measured), later turns ≈ $0.01, resumed turn $0.006; 20 questions per hour ≈ $0.3; measured Haiku turns $0.0003–0.003.
  - Copilot V3 ≤ 12 turns/hour ≈ $0.15/hour on Sonnet.
  - A 60-minute meeting: the longest real session (57.5 min) had 2,431 words; dense meetings are assumed at ~9k words/hour; Cyrillic ≈ 3 tokens/word → 7k–27k transcript tokens per hour, never sent as a whole.
  - Caps: `--max-budget-usd`, ≤ 3 children, ≤ 12 hints/hour, window ≤ 15 min, idle stop 10 min, stop on End Meeting.
  - Logs carry counts and costs only, never text (same rule as the action-items logs).
- Cross-platform (D9): `resolveClaudeCli()`.
  - env `CLAUDE_CLI_PATH` override → win32: `%USERPROFILE%\.local\bin\claude.exe`, then `where claude`; darwin: `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, then `which claude` after extending `ensureToolPaths()` in electron/src/main.ts with `~/.local/bin` (GUI apps on macOS do not inherit the shell PATH).
  - Prefer a native executable; an npm `.cmd` shim needs `cmd.exe /d /s /c`.
  - Probe (AUG-194, `probeClaudeCli()`, cached per app start, re-run by Recheck): `claude --version` → "2.1.318 (Claude Code)", 55 ms warm, 10 s timeout → `found`; `claude auth status` (JSON by default, `--json` / `--text` flags) → `{loggedIn, authMethod, apiProvider, loginExpiresAt, email, orgName, subscriptionType, …}`, 0.35 s → `signedIn = loggedIn === true`; "unknown command" → `tooOld` (minimum version pinned at 2.1.318, the one verified); only `loggedIn`, `authMethod` and the version are logged, never e-mail / org / plan. Logged out (captured in AUG-198 on an empty `CLAUDE_CONFIG_DIR`): exit code 1 with JSON `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","analyticsDisabled":false,"projectsDirectory":…,"configDirectory":…,"loginExpiresAt":null}` — the parser reads stdout whatever the exit code. Unknown subcommand: empty stdout, `✘ unknown command` on stderr, exit 1. A version below 2.1.318 is tooOld without running `auth status` (an old build could treat it as a prompt).
  - Why not credential files: Windows keeps the OAuth record in `~/.claude/.credentials.json` (`claudeAiOauth`), macOS in the Keychain, so a file check is not cross-platform; `~/.claude.json` `oauthAccount` is a profile cache.
  - The probe and every August child run with env minus `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`: Claude Code prefers an env key over the login, which would bill per token and contradict the consent text. A user's own `apiKeyHelper` in `~/.claude/settings.json` is left alone.
  - win32 order: `%USERPROFILE%\.local\bin\claude.exe` (native installer, verified: `where claude` finds only this, nothing in `%APPDATA%\npm`), then `%APPDATA%\npm\claude.cmd`, then the first `.exe` line of `where claude`; no PATH change needed on Windows.
  - `where claude` prints a Cyrillic user path garbled (OEM codepage), so the resolver builds the native path from `os.homedir()` first and accepts a `where` line only when `fs.access` passes (AUG-198).
  - PraxisOS reachability (AUG-194): tokenless `GET http://127.0.0.1:7865/health` → `{"status":"ok","service":"praxis-local-api",…,"claude_available":true,"mcp_available":true}` in < 50 ms; `/api/*`, `/mcp`, `/` answer 401 without a token, `/stream` 406 (the MCP transport). Timeout 1.5 s, no retries; Praxis's own `claude_available` is ignored — August judges the CLI from the process that spawns it.
  - Caching (AUG-198): the Claude probe is lazy (first GET /api/assistant/status, nothing at app start), cached in memory, re-run only by `?recheck=1`, concurrent requests share one in-flight probe; measured 370 ms for both commands. PraxisOS /health is called on every status response instead (loopback, refused at once when down, and Praxis may start after August).
  - Spawn with `path.join`, `windowsHide: true`, `cwd` = project root; a Cyrillic user directory works when the absolute path is passed (verified: `C:\Users\<cyrillic>\.local\bin\claude.exe`); `toSafePath` is not needed (it exists for whisper-cli args).
  - The `--mcp-config` JSON must be built with JSON.stringify (a hand-written backslash path broke the probe).
  - Both resolver branches get unit tests that mock `process.platform` (like gpuBackend.test.ts).

## Decisions

1. D1 — LiveFeed per liveKey on the server (Core Concepts: Subscription point).
2. D2 — Copilot via direct Praxis MCP HTTP; Active session via Claude's own MCP connection (Praxis access paths).
3. D3 — Copilot V1 now, V3 later, V2 rejected (Copilot loop). Superseded by D10.
10. D10 (AUG-196) — copilot modes, gate g2, own copilot child, compact A3/B3 (Copilot final design).
4. D4 — persistent stream-json child (Active session launch mode); its P1 overlay is superseded by D12.
5. D5 — project tabs after start, ≤ 3 children (Project chosen after start).
6. D6 — `august` MCP server + add_action_item contract with similarity dedup (Action items contract).
7. D7 — Option A settings, consent only for the session (Settings, Consent text).
8. D8 — caps listed in Privacy and cost.
9. D9 — `resolveClaudeCli()` resolver + PATH rules (Cross-platform).
12. D12 (AUG-195, user 2026-11-06) — side-by-side Action items / Copilot / Assistant columns (collapsible, hideable, resizable) instead of the P1 overlay; separate non-overlapping movable/resizable compact windows instead of A3/B3; no money in the panel; → Praxis task through Claude with direct fallback; chat model in Settings only; explicit praxis allowed-tools list (Active session launch mode, Action items contract).
11. D11 (AUG-194, user 2026-11-06) — final Settings tab: Status section on top, spending limits as free number fields with 0 = no limit (dropdown of presets rejected), 680 px Settings card, Claude copilot modes disabled-but-visible, `claude auth status` as the sign-in check (Settings D7, Cross-platform D9).
- Compact windows talk to the main renderer over the same-origin BroadcastChannel `august-assistant` (like the ghost window's `august-compact`), not over Electron IPC; one WebSocket stays in the main window (AUG-199).
- npm `.cmd` shim installs of Claude Code are not used for the session (JSON arguments cannot be passed through cmd.exe safely); the session reports claude-unavailable `unsupported` and asks for the native build (AUG-199).
- → Praxis task returns the short `TAG-123` id in assistant-task-done on both the Claude and the direct path (AUG-199).
- Tabs and chats are kept across Stop Live Text and cleared on End Meeting (AUG-199).
- AUG-200 — Default-mode meeting socket (decided in AUG-200 Step 4):
  - Every recording gets a liveKey at start (before AUG-200 only Live recordings did), so manual / Assistant items of a Default recording reach the session on upload through the existing pending-file path, and End Meeting stops the assistant children by liveKey.
  - Transport: the same /api/live-transcribe endpoint and LiveTranscriptionClient (`startMeeting(liveKey, participants)`), not a new REST/SSE channel, so every assistant-* and action-item-* frame, the store refcount and the hub grace work unchanged. Why: a second channel would duplicate the frame protocol.
  - A meeting-only connection never decodes audio, never attaches a server capture, never starts LiveTextCorrector or LiveActionItemsExtractor, never acquires a LiveFeed and never attaches the copilot; the action-items frame carries `enabled: false, manual: true` (panel hint "Live text is off, so action items are not collected automatically").
  - Exactly one control socket per recording on the client (`controlClient()` = Live client ?? meeting client). Live and meeting sockets never coexist: two sockets on one hub would double every assistant-delta. Start Live Text stops the meeting socket first; Stop Live Text during a recording opens it again (so the columns also stay after Stop Live Text — a deliberate extension of "no Live client"). The server keeps items (store refcount / pending file) and tabs (60 s hub grace) across the swap.
  - Client flags: assistantStore `live` = a meeting socket is connected, `transcript` = Live Text feeds it; copilot frames, the CTX count and the COPILOT column/toggle/Ctrl+4 need `transcript`. A user chat entry remembers `transcript` and shows '+ last N min of the transcript' only when true.
  - Column layout reuses the Live key `august.liveColumns.v1.*` (task default; no separate Default-mode layout).
  - Compact: the automatic widget still follows Live (Default → indicator), but the in-place switch to Dock Strip / Ghost Caption is allowed on the meeting socket (`pickCompactWidget(..., transcriptWidgetOk)`), where they show the action items; Dock Square gets a ⇄ to reach the Strip; the compact Assistant window works because `live` is true; the compact Copilot window says "Hints need live text."; the Dock Strip hides [ CP ] without Live.
- Gate g2 as built (AUG-197): reflexive `договорил(ись|ась|ся)` only, plus a conditional exclusion — a договор* match preceded within two words by «если» does not fire (removes findings FP #17 «если договорились»). Tests: the 14 true references of findings §1 fire, the 3 false do not, the game-video sample gives 0. The card said "15 true references"; findings lists 17 fires with 3 false, so 14 is the real count.
- The explain child runs without `--max-budget-usd`; its cost is bounded by the 12 turns/hour cap (≈ $0.10–0.20/h on Sonnet). Only Always-on gets `--max-budget-usd` = aiCopilotAlwaysBudgetUsd − spent this meeting (AUG-197). Reason: after Always-on reaches its limit the meeting must continue as Claude explains, which a shared cap would block.
- Always-on spend is per meeting and never reset: re-picking Always-on after the limit resumes it only when a raised limit leaves room (AUG-197).
- A Claude explain call waits 4 s after the trigger (CLAUDE_CONTEXT_WAIT_MS) so the lines spoken after it reach the payload; the 'searching' card shows at once (AUG-197).
- Settings → AI assistants keeps aiCopilotAlwaysBudgetUsd as a free USD field (0 = no limit, AUG-194 final), not the 0.5–10 step 0.5 range of findings §2 / the AUG-197 card [CONFLICT — verify before use]; the code follows AUG-194.
- PraxisOS is marked down only when a failed search is confirmed by GET /health, so one slow search does not pause the copilot; then health is retried every 30 s (AUG-197).

## Rejected options

- Client-side subscription: the browser build cannot spawn processes and it duplicates state.
- Hooking the extractor's buffer: it drops sent speech.
- Own BM25 over project-context: drifts from Praxis search.
- Claude for copilot retrieval: latency and cost per trigger.
- Always-on Claude copilot as the default: cost and privacy (AUG-196 allows it as an opt-in mode).
- Latin-capitalized words and quoted text as gate triggers: 90 % of the fires, none useful (AUG-196).
- Copilot hint turns inside the Active session chat child: they would pollute the chat history and block while the user's answer streams (AUG-196).
- Compact Mode badge-only and the A1/A2/B1/B2 assistant variants: user picked A3 + B3 (AUG-196).
- One-shot `claude -p` per question: 4–6 s and re-sent system tokens.
- `--bare`: API-key-only auth.
- Option B settings: consent would gate a feature that sends nothing.
- P1 overlay (AUG-195 review): covered the Action items column and left no place for the Copilot; replaced by side-by-side columns the user can collapse, hide and resize (the AUG-193 P2 objection "shrinks the transcript" is answered by that control and the 360 px minimum).
- Money in the panel footer (AUG-195): the panel shows only "Spending limit reached".
- Compact A3 drawer / B3 anchored card (AUG-196): superseded by separate non-overlapping windows (AUG-195).
- P3 separate window: more desktop-shell code, not available in the browser build.
- Re-pointing a running Claude child to another project: cwd is fixed at spawn.
- Per-row Claude Code hints with two Recheck buttons (AUG-193 draft): one Status section instead (AUG-194).
- Tighter tab padding or renaming the tab to fit six tabs in 600 px: user chose the 680 px card (AUG-194).
- Reading `.credentials.json` for the sign-in check: Windows-only; `claude auth status` is cross-platform (AUG-194).
- Letting PATCH /api/preferences write `aiCopilotMode`: would allow a Claude mode without a consent record (AUG-194).

## Components

- liveFeed (component, implemented AUG-199): server/src/services/liveFeed.ts — registry acquireLiveFeed / releaseLiveFeed / getLiveFeed (refcount per liveKey), ring buffer 20 min / 6,000 words, push / correct / subscribe / snapshot(windowMs) / around(); formatLine → `[Me] hh:mm:ss text` with elapsed time since the feed started; never persisted; acquired at action-items-init only when the Active session is on or a copilot mode is not off, never on a meeting-only socket (AUG-200); written by liveTranscription; read by assistantSession and augustMcp.
- praxisMcpClient (component, implemented AUG-197): server/src/services/praxisMcpClient.ts — Streamable HTTP JSON-RPC client for 127.0.0.1:7865/stream (lazy initialize + mcp-session-id, SSE or JSON bodies, one re-init on HTTP 400/404, PraxisDownError on network failure or timeout); singleton `praxisMcp`; used by copilotEngine and GET /api/assistant/copilot/route.
- copilotGate (component, implemented AUG-197): server/src/services/copilotGate.ts — pure gateFire (g2), buildKeywords, buildLexicon (10 min cache per root), parseSearchResult / parseTaskResult / parseCopilotAnswer, COPILOT_PROMPT / ALWAYS_PROMPT and message builders, CopilotLimiter (20 s gap, 5 min per route/task, 12 Claude turns per rolling hour, route+line dedupe); unit-tested.
- copilotEngine (component, implemented AUG-197): server/src/services/copilotEngine.ts — hub per liveKey (sockets, 60 s grace, meeting override, Always-on spend, Praxis health), engine per (liveKey, project) with an explain CopilotChild and an always child; exports attachCopilotSocket, stopCopilotLiveKey (End Meeting), stopAllCopilots, killAllCopilotsSync; depends on liveFeed, copilotGate, praxisMcpClient, claudeTransport, aiChildPool, claudeCli, assistantState, praxisIntegration.
- assistantSession (component, implemented AUG-199): server/src/services/assistantSession.ts — hub per liveKey (sockets, tabs, 60 s grace after the last socket), tab key `${liveKey}:${resolved path lower-case}`; lazy spawn on the first assistant-ask, idle stop 10 min then `--resume`, one automatic `--resume` after a crash (a second crash within 60 s → state error), turn timeout 180 s, stop on End Meeting (upload with liveKey → stopAssistantLiveKey); exports attachAssistantSocket, stopAssistantLiveKey, stopAllAssistants, killAllAssistantsSync, setAssistantServerPort, buildUserMessage, SESSION_PROMPT, toolLabel; depends on claudeTransport, aiChildPool, liveFeed, augustMcp, liveActionItems, claudeCli, assistantState, praxisIntegration.
- augustMcp (component, implemented AUG-199): server/src/services/augustMcp.ts + routes/assistant.ts — POST /api/assistant/mcp/:token (Streamable HTTP, JSON responses; GET → 405, DELETE → 200; loopbackOnly from routes/capture.ts; unknown token → 404); tools get_recent_transcript (1–15 min; without a LiveFeed `lines: []` + `note`, AUG-200), list_action_items, add_action_item; depends on liveFeed and liveActionItems (addAssistantItem).
- claudeTransport (component, implemented AUG-199): server/src/services/claudeTransport.ts — shared with AUG-197: buildClaudeArgs (flags exactly as findings §2), buildMcpConfig, parseStreamMessage (init / delta / tool / tool-result / result), JsonlSplitter, ClaudeTransport (start / send / interrupt via control_request / stop: win32 stdin end then `taskkill /PID /T /F` after 5 s, other platforms SIGTERM then SIGKILL after 5 s); disallowed praxis tools = known 21 praxis tools minus the 6 allowed, refreshed from system/init; unit-tested.
- aiChildPool (component, implemented AUG-199): server/src/services/aiChildPool.ts — AI_MAX_SESSIONS = 3 across chat and copilot children; a 4th evicts the least-recently-used idle child, none idle → status `limit`.
- routes/live (component, implemented AUG-199): server/src/routes/live.ts — POST /api/live/:liveKey/action-items (loopback only) → addAssistantItem on the open store or the pending file; 404 unknown liveKey.
- routes/assistant (component, implemented AUG-198): server/src/routes/assistant.ts at /api/assistant — GET /status[?recheck=1] → `{claude {found, signedIn, version, tooOld, checkedAt}, praxis {reachable}, copilot {mode, consentStale, model, alwaysBudgetUsd}, session {enabled, consentStale, consentAt, model, budgetUsd, transcriptWindowMin}}`; POST /copilot-mode {mode, accept?, ack?}; POST /enable {accept:true}; POST /disable; depends on claudeCli and assistantState. Never returns the CLI path. Planned additions: POST /api/live/:liveKey/action-items, the august MCP server mount.
- claudeCli (component, implemented AUG-198): server/src/services/claudeCli.ts — `resolveClaudeCli()`, `probeClaudeCli()`, `getClaudeProbe(recheck)` (cache), `buildClaudeEnv()` (strips the two API-key vars; every later Claude child must use it), `runClaudeCli()` (`.cmd` shim via `cmd.exe /d /s /c`, `windowsHide`), `getResolvedClaudeCli()` (server-only path for the session child); used by routes/assistant, later by copilotEngine and assistantSession.
- assistantState (component, implemented AUG-198): server/src/services/assistantState.ts — consent versions (AI_SESSION_CONSENT_VERSION = 1, AI_COPILOT_CONSENT_VERSION = 1, AI_MIN_CLAUDE_VERSION = '2.1.318'), pure rules applyCopilotMode / applySessionEnable / applySessionDisable / buildAssistantStatus (unit-tested without HTTP), probePraxisReachable(); depends on preferencesStore (sanitizers sanitizeAssistantPreferences / sanitizeBudgetUsd / sanitizeAiModel / sanitizeTranscriptWindow live there).
- AiAssistantsTab (component, implemented AUG-198): client/src/components/AiAssistantsTab.tsx — the Settings tab `assistants`; reads GET /api/assistant/status, patches the five preference keys; part of SettingsModal.
- Client (AUG-199): client/src/services/assistantStore.ts (tabs, chat, frame reducer, BroadcastChannel publisher), liveColumnsStore.ts (column layout in localStorage per window size class), assistantChannel.ts (channel contract for the compact windows); client/src/components/live/ (LiveColumn, LiveColumns, AssistantColumn, CopilotColumn shell, LiveColumnToggles); compact windows client/src/components/compact/CompactAssistantApp.tsx and CompactCopilotApp.tsx (`?panel=assistant|copilot`). AUG-197: assistantStore also holds per-project copilot hints/status, copilot actions (setCopilotMode, setCopilotModel, dismissHint, undoDismiss, openHintRoute, askAboutHint → assistPrefill) and useCopilotHintCount for `CTX n`; CopilotColumn renders the cards; AlwaysOnConfirmModal is shared with AiAssistantsTab.
- Affected existing components (from the graph explore of liveTranscription and liveActionItems):
  - liveTranscription (feed push + correct lines, assistant frames, lazy attach of the assistant hub)
  - liveActionItems (addAssistantItem, `assistant` field, tolerant reader)
  - transcriptActionItems (unchanged)
  - ActionItemsPanel (AI tag)
  - SettingsModal (tab)
  - preferencesStore / routes/preferences (new keys)
  - electron/src/main.ts (`ensureToolPaths`)

## Wire protocol (AUG-199)

- client → server frames on /api/live-transcribe: assistant-open {projectPath}, assistant-ask {projectPath, text ≤ 4,000, askId}, assistant-task {projectPath, askId, messageId}, assistant-stop {projectPath, interrupt?}, action-item-add {…, assistant?: {projectPath, messageId?}}.
- server → client: assistant-status {projectPath, state, reason?, praxis, spentUsd, limitUsd} (states none / starting / ready / busy / idle / restarting / error / budget-reached / limit / claude-unavailable [missing | signed-out | too-old | unsupported] / session-off), assistant-delta, assistant-tool {label, state, toolIndex}, assistant-message {text, tools}, assistant-error {reason crashed | timeout | budget | claude | busy | limit | session-off}, assistant-task-done {messageId, taskId, direct}, assistant-task-failed, assistant-item {messageId, status created | duplicate, id}.
- Copilot frames (AUG-197), client → server: copilot-open {projectPath} (every ASSISTANT tab, only while copilot mode ≠ off), copilot-close {projectPath}, copilot-dismiss {projectPath, hintId, undo?}, copilot-mode {mode?, model?}.
- Copilot frames, server → client: copilot-hint {hintId, projectPath, at, clock, state searching | found | explained | removed, route?, taskId?, title?, lines?, text?, source?, note? claude-off | claude-unavailable | local} (same hintId upgrades in place); copilot-status {projectPath, mode (effective), savedMode, model, state ok | praxis-off | claude-unavailable | budget-reached | limit | paused, counts {shown, silent, dismissed}}.
- copilot-mode is a "re-read my prefs" signal: the client first persists (POST /api/assistant/copilot-mode for the mode, PATCH aiCopilotModel for the model), the server re-reads preferences; a claude/always frame that differs from the saved mode is ignored (consent lives only in the route), off/local apply to this meeting.
- GET /api/assistant/copilot/route?projectPath&route (loopback) → {text} = Praxis read_context_route tldr ≤ 4,000 chars (Open route on a card); 404 not a Praxis project, 503 PraxisOS down.
- The client sends assistant-* frames only while GET /api/assistant/status says session.enabled; the server re-checks preferences and consent on every ask.
- Spend: per-turn cost = delta of total_cost_usd inside one process, summed per liveKey across respawns; respawn passes `--max-budget-usd` = limit − spent (min 0.01), none when the limit is 0; at the limit no turn is sent (state budget-reached).
- → Praxis task: a Claude turn (create_task, then add_action_item with praxisTaskId) when PraxisOS is reachable, Claude Code is usable, the limit is not reached and the child is free within 30 s; otherwise, or when the turn made no create_task call, the direct createPraxisTask path + addAssistantItem (UI shows `(created directly)`).

## Invariants

- Every Claude Code child August spawns (probe, session, copilot) uses buildClaudeEnv(), so billing stays on the user's Claude login (AUG-198).
- Both features are off by default; with both off no new process, no MCP connection and no new WebSocket frame exists.
- The existing live pipeline, LiveTextCorrector, LiveActionItemsExtractor and Send to Praxis are not changed in behavior; LiveFeed is an additive tap.
- Copilot v1 never sends transcript text off the machine; Praxis is loopback-only.
- Transcript text reaches Anthropic only in these cases:
  - inside an Active session question turn, while `aiConsent` is present;
  - in a copilot explanation turn (≤ 80 words around the trigger + candidate lines), while `aiCopilotMode` = 'claude' or 'always' (`aiCopilotConsent`);
  - continuously, while `aiCopilotMode` = 'always' (`aiCopilotAlwaysAck`).
- The copilot gate and local search never send anything.
- Items added by the assistant are manual and locked, so model merges never remove them, and they are deduplicated by exact match or similarity ≥ 0.6 before creation.
- A Claude child never gets Bash, Edit or Write; its tools are Read/Grep/Glob plus the praxis and august MCP servers.
- Each Claude child is bound to one project (cwd) and one liveKey (august MCP token); at most 3 children run at once.
- Ports, pids, model internals, tool names and token counts stay in the server log; the panel shows plain-language status and never shows money (only "Spending limit reached"); amounts appear only in Settings; the signed-in e-mail, org and plan from `claude auth status` are never shown or logged.
- A spending limit of 0 means "No limit" (user choice, AUG-194): the child is spawned without `--max-budget-usd`; the other caps (≤ 3 children, ≤ 12 hints/hour, window ≤ 15 min, idle stop) still apply.
- Server logs from assistantSession / augustMcp carry liveKey prefix, project basename, counts, costs, timings and states only — never transcript text, questions, answers or tool arguments (AUG-199).

## Route-Specific Constraints

- Research phase (AUG-193..196) is closed; implementation: AUG-198 (Settings), AUG-199 (Active session, columns, compact windows), AUG-197 (copilot engine, hints, compact Copilot window).
- Windows x64 and macOS arm64/x64 both mandatory; platform code under `process.platform` guards; `path.join` only.
- UI: 0 border-radius, terminal font in panels, green = primary, yellow = pause/high, red = stop/danger only.
- Never a paid Groq tier; Claude usage is billed to the user's own Claude account and capped by `--max-budget-usd`.

## Open questions

- macOS: does the Claude CLI credential (keychain) work from a child of a GUI app without a prompt? [UNVERIFIED] — AUG-198 and AUG-199 were not run on a Mac; findings §7 of AUG-195 lists what the Mac run must record.
- Should the project's praxis-mcp-codex ad-hoc rule (search before answering) be appended to the child's system prompt, or is CLAUDE.md enough?
- Whether `praxisRecentPaths` should also record projects opened from the ASSISTANT column (proposed yes, after the first successful answer).

## Key Files

- server/src/services/liveTranscription.ts — subscription point (:255-259, :191, :195).
- server/src/services/liveActionItems.ts — store, registry, normalizeForCompare, actionTextSimilarity, ACTION_MERGE_MIN_SIMILARITY.
- server/src/services/liveTextCorrection.ts — per-connection consumer pattern.
- server/src/services/groqText.ts — consent gate pattern `groqTextState`, `liveGroqTextFeatures`.
- server/src/routes/groqText.ts — enable/disable with consent.
- server/src/services/llmServer.ts — child process lifecycle, idle stop, pid file.
- server/src/services/praxisIntegration.ts + server/src/routes/praxis.ts — direct task creation, browse dialog.
- server/src/services/preferencesStore.ts + server/src/routes/preferences.ts — ALLOWED_KEYS, sanitizers.
- client/src/components/SettingsModal.tsx — tab strip (six tabs incl. `assistants`), Groq section.
- server/src/services/claudeCli.ts — Claude Code resolver, probe, cache, child env (AUG-198).
- server/src/services/assistantState.ts — consent versions, assistant route rules, Praxis health probe (AUG-198).
- server/src/routes/assistant.ts — /api/assistant status / copilot-mode / enable / disable (AUG-198).
- client/src/components/AiAssistantsTab.tsx — Settings → AI assistants tab and its two modals (AUG-198).
- client/src/components/GroqTextConsentModal.tsx — consent modal pattern.
- client/src/components/ActionItemsPanel.tsx — action items column.
- client/src/components/LiveTranscriptPanel.tsx — live transcript view.
- electron/src/main.ts — `ensureToolPaths` (darwin: /opt/homebrew/bin, /usr/local/bin, ~/.local/bin since AUG-198).
- server/src/services/claudeTransport.ts — stream-json child transport, args, parser (AUG-199).
- server/src/services/assistantSession.ts — per-liveKey hub, tabs, lifecycle, spend (AUG-199).
- server/src/services/augustMcp.ts — august MCP server, three tools (AUG-199).
- server/src/services/liveFeed.ts — per-liveKey transcript ring buffer (AUG-199).
- server/src/services/aiChildPool.ts — three-child cap, LRU eviction (AUG-199).
- server/src/routes/live.ts — loopback REST mirror for action items (AUG-199).
- server/src/services/copilotGate.ts + copilotGate.test.ts — gate g2, keywords, parsers, prompts, limiter (AUG-197).
- server/src/services/copilotEngine.ts — copilot hub, engines, explain / always children (AUG-197).
- server/src/services/praxisMcpClient.ts — Praxis MCP HTTP client (AUG-197).
- client/src/components/live/CopilotColumn.tsx + client/src/components/AlwaysOnConfirmModal.tsx — COPILOT column and the shared Always-on modal (AUG-197).
- client/src/services/assistantStore.ts — tabs, chat, frame reducer, publisher (AUG-199).
- client/src/services/liveColumnsStore.ts — column layout preference store (AUG-199).
- client/src/services/assistantChannel.ts — BroadcastChannel contract for compact windows (AUG-199).
- client/src/components/live/ — LiveColumn, LiveColumns, Assistant and Copilot columns (AUG-199).
- client/src/components/compact/CompactAssistantApp.tsx + CompactCopilotApp.tsx — compact panel windows (AUG-199).
- electron/src/panelGeometry.ts — snap and non-overlap rules for compact panels (AUG-199).
- docs/mockups/AUG-193/*.html — AUG-193 comparison mockups.
- docs/mockups/AUG-194/ai-assistants-tab.html + findings.md — final Settings tab mockup and spec (layout, states, consent text, preferences, routes, Claude Code detection).
- docs/mockups/AUG-195/assistant-overlay.html + findings.md — final columns/compact-windows mockup and the Active session spec (prototype results, lifecycle, frames, august MCP, prompt); research/session-proto.mjs + results-win.json — scratch Windows prototype (not product code).
- docs/mockups/AUG-196/findings.md — copilot spec; research/*.mjs — scratch gate-eval, explain-bench and task-board probe scripts (not product code).
