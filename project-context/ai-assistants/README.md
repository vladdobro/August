# AI Assistants (Meeting Copilot and Active project session)

> Research (AUG-193, 2026-11-05). Nothing here is implemented. Mockups: @docs/mockups/AUG-193/ai-assistants-settings.html and @docs/mockups/AUG-193/assistant-panel.html. User decision 2026-11-05: Copilot V3 (not V1 first), Active session as a persistent `claude -p` child under the user's Claude Code browser login (no API key), P1 overlay, Settings Option A with Sonnet default. Follow-up research with precise mockups: AUG-194 (Settings tab), AUG-195 (Active session), AUG-196 (Copilot, done 2026-11-05 → impl AUG-197); implementation tasks come out of those. AUG-196 supersedes the copilot parts of D3, D7 and the Compact Mode rule below — its full spec (gate numbers, prompts, contracts) is @docs/mockups/AUG-196/findings.md; mockups @docs/mockups/AUG-196/copilot-hints.html and @docs/mockups/AUG-196/compact-assistant.html.

## TL;DR

- Two optional, default-off features: Meeting Copilot (watches the live transcript, surfaces matching notes from a chosen PraxisOS project) and Active project session (a chat with Claude Code bound to a chosen project during the meeting, can answer from project context, add action items and create Praxis tasks).
- Recommended architecture: one server-side `LiveFeed` per liveKey (ring buffer + subscribers) fed from liveTranscription.ts.
- Copilot (AUG-196 decision): four modes `aiCopilotMode` — Off (default) / Local hints / Claude explains (recommended) / Always-on Claude; choosing a Claude mode is the consent; model `aiCopilotModel` Haiku/Sonnet/Opus (Sonnet default), mode and model switchable during the meeting from the ASSISTANT panel.
- Measured on real transcripts (AUG-196): local search alone with Russian speech against English project-context gave 0 [exact] hits in 28 searches; Claude (Sonnet) searching itself found the real note. Local-only mode stays for privacy but finds little in cross-language meetings.
- Copilot runs its own Claude child per (liveKey, project), separate from the chat child; it does not need the Active session to be on.
- Active session = one persistent `claude -p --input-format stream-json` child process per (liveKey, project); Praxis is reached by Claude itself through `--mcp-config` (http://127.0.0.1:7865/stream).
- August's own tiny MCP server (`august`) gives Claude `get_recent_transcript`, `list_action_items`, `add_action_item`.
- Measured on 2026-11-05 (Windows, Claude Code 2.1.318, Praxis MCP 1.30.0): Praxis MCP tool calls 0.07–0.15 s; one-shot `claude -p` 4–6 s wall; persistent stream-json session 3.2 s first turn, then 1.7–2.3 s per turn; one-shot with one Praxis tool call costs $0.003 on Haiku and re-sends ~15k system/tool tokens per spawn.
- Latency target for a copilot hint: ≤ 10 s from the spoken phrase (4–9 s of that is the existing 4 s chunk window + whisper), ≤ 1 s from the transcript line; with Claude explanation ≤ 15 s.
- Project is chosen after the session starts, in the Assistant panel; N projects = N tabs; ≤ 3 Claude child processes at once; copilot search loops are cheap and unlimited.
- Settings → new tab "AI assistants": two independent toggles (Copilot; Active session), consent modal only for the Active session (text goes to Anthropic via the user's own Claude Code login), plain-language status when Claude Code is missing or PraxisOS is not running.
- Also known as: meeting copilot, copilot hints, context hints, active session, assistant panel, Claude session, claude -p, stream-json, Agent SDK, LiveFeed, august MCP server, add_action_item, AI assistants tab, aiCopilotEnabled, aiSessionEnabled, aiConsent, aiModel, aiSessionBudgetUsd, aiTranscriptWindowMin, aiCopilotExplain (AUG-193).

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
  - Flags for the child:
    - `--model <aiModel>`, `--max-budget-usd <aiSessionBudgetUsd>`, `--permission-prompts none`, `--tools Read,Grep,Glob`.
    - `--allowedTools "mcp__praxis__*" "mcp__august__*" Read Grep Glob`.
    - `--strict-mcp-config --mcp-config <JSON built with JSON.stringify: praxis http + august http>`.
    - `--setting-sources ""` (no user hooks, plugins or MCP; the project's CLAUDE.md still loads).
    - `--session-id <uuid we generate>` (so a crash can `--resume`).
    - `--append-system-prompt` (meeting assistant for project X; answer briefly in the meeting's language; the transcript is the live meeting; create tasks only through praxis `create_task` with the given project_root; record action items through august `add_action_item`; never edit files).
    - `cwd` = project root.
    - NOT `--bare`: it forces ANTHROPIC_API_KEY auth and ignores the user's login (measured: api_error in 1.2 s).
  - Transcript hand-off:
    - Each question message carries `<recent_transcript window=N min>` from the LiveFeed plus the question.
    - Nothing is streamed between questions (cost and privacy: the question is the consent moment per turn).
    - Pref `aiTranscriptWindowMin` 2/5/10/15, default 5.
    - V3 explanation turns carry only the trigger lines and the search hits.
  - Lifecycle:
    - Spawned lazily on the first question of a (liveKey, project) tab; idle stop after 10 minutes (same pattern as llmServer.ts); stopped on End Meeting.
    - At most 3 children (`AI_MAX_SESSIONS`); the least recently used idle one is stopped when a fourth is requested.
    - stdin end first, kill after 5 s, Windows `taskkill /PID /T /F` if anything lingers.
  - Window (D4 UI):
    - P1 (recommended): a third pin-bar overlay "ASSISTANT" on the right, 420 px, glass style of ControlsPanel (AUG-154), Ctrl/Cmd+3, with one tab per project session.
    - P2: a permanent column between the transcript and the Action items column (340 px).
    - P3: a separate always-on-top window.
    - P1 keeps the transcript at full width and works in the browser build (minus Claude).
    - Compact Mode (AUG-196 user pick, replaces "badge only"): Dock Strip gets a [ ◧ ] side drawer (A3, 320 px to the left, the window widens to 660 px). Ghost Caption gets a floating card (B3, 340 × ≤ 260 px above the caption's right end, fades to a `CTX n` chip after 20 s, not click-through while hovered). Both carry hints + Ask + the streamed answer. Dock Square and Ghost Coin keep a `CTX n` badge that opens them.
  - Transport to the UI: new JSON frames on the existing live WebSocket.
    - client→server: `assistant-start {projectPath}`, `assistant-ask {projectPath, text}`, `assistant-stop {projectPath}`.
    - server→client: `assistant-status`, `assistant-delta` (streamed text), `assistant-message` (final, with a tool-call summary), `copilot-hint`, `copilot-status`.
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
  - Praxis task creation by Claude goes through Praxis `create_task` (server-side counter) followed by `add_action_item({praxisTaskId})` so the existing praxis badge appears; the UI button "→ Praxis task" uses the existing POST /api/praxis/action-items.
- Settings (D7): tab `assistants` "AI assistants" between Projects and Compact mode.
  - AUG-196 change: the copilot row becomes a four-mode radio list with a price/privacy line per mode. `aiCopilotEnabled` and `aiCopilotExplain` are dropped in favour of `aiCopilotMode`, `aiCopilotModel` and `aiCopilotAlwaysBudgetUsd`. `aiCopilotConsent` and `aiCopilotAlwaysAck` are written only by POST /api/assistant/copilot-mode. Always-on needs a checkbox-gated confirmation modal every time it is chosen. The rows below describe the AUG-193 draft.
  - Option A (recommended): two independent toggles.
  - Row "Meeting Copilot" → `aiCopilotEnabled` (bool, default false, ALLOWED_KEYS, strict boolean); hint "Watches the live transcript for references to past agreements and shows matching notes from the chosen Praxis project. Runs on this computer; nothing is sent anywhere."; status line "PraxisOS is not running" when health fails (toggle still saveable).
  - Row "Active session (Claude)" → consent modal, then POST /api/assistant/enable {accept:true} writes `aiSessionEnabled: true` and `aiConsent: {acceptedAt, version: 1}`; /disable deletes the consent; both keys are NOT in ALLOWED_KEYS (same pattern as groqTextEnabled/groqTextConsent); a bumped consent `version` re-asks.
  - Requires Claude Code: GET /api/assistant/status returns `{claude: {found, version}, praxis: {reachable}}`; when not found the toggle is disabled with the hint "Claude Code is not installed or not signed in. Install it, run `claude` once to sign in, then press Recheck." and a Recheck button.
  - Children under Active session: Model dropdown `aiModel` 'sonnet' | 'haiku' | 'opus' (default 'sonnet'); Spending limit per meeting `aiSessionBudgetUsd` 0.5–10 step 0.5 (default 2) → `--max-budget-usd`; Transcript window `aiTranscriptWindowMin` 2/5/10/15 (default 5); checkbox "Explain copilot hints with Claude" `aiCopilotExplain` (default false; enabled only when both toggles are on).
  - Option B (rejected): one master "AI assistants" consent toggle with two children, like the Groq pattern of AUG-190 — rejected because Copilot v1 sends nothing outside and must not be gated behind an Anthropic consent.
  - Sanitizing on PATCH: strict booleans, unknown enum values dropped, budget clamped, window snapped to steps.
  - All defaults off → no behavior change for existing users.
- Consent text (modal "Active session (Claude)"):
  - "A) During a live recording, when you ask a question (or a copilot hint is explained), the last N minutes of the transcript, the participant names, the action items and your question are sent to Anthropic through Claude Code under your own Claude account. B) Claude may read files of the chosen project folder. C) It needs Claude Code installed and signed in; usage is billed to your Claude plan."
  - Buttons: Cancel / Agree and enable.
- Privacy and cost (D8):
  - Copilot v1 — nothing leaves the machine, cost 0.
  - Active session per question — system prompt + tool definitions ≈ 15k tokens (cached after the first turn), transcript window (5 min ≈ 750 words ≈ 2.2k tokens in Cyrillic), the question, tool results (route TL;DRs 1–3k), output 200–600 tokens.
  - Prices (2026-10): Sonnet 5.5 $2 / $10 per MTok (cache read $0.20), Haiku 5.5 $0.10 / $0.50, Opus 5.5 $4 / $20.
  - Estimate: first Sonnet turn ≈ $0.04, later turns ≈ $0.01–0.02; 20 questions per hour ≈ $0.3–0.5; Haiku ≈ 1/20 of that; measured Haiku turns $0.0003–0.003.
  - Copilot V3 ≤ 12 turns/hour ≈ $0.15/hour on Sonnet.
  - A 60-minute meeting: the longest real session (57.5 min) had 2,431 words; dense meetings are assumed at ~9k words/hour; Cyrillic ≈ 3 tokens/word → 7k–27k transcript tokens per hour, never sent as a whole.
  - Caps: `--max-budget-usd`, ≤ 3 children, ≤ 12 hints/hour, window ≤ 15 min, idle stop 10 min, stop on End Meeting.
  - Logs carry counts and costs only, never text (same rule as the action-items logs).
- Cross-platform (D9): `resolveClaudeCli()`.
  - env `CLAUDE_CLI_PATH` override → win32: `%USERPROFILE%\.local\bin\claude.exe`, then `where claude`; darwin: `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, then `which claude` after extending `ensureToolPaths()` in electron/src/main.ts with `~/.local/bin` (GUI apps on macOS do not inherit the shell PATH).
  - Prefer a native executable; an npm `.cmd` shim needs `cmd.exe /d /s /c`.
  - Verified once per app start with `claude --version` (10 s timeout), cached.
  - Spawn with `path.join`, `windowsHide: true`, `cwd` = project root; a Cyrillic user directory works when the absolute path is passed (verified: `C:\Users\<cyrillic>\.local\bin\claude.exe`); `toSafePath` is not needed (it exists for whisper-cli args).
  - The `--mcp-config` JSON must be built with JSON.stringify (a hand-written backslash path broke the probe).
  - Both resolver branches get unit tests that mock `process.platform` (like gpuBackend.test.ts).

## Decisions

1. D1 — LiveFeed per liveKey on the server (Core Concepts: Subscription point).
2. D2 — Copilot via direct Praxis MCP HTTP; Active session via Claude's own MCP connection (Praxis access paths).
3. D3 — Copilot V1 now, V3 later, V2 rejected (Copilot loop). Superseded by D10.
10. D10 (AUG-196) — copilot modes, gate g2, own copilot child, compact A3/B3 (Copilot final design).
4. D4 — persistent stream-json child, P1 overlay (Active session launch mode).
5. D5 — project tabs after start, ≤ 3 children (Project chosen after start).
6. D6 — `august` MCP server + add_action_item contract with similarity dedup (Action items contract).
7. D7 — Option A settings, consent only for the session (Settings, Consent text).
8. D8 — caps listed in Privacy and cost.
9. D9 — `resolveClaudeCli()` resolver + PATH rules (Cross-platform).

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
- P2 column: shrinks the transcript.
- P3 separate window: more desktop-shell code, not available in the browser build.
- Re-pointing a running Claude child to another project: cwd is fixed at spawn.

## Components (planned, not implemented)

- liveFeed (component, planned): part of liveTranscription; written by liveTranscription.ts; read by copilotEngine and assistantSession.
- praxisMcpClient (component, planned): Streamable HTTP JSON-RPC client for 127.0.0.1:7865/stream; used by copilotEngine and the assistant status route.
- copilotEngine (component, planned): per (liveKey, project) gate + search loop; depends on liveFeed and praxisMcpClient.
- assistantSession (component, planned): owns one Claude child per (liveKey, project) behind a ClaudeTransport interface; depends on liveFeed; talks to Praxis only through the child.
- augustMcpServer (component, planned): `/api/assistant/mcp/<token>`; depends on liveFeed and liveActionItems (addAssistantItem).
- routes/assistant (planned): GET /status, POST /enable, POST /disable, POST /api/live/:liveKey/action-items.
- Client: AssistantPanel (overlay), CopilotHintCard, Settings tab `assistants`, `CTX n` badge in compact widgets.
- Affected existing components (from the graph explore of liveTranscription and liveActionItems):
  - liveTranscription (three new push lines)
  - liveActionItems (addAssistantItem, `assistant` field, tolerant reader)
  - transcriptActionItems (unchanged)
  - ActionItemsPanel (AI tag)
  - SettingsModal (tab)
  - preferencesStore / routes/preferences (new keys)
  - electron/src/main.ts (`ensureToolPaths`)

## Invariants

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
- Ports, pids, model internals and token counts stay in the server log; the UI shows plain-language status and the spending limit only.

## Route-Specific Constraints

- Research only (AUG-193): no product code; implementation tasks only after the user picks the options.
- Windows x64 and macOS arm64/x64 both mandatory; platform code under `process.platform` guards; `path.join` only.
- UI: 0 border-radius, terminal font in panels, green = primary, yellow = pause/high, red = stop/danger only.
- Never a paid Groq tier; Claude usage is billed to the user's own Claude account and capped by `--max-budget-usd`.

## Open questions

- macOS: does the Claude CLI credential (keychain) work from a child of a GUI app without a prompt? [UNVERIFIED] — prototype on a Mac before implementation.
- Default model: Sonnet (quality) vs Haiku (cost); the mockup shows Sonnet.
- Should the project's praxis-mcp-codex ad-hoc rule (search before answering) be appended to the child's system prompt, or is CLAUDE.md enough?
- Agent SDK vs raw stream-json: decide after a 1-day transport prototype; the interface is the same.
- Whether `praxisRecentPaths` should also record projects opened from the Assistant panel (proposed yes, after the first successful answer).

## Key Files

- server/src/services/liveTranscription.ts — subscription point (:255-259, :191, :195).
- server/src/services/liveActionItems.ts — store, registry, normalizeForCompare, actionTextSimilarity, ACTION_MERGE_MIN_SIMILARITY.
- server/src/services/liveTextCorrection.ts — per-connection consumer pattern.
- server/src/services/groqText.ts — consent gate pattern `groqTextState`, `liveGroqTextFeatures`.
- server/src/routes/groqText.ts — enable/disable with consent.
- server/src/services/llmServer.ts — child process lifecycle, idle stop, pid file.
- server/src/services/praxisIntegration.ts + server/src/routes/praxis.ts — direct task creation, browse dialog.
- server/src/services/preferencesStore.ts + server/src/routes/preferences.ts — ALLOWED_KEYS, sanitizers.
- client/src/components/SettingsModal.tsx — tab strip :283-289, Groq section :719-779.
- client/src/components/GroqTextConsentModal.tsx — consent modal pattern.
- client/src/components/ActionItemsPanel.tsx — action items column.
- client/src/components/LiveTranscriptPanel.tsx — live transcript view.
- electron/src/main.ts — `ensureToolPaths` :83-88.
- docs/mockups/AUG-193/*.html — mockups.
- docs/mockups/AUG-196/findings.md — copilot spec; research/*.mjs — scratch gate-eval, explain-bench and task-board probe scripts (not product code).
