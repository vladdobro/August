# AUG-211 — Action item context: anchor, context content, generation strategy

Research only, 2026-11-16. No product code changed. Mockup: `action-item-context.html` (same folder). Status: mockup approved by the user on 2026-11-16; implementation tasks created (section 7).

## 1. Current data flow and where the link is lost

| Birth path | Where | Transcript data available at that moment | What is stored |
|---|---|---|---|
| Live Groq extraction | `server/src/services/liveActionItems.ts:785` (`tick`), prompt `:619` | Buffer entries `{id, speaker, text}` (`:644`) for new speech + 600-char context tail; ids are the live line ids | `{text, owner, source}` only (`parseExtractionResponse` `:134`, `addItems` `:353`) |
| Local fallback (AUG-168) | `liveActionItems.ts:860` (`runLocalFallback`), prompt `:636` | Same buffer, cut to 2,000 chars | Same |
| Assistant `add_action_item` (AUG-199) | `server/src/services/augustMcp.ts:109` → `addAssistantItemToList` `liveActionItems.ts:222` | The assistant sees the LiveFeed (lines with wall-clock `at`, `liveFeed.ts:5`), the store sees none of it | `{text, owner, assistant}` |
| Manual add, live | WS `action-item-add` `liveTranscription.ts:434` → `createManualItem` `liveActionItems.ts:211` | Nothing | `{text, owner, manual}` |
| Manual add, saved session | `POST /api/sessions/:id/action-items` `server/src/routes/sessions.ts:460` | The saved transcript exists but is not consulted | Same |
| Post-transcription | — | — | No extraction exists after transcription; items only come from the live recording |

Findings:

1. A live line is `{id: randomUUID(), speaker, text}` with **no timestamp** (`liveTranscription.ts:316`); the audio chunk it came from carries no time either (`QueuedChunk`, `liveTranscription.ts:150`). Only the optional LiveFeed stamps lines with a wall-clock time, and it exists only when the assistant or copilot is on.
2. The extractor does know line ids (`BufferEntry`, `liveActionItems.ts:644`), and `noteCorrection` (`:763`) even patches buffer text by id, but the model is sent `{speaker, text}` without ids (`:806`) and returns items without any reference, so the link is dropped inside the Groq call itself, before `addItems`.
3. `ActionItem` (`server/src/types.ts:178`) has no field that could hold a source: id, text, owner, source, createdAt, locked, manual, praxis, assistant. `createdAt` is the extraction time, up to 60 s + queue delay after the words were said.
4. The final transcript uses `[HH:MM:SS] [Me|Them] text` lines (`client/src/components/TranscriptView.tsx:29`); meaning corrections are keyed by utterance index (`TranscriptView.tsx:464`). Live line ids do not exist there.
5. The client already measures time from recording start for mute intervals (`muteIntervals {startMs, endMs}`, `client/src/components/FileUpload.tsx:143`, AUG-181). The recording itself cannot be paused (only Live Text can), so "ms from recording start" equals the position in the audio.
6. The app has no audio player: nothing in `client/src` plays session audio and `sessions.ts` has no route that serves it. Audio may also be deleted automatically (AUG-152).
7. The user reviews the items while transcription is still running, so context that appears only after transcription arrives too late for the main scenario.

## 2. Anchor model (chosen)

An item points to its source with three independent parts, each a fallback for the next:

```ts
interface ActionItemAnchor {
  kind: 'said' | 'added';  // said = taken from speech; added = moment the item was added by hand or by the assistant
  atMs?: number;           // ms from recording start to the start of the first source line (same base as muteIntervals)
  speaker?: 'Me' | 'Them'; // said only
  quote?: string;          // said only: verbatim text of the 1–3 source lines, <= 400 chars, taken from the buffer by the server, never written by a model
  lineIds?: string[];      // live only (<= 3): ids of the live lines, for the jump in the live panel; dropped when the store moves into the session folder
  line?: number;           // saved session only: utterance index in transcript.md (k-th timestamp line, same key as corrections); derived, recomputed on every transcript write
}
// ActionItem gains: context?: string (<= 240 chars), anchor?: ActionItemAnchor; ActionItemLock gains context?: true
// ActionItemsFile gains: recordingStartedAt?: number (epoch ms)
```

