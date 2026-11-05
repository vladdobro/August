# AUG-196 — Meeting Copilot: modes, gate evaluation, explanation turn, contracts

Research only, 2026-11-05, Windows, Claude Code 2.1.318, Praxis MCP 1.30.0. Scripts: `research/gate-eval.mjs`, `research/explain-bench.mjs`, `research/probe.mjs` (run from anywhere; they are not product code). Mockup: `copilot-hints.html`.

## 1. Gate evaluation on real transcripts

Transcripts: `ac0169f7` (Support Weekly, 57.5 min, 2,431 words, ru, Me/Them) and `5ea9fb30` (game video, 21.6 min, one speaker, ru). Long lines split into sentences with interpolated times (743 and 317 lines). Searched against this repo (`D:\claude\August`) and against the project the meeting is actually about (`squarefi-crm`).

| Gate | Transcript | Fires / h | Searches (≥ 20 s gap) | Top hit [exact] | Cards | Useful cards |
|---|---|---|---|---|---|---|
| AUG-193 base (phrases + task id + quoted + Latin capitalized) | 57 min · August | 74 | 50 | 0 | 0 | 0 |
| same | 57 min · squarefi-crm | 74 | 50 | 2 | 4 | 0 |
| same | 21 min game video · August | 100 | 19 | 0 | 0 | 0 |
| g2 (stem triggers + task id; lexicon only feeds keywords) | 57 min · August | 17.7 | 14 | 0 | 0 | 0 |
| g2 | 57 min · squarefi-crm | 17.7 | 14 | 0 | 3 (partial) | 0 |
| g2 | 21 min game video | 0 | 0 | 0 | 0 | 0 |

Findings:

1. The Latin-capitalized-word rule is noise: 64 of 71 base fires ("Slack" ×26, brand names transliterated five ways: Squarify / Squarefy / Quarify / SquareFight / SquareFive). Dropped. The quoted-text rule fired twice, both on UI labels ("Ticket в L2"), dropped.
2. g2 trigger precision, hand-labelled: 17 fires, 3 false (#3 «договорил» = finished speaking, #5 «не договорила», #17 conditional «если договорились»). FP rate 18 %; requiring the reflexive form `договорил(ись|ась|ся)` removes #3 and #5 → ≈ 7 % (1 of 15). Two fires 0 s apart (#7, #8) are one reference → the 20 s gap is needed.
3. Retrieval, not the gate, is the bottleneck: Russian speech against English project-context gives 0 [exact] hits in 28 searches; the 3 g2 cards on squarefi-crm matched brand words (squarefi, live, support) and had nothing to do with the agreement. Local V1 on a ru meeting with en notes is close to useless.
4. The task board helps locally: `find_task_by_keywords` matches Russian prefixes in 3–15 ms (`эскалац` → CRM-244, `L2` → 3 tasks). Agreements from past meetings land on the board through Send to Praxis, so the board is the natural corpus for "we agreed" hints.
5. Claude closes the gap: in assist mode Sonnet turned fire #4 («мы в прошлый раз обсуждали … кнопка "Эскалировать тикет в L2"») into English keywords, searched Praxis itself and returned the real note (`support/csm-group-tickets`, CRM-207). Haiku in the same mode found nothing. Both models rejected the irrelevant partial hit (`none`) — Claude is also the relevance filter that local search lacks.

Gate g2 (proposed, ru/en):

```
(?<!\p{L})(договар\p{L}*|договорил(ись|ась|ся)|договоренност\p{L}*)
(?<!\p{L})(мы|вы|ты|с тобой|с вами)\s+(же\s+)?(\p{L}+\s+)?(обсуждал|решил|обещал|говорил)\p{L}*
(?<!\p{L})в (прошлый|тот|прошлом) раз | на прошлой (встрече|созвоне|планерке) | помнишь | напомни
\b((we|you) (agreed|decided|discussed|promised)|last (time|meeting|call)|as (discussed|agreed)|remember when)\b
task id [A-Z]{2,5}-\d{1,5}
```

Keywords: task id, then project-lexicon terms found in the ±2 lines (route folder names, "Also known as" entries, CamelCase/UPPER terms of project-context; Latin tokens matched with edit distance ≤ 2), then ≤ 2 content words; ≤ 4 total. Local search = `search_project_context(kws)` + `find_task_by_keywords(best single keyword)` in parallel, 2 s timeout. Search latency p50 116 ms (August) / 255 ms (squarefi-crm), max 303 ms.

Thresholds, confirmed with numbers:
- ≥ 20 s between searches per (liveKey, project): kept (17 fires → 14 searches; it merges the duplicate fires).
- ≤ 1 card per route per 5 min: kept.
- ≤ 12 per hour: kept, but applied to Claude turns (the cost ceiling), not only cards. The g2 rate (≈ 15 fires/h after the reflexive fix, ≈ 12–14 searches) sits right at the cap, so a dense meeting is capped, not flooded. Expected shown cards with the Claude filter: 1–5 per hour.

## 2. Copilot modes

| Mode | When it fires | Delay from the spoken phrase | Cost per meeting hour | What leaves the machine | Consent | Needs |
|---|---|---|---|---|---|---|
| Off (default) | never | — | 0 | nothing | — | — |
| Local hints (V1) | g2 gate | 5–10 s (4–9 s transcription + ≤ 0.3 s search) | 0 | nothing | no | PraxisOS running |
| Claude explains (V3) | g2 gate, then Claude on ≤ 12 fires/h | 6–11 s with a local hit (explanation 1.5–2 s warm, 7 s first), 9–19 s when Claude searches itself (assist 2–10 s) | Sonnet ≈ $0.10–0.20, Haiku ≈ $0.01–0.02 | ≤ 4 lines (≤ 80 words) around each trigger + the candidate note lines | yes — choosing the mode is the consent | PraxisOS, Claude Code signed in; the Active session chat does NOT have to be open |
| Always-on Claude (V2) | Claude reads every batch and decides | 10–20 s | Sonnet ≈ $1–2.5 (capped, default $2) | the whole conversation, continuously | yes + a separate confirmation every time it is switched on | PraxisOS, Claude Code |

Verdict: offer the switch with all four positions, default Off, "Claude explains" marked Recommended. Reasons: V1 is the only private option but the test shows it rarely finds anything on a Russian meeting with English notes — the user must see that trade-off rather than have it hidden; V2 is legitimate for users who accept cost and full streaming, so it is offered behind a warning and a confirmation, never as default. The mode lives on the AI assistants tab (AUG-194 must replace `aiCopilotEnabled` + `aiCopilotExplain` with one `aiCopilotMode`) and can be changed during the meeting from the Assistant panel.

**User decision 2026-11-05:**
- Four-position switch, default Off, Claude explains marked Recommended.
- Choosing a Claude mode is the consent itself: no separate consent toggle, and no "consent given / not given" state in the copilot settings. Always-on keeps its confirmation modal as its consent.
- Copilot model: Haiku / Sonnet / Opus, default Sonnet. It can be changed during the meeting from the ASSISTANT panel mode strip, together with the mode.
- No Always-on warning line inside the panel.
- Compact Mode gets a usable assistant widget (hint + Ask + answer) instead of the badge-only rule. The options are in `compact-assistant.html` and still need the user's pick.

Preferences:
- `aiCopilotMode`: 'off' | 'local' | 'claude' | 'always'. Default 'off'; unknown values become 'off'.
- `aiCopilotModel`: 'haiku' | 'sonnet' | 'opus'. Default 'sonnet'.
- `aiCopilotAlwaysBudgetUsd`: 0.5–10, step 0.5, default 2.
- Choosing 'claude' through POST /api/assistant/copilot-mode writes `aiCopilotConsent {acceptedAt, version}`.
- Choosing 'always' requires the confirmation modal, which writes `aiCopilotAlwaysAck {acceptedAt}`.
- Neither key is in ALLOWED_KEYS (same pattern as groqTextConsent).
- The copilot consent is independent of the Active session consent (AUG-194 must be updated: the copilot no longer depends on the Active session toggle).

## 3. Explanation turn (V3)

Process: a dedicated copilot child per (liveKey, project), separate from the Active session chat child (the chat keeps a clean history and is never blocked by hint turns; the copilot does not need the Active session to be on). It counts toward `AI_MAX_SESSIONS` = 3; spawned lazily on the first fire, idle stop 10 min, stopped on End Meeting.

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --model <aiModel> --strict-mcp-config --mcp-config <JSON.stringify praxis http>
  --setting-sources "" --tools ""
  --allowedTools mcp__praxis__search_project_context mcp__praxis__find_task_by_keywords
  --append-system-prompt <COPILOT_PROMPT> --max-budget-usd <per-meeting cap>
  cwd = project root, windowsHide: true
```

Payload — one user message per fire, nothing else (no participant names, no action items, no earlier transcript):

```
<trigger_lines>
[Them] И более того, мы в прошлый раз обсуждали, что у CSM ... кнопка "Эскалировать тикет в L2".
[Me] Да, это есть в макете.
</trigger_lines>
<candidates>
project-context/support/inbox/README.md L12: Email in the UI (PR #1035): ...
CRM-244: Комментарий L2 в csm-тикете считается первым действием L2 ...
</candidates>
```

trigger_lines = the trigger line, ≤ 1 line before, lines after it within 8 s; ≤ 80 words. candidates = ≤ 3 local hits (route path + L<N> ≤ 160 chars, or task id + title), "(none)" when empty.

COPILOT_PROMPT:

> You are the Meeting Copilot of August. You get a short fragment of a live meeting transcript in which someone refers to a past agreement, plus candidate notes from the PraxisOS project knowledge base. Reply with exactly one line of JSON: {"verdict":"match"|"none","text":"<one sentence in the meeting language, max 160 chars>","source":"<route or task id>"}. verdict "match" only if a candidate note states the agreement or decision being referred to; otherwise {"verdict":"none"}. Never invent facts that are not in the candidates. No markdown, no extra text. If the candidates are empty or irrelevant, you may call search_project_context and find_task_by_keywords once each with 2–4 English keywords (project_root=<root>) before answering.

Answer: one-line JSON. `match` → card "explained" (sentence + source). `none` → no card; the silent counter grows. Unparseable → treated as `none` but a local [exact]/task hit is still shown as plain.

Timeouts and fallback: 6 s when local candidates exist (explain), 12 s when Claude searches (assist). On timeout, error, budget reached, no consent or no Claude Code: a local [exact] or task hit is shown as a plain card ("found" state, no sentence); otherwise nothing is shown.

Measured (persistent child, 3 turns each, squarefi-crm):

| Model · shape | Turn 1 (cold) | Turns 2–3 | Cost turn 1 | Cost next turns | Hour (12 turns) |
|---|---|---|---|---|---|
| Haiku · explain | 3.8 s | 1.8–2.0 s | $0.0030 | $0.0002 | ≈ $0.005 |
| Haiku · assist | 13.1 s | 4.1 s | $0.0030 | $0.0014 | ≈ $0.02 |
| Sonnet · explain | 7.1 s | 1.4–1.5 s | $0.056 | $0.002–0.006 | ≈ $0.10 |
| Sonnet · assist | 9.8 s | 2.2–7.7 s | $0.053 | $0.003–0.020 | ≈ $0.20 |

Turn 1 pays the ~15k-token Claude Code system prompt cache write; later turns read it. Process start to init 0.7 s. End to end from the transcript line: local hit 0.1–0.3 s, explanation +1.5–7 s → within the ≤ 15 s target from the line; from the spoken phrase add 4–9 s. Default model for the copilot: Sonnet (Haiku missed the only real match).

## 4. Always-on Claude (V2) contract

- Own child per (liveKey, project), separate from the chat and the V3 child (V3 is not running while V2 is on).
- Batch: every 30 s the new feed lines since the last batch, sent only if ≥ 40 new words; ≈ 80–120 turns/hour. Each batch carries only new lines; context lives in the child.
- Context bound: after 30 turns (~15 min) the child is restarted with a ≤ 150-word summary of hints already shown, so cost does not grow with meeting length.
- Answer shape: the same one-line JSON; Claude may call the same two Praxis tools.
- Spending cap per meeting `aiCopilotAlwaysBudgetUsd` (default $2) → `--max-budget-usd`. At the cap the engine switches this meeting to "Claude explains", shows the status "Spending limit reached — switched to Claude explains" and never resumes V2 automatically.
- Switching off on the fly (mode change in the Assistant panel or Settings): stdin end, kill after 5 s (Windows `taskkill /PID /T /F`); hints already shown stay.
- Confirmation modal every time V2 is chosen: "Always-on Claude sends the whole conversation to Anthropic as it happens, through your Claude account. A one-hour meeting costs about $1–2.50 of your Claude usage; it stops at your limit of $2. Cancel / Turn on".

## 5. LiveFeed and copilot engine contract

LiveFeed (server/src/services/liveFeed.ts, one per liveKey):
- Registry like liveActionItems: `acquireLiveFeed(liveKey)` / `releaseLiveFeed(liveKey)` with refcount; created only when a copilot mode is not off or the Active session is enabled.
- Ring buffer of `{id, speaker: 'Me'|'Them', text, at, corrected?: true}`, capped at 20 min or 6,000 words, oldest evicted. Never persisted.
- `push(line)`, `correct(id, text)`, `subscribe(fn) → unsubscribe`, `snapshot(windowMs)`, `around(id, {before: 1, afterMs: 8000, maxWords: 80})`.
- Push points in liveTranscription.ts: right after `send({type:'transcript', id, speaker, text})` (:255-259) → `feed?.push(...)`; in the corrector callback (:195) → `feed?.correct(id, text)`. LiveTextCorrector and LiveActionItemsExtractor untouched.

copilotEngine (one per (liveKey, project path lower-case)):
- Subscribes to the feed; per line: gate → gap check (20 s) → local search (2 s timeout) → mode branch:
  - local: card if [exact] or a task hit; else silent.
  - claude: emit "searching" (only when it goes to Claude), call the copilot child (6 s / 12 s), emit "explained" / "found" (plain fallback) / remove.
  - always: no gate; batches to the V2 child.
- Caps: 1 card per route per 5 min, 12 Claude turns/hour, dedupe by route+line.
- Praxis down: `copilot-status praxis-off`, retry `health` every 30 s, no searches meanwhile.

Frames on the live WebSocket:
- server→client `copilot-hint {hintId, projectPath, at, state: 'searching'|'found'|'explained'|'removed', route?, taskId?, lines?: [{n, text}], text?, source?}` — the same hintId upgrades in place (searching → explained, or → removed when Claude says none).
- server→client `copilot-status {projectPath, mode, state: 'ok'|'praxis-off'|'claude-unavailable'|'budget-reached'|'paused', counts: {shown, silent, dismissed}}`.
- client→server `copilot-dismiss {projectPath, hintId}` — hides the card and suppresses its route/task for the rest of this meeting (liveKey + project).
- client→server `copilot-mode {mode}` — changes the mode for this meeting and saves the pref.

Logging (no transcript text, no keywords — they are transcript-derived):
`[copilot] key=<liveKey 8> project=<basename> fire=trigger|taskid search=<ms> local=exact|task|partial|none claude=<ms>|- verdict=match|none|timeout cost=<usd> shown=<n> silent=<n>`

## 6. UI rules (see the mockup)

- Hint cards live in the ASSISTANT overlay, block "Hints", newest on top; the transcript is never marked.
- `CTX n` badge = cards shown and not dismissed; in the live top bar next to the REC timer; a click opens the overlay. Never blocks, never animates more than once.
- Compact Mode (user pick 2026-11-05 from `compact-assistant.html`): Dock Strip → A3 side drawer (a [ ◧ ] button slides a 320 px drawer to the left of the strip; the window widens to 660 px; hints + chat + Ask input). Ghost Caption → B3 floating card (a second ghost card 340 × ≤ 260 px anchored above the caption's right end with the newest hint + Ask + streamed answer; it fades to a `CTX n` chip after 20 s untouched; it is not click-through while hovered). the indicator widgets (Dock Square, Ghost Coin) keep a `CTX n` badge that switches to the transcript widget with the assistant open.
- Copilot mode and model can be changed during the meeting from the ASSISTANT panel mode strip; that strip is the only place in the panel where a model name appears.
- Nothing found = no card; the Hints tab header shows "n checked silently".
- No model names, token counts or prices inside cards; the mode line of the panel says "Claude explains" or "Local hints" only. Prices appear only in Settings next to each mode.