How the time is obtained: the client sends `recordingStartedAt` in `action-items-init` (Live and meeting-only sockets alike); the server stamps every queued chunk with its arrival time, and a line's start is arrival time minus the chunk duration. Client and server share one machine clock (loopback). No platform-specific code.

How the model points at lines: every entry of `context` and `transcript` in the prompt gets a short number `n`; each new item returns `"lines":[n,…]`; the server maps numbers back to buffer entries and builds the anchor itself. Invalid or missing numbers → anchor with the time of the first sent line and no quote.

Survival rules:

| Event | Rule |
|---|---|
| Dedup / merge (`applyDedupOps`) | The survivor keeps its own anchor and context. Only when the survivor has none (and `context` is not locked) it takes the removed item's — the same rule the owner field uses today. No list of several anchors. |
| Model edits | No model operation writes `context` or `anchor` after the item is created. Models still never delete items; the merge guard (similarity ≥ 0.6) is unchanged. |
| User edits text or owner | Anchor and context are untouched: the source moment did not change. |
| User edits context | Allowed (PATCH `context`), sets `locked.context`; nothing overwrites it afterwards. |
| Live correction of a source line (AUG-164) | While the recording is live, `noteCorrection` also replaces that line inside the quotes of items that reference its id. The quote is transcript text, not a user field, so locks do not apply. |
| Clear / Copy & Clear in the live panel | Quote and summary stay; the jump is unavailable until the meeting ends (the line is not on screen). |
| Live → final transcript | When transcript.md is written (first transcription and every re-transcription), each anchor is resolved without a model: candidate lines within ±45 s of `atMs`, same speaker when the transcript has roles, best word-stem overlap with the quote (reuse `textStems`); below the threshold or without a quote → the nearest line at or before `atMs`. Result goes to `anchor.line`. |
| Meaning corrections (`transcriptCorrections.ts`) | The session view shows the source line from the transcript version on screen, so accepted fixes appear automatically. The stored quote is not rewritten. |
| Old sessions | No anchor, no context. The UI says so and offers Find in transcript: the same stem matcher over the whole transcript with the item text; no model call. |

## 3. Context content ("minimum necessary context")

| Part | Source | Shown |
|---|---|---|
| Summary: one sentence that makes the title understandable alone — what object it refers to, who asked whom, why, deadline if said | Model (Groq), same call as extraction; empty when the title needs nothing more | Collapsed card, 2 lines |
| Source quote: the 1–3 lines where it was said | Verbatim from the transcript buffer | Expanded card |
| Who said it, and when | Stored fields (`speaker`, `atMs`) | Expanded card, time chip |
| Jump to the moment | Derived (`lineIds` live, `line` saved) | Time chip, Show in transcript |

Not included: several quotes per item, a confidence score, a separate deadline field (the deadline stays in the title/summary as text).

## 4. Generation strategy

| | A. In the extraction call (chosen) | B. Enrichment pass after transcription | C. On demand when the item is opened |
|---|---|---|---|
| Extra model calls | 0 | 1+ per session | 1 per opened item |
| Cost | ≈ +35 output tokens per new item, ≈ +3 input tokens per line (estimate, not measured); `maxTokens` 600 → 900 | A full-transcript request per session (a 57-min meeting ≈ 2,400 words) | Small per call, unbounded per session |
| Latency for the user | None: context arrives with the item | Context appears only after transcription — after the user has already reviewed the list | 1–3 s wait on every first open (estimate) |
| Groq limiter / AUG-167 | Unchanged: same ≤ 80 calls/h, `cloudCallPending` and the corrector yield work as today | Competes with Groq batch fixes (AUG-163) after the meeting | New live calls on the shared limiter; they would have to queue behind extraction or they starve it |
| Consent | Nothing new is sent: the same lines, plus line numbers. Later calls still send items as `{id, text, owner}` only | Same scope, but a second full pass over the text | Same scope |
| Without Groq (local model) | Local prompt asks for `lines` only; no summary, because small local models invent content (AUG-161). Quote and jump still work | A local pass over a long transcript at up to 45 s per window | No answer offline |
| Manual / assistant / Default-mode items | Anchor `added` with the time; assistant may pass `context` itself | Could match them by text | Could match them by text |

Chosen: **A, with the deterministic layer (quote + time + jump) as the floor.** B is rejected for now because it delivers nothing at the moment the list is reviewed and adds calls; it can come back later as an opt-in "fill context for old sessions". C is rejected because it adds live calls that compete with extraction and has no offline answer.

Coverage of the special cases:

- Default-mode recording without Live Text (AUG-200): no live lines exist; manual and assistant items get `{kind: 'added', atMs}`; after transcription the jump goes to the line at that time.
- Assistant items (AUG-199): `add_action_item` gets an optional `context` argument (≤ 240 chars); the assistant already has the transcript window. Anchor `added`.
- Items added to a saved session by hand: no anchor (there is no "moment"); Find in transcript is available.
- Uploads and recovery uploads carry no liveKey and no items — unchanged.

## 5. Storage and API changes

- `ActionItem.context`, `ActionItem.anchor`, `ActionItemLock.context`, `ActionItemsFile.recordingStartedAt` — all optional. `version` stays 1: the reader is tolerant, old files stay valid, no migration. (`sanitizeActionItemsFile` must learn the new fields, otherwise it strips them.)
- WS: `action-items-init` gains `recordingStartedAt`; `action-item-edit` and `PATCH /api/sessions/:id/action-items/:itemId` accept `context`. The `action-items` frame carries the new fields as part of the items.
- transcript.md `## Action items`: the item line is unchanged; an item with context gets one indented sub-line `  - Context: <summary> ([HH:MM:SS])`. `parseTranscript` already stops at the heading.
- Praxis export, separate cards: the description gets a `## Context` block (summary, `Said by <name> at HH:MM:SS`, the quote) **before** the transcript. The whole transcript stays attached — the item context complements it, it does not replace it. One checklist card: summaries are listed in the description, the checklist lines stay as they are.
- august MCP: `list_action_items` returns `context`, `said_at` (`HH:MM:SS`) and `quote`; `add_action_item` accepts `context`.
- Compact widgets (Dock Strip, Ghost Caption): unchanged, title and owner only.

## 6. Decisions (user, 2026-11-16)

1. **Saving a quote — accepted.** The route invariant was "live text is never saved; only action items and participants are". The quote puts up to 400 characters of live text per item on disk (the pending file, then the session folder). Nothing more is sent to Groq, but the invariant and one sentence of the consent text ("they are saved with the session") must be reworded by the server task.
2. **Play from here — separate later task.** It needs a route that serves session audio and a player in TranscriptView; neither exists. It ships after the summary, quote and jump.
3. **Summary of a user-edited item is not regenerated** — part of the approved design; the user can edit the summary directly.

## 7. Implementation tasks

Board ids: 1 = AUG-213, 2 = AUG-214, 3 = AUG-215.

1. Server: anchors and context for action items — time base, numbered lines in both prompts, anchor/context storage and lock rules, merge rule, re-anchoring on transcript write, transcript.md / Praxis / MCP output, tests.
2. Client: context in ActionItemsPanel (live column and session card) — collapsed summary, expanded quote, jump with highlight in LiveTranscriptPanel and TranscriptView, states from the mockup, Find in transcript for old sessions. Depends on 1.
3. Play from the action item's moment — audio route + player. Depends on 2. Optional.

Affected by the change (checked in the project graph and source): LiveTextCorrector (uses `cloudCallPending` — unchanged), decision "Action items priority over correction" (no new calls), rule "Models never delete action items" (merge extended, guard unchanged), transcriptActionItems → Praxis card drafts, ActionItemsPanel in all three variants.
