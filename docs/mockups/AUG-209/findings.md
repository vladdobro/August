# AUG-209 — Naming a transcription: findings

Research date: 2026-11-16. Mockup: `docs/mockups/AUG-209/naming.html`.

## 1. Where the title comes from

| Source | Title | Where |
|---|---|---|
| File upload, single-track recording | the uploaded file name; a recording is named `recording-<epoch ms>.webm` by the client | `server/src/services/sessionManager.ts:77`, `server/src/routes/sessions.ts:740`, `client/src/components/FileUpload.tsx:625` |
| Dual-track recording | `Recording <server locale date-time>` (no file name is passed) | `sessionManager.ts:79`, `sessions.ts:740` |
| Recovered recording | `recovered-<epoch>.<ext>` | `FileUpload.tsx:1143-1147` |
| Platform link (yt-dlp) | `Video from <host>`, then replaced by the video title | `sessions.ts:845-847`, `sessions.ts:881` |
| Direct link | URL path segment, then replaced by the Content-Disposition file name | `sessions.ts:948-953`, `sessions.ts:995` |

The client never generates a title. There is no "auto title" flag: a renamed session and an unnamed one look the same in `session.json`.

## 2. Where the title is shown

| Place | Where |
|---|---|
| Timer page and transcript header (same `<h2>`) | `client/src/components/TranscriptView.tsx:589` |
| Sidebar item | `client/src/components/SessionList.tsx:443` (search by title: `:183`) |
| Archive row | `client/src/components/ArchivePage.tsx:305` |
| Praxis modal (task name default) | `TranscriptView.tsx:970`, `server/src/routes/praxis.ts:89`, `:159` |
| Export file names (non-ASCII letters are stripped; an all-Cyrillic title becomes `transcript`) | `TranscriptView.tsx:534`, `:568`, `:575` |
| Native notification body on completed / failed | `electron/src/main.ts:694-695` |
| Tray tooltip | not shown — only a count of transcribing sessions (`electron/src/tray.ts:63`) |
| Compact mode / Dock Strip | not shown |

## 3. Rename paths

All three end in the same handler.

- Sidebar double-click: `SessionList.tsx:438` → `commitRename` (`:197`, Enter or blur saves, Esc cancels, empty or unchanged is ignored).
- Praxis export: `PraxisModal.tsx:245` → `onRenameSession`.
- `TranscriptView` `onRename` prop (`TranscriptView.tsx:19`), wired at `App.tsx:379`; today only the Praxis modal uses it.
- Handler: `App.tsx:241` `handleRename` — optimistic `setSessions`, `renameSession` (`client/src/api.ts:278`), then `refreshSessions`; on failure it refreshes and sets `loadError`.
- Server: `PATCH /api/sessions/:id` (`sessions.ts:647`) — requires a non-empty string, trims it, calls `updateSession`. No length limit, no status check.

## 4. Rename while the session is transcribing

**Server race (real).** `updateSession` (`sessionManager.ts:119`) reads `session.json`, merges, writes — with no lock. Two overlapping calls can interleave: the pipeline reads the file, the PATCH writes the new title, the pipeline writes its merge of the old copy, and the title is gone. Pipeline writes during `transcribing`: stage changes (`sessions.ts:109`), `completed` (`:155`, `:237`), `failed` (`:177`, `:261`), WAV auto-delete (`sessionManager.ts:347`). During whisper itself nothing writes, so the window is the last seconds (cleaning → saving → completed) — exactly when a user finishes typing.

**Server overwrite (by design).** For link sessions the server replaces the title during `uploading` (`sessions.ts:881`, `:995`). A name typed before that is lost.

**Client.** `App.tsx:69` polls every 5 s. A poll that started before the PATCH landed can return the old title and briefly revert the optimistic value; the next poll corrects it. An input that keeps its own draft does not flicker, but the sidebar may.

**Unmount.** The ring is rendered only while `status === 'transcribing'` (`TranscriptView.tsx:801`). A field placed inside that panel disappears the moment transcription completes; an unsaved draft would be lost unless it is committed on unmount. The header (`:589`) stays mounted across the status change.

**Electron.** `sessionWatcher.ts` (5 s poll) reads the title only at the completed/failed transition, so a rename made before that shows up in the notification with no extra work.

## 5. Rules

| Rule | Decision |
|---|---|
| Save trigger | Enter and blur. No debounce — it would push half-typed names to the sidebar and multiply writes during the race window. |
| Esc | Restores the previous title and leaves edit mode. Stop propagation so the overlay Esc handler (`App.tsx:138`) does not also fire. |
| Empty input | Keeps the current title, no request (the server answers 400 to an empty title). |
| Unchanged value | No request. |
| Max length | 120 characters: `maxLength` on the input, trim + cut on the server. |
| Validation | Trim; collapse line breaks and repeated spaces into one space. No character blacklist — the title is not a file name. |
| Focus | Never auto-focused. Ctrl/Cmd+1..4 use modifiers and keep working inside an input; Electron global shortcuts are not affected. |
| Session switch / transcription finishes while editing | Commit the draft for the session it was typed for. |
| `uploading` status | Editing disabled — the server may still replace the title. |
| Compact mode / Dock Strip | No prompt; these views do not show a title. |
| Failure | Field keeps the typed text, shows "Could not save the name. Try again." in red. |

## 6. Cross-platform

No `process.platform` branch is involved; the change is in shared client and server code and behaves the same on Windows and macOS. No tray, window-title or compact changes. One caution for the race fix: make it an in-process per-session write queue. A tmp-file + rename write of `session.json` can fail with EPERM on Windows while another process (antivirus, indexer) holds the file, so it needs a retry if it is added.

## 7. Decision (user, 2026-11-16)

- **Timer page: P1** — corner pop-up "Name this meeting" from the start of transcription; input, Save, Later. Not T1–T3.
- **Suggested name from a language model**, shown in the pop-up as a yellow chip once it exists. Engine: whichever text model the user already switched on (local model, or Groq online text with its consent; both on → the `batchCorrectionEngine` preference). Neither on → pop-up without a suggestion.
- **Ignored or closed pop-up → the suggestion is applied automatically** when transcription completes. A name the user typed is never replaced.
- **Session page: S1** — click the title to edit; the hover pencil is yellow.
- **Default title** for single-track and recovered recordings becomes `Recording <date time>`, as dual-track already has. Uploaded files keep their file name.

What follows from it:

- The text exists only after whisper, so the suggestion is produced in the post-whisper pass (ring at 100 %, stage text visible) and the chip is on screen for seconds. In practice most unnamed sessions are named by the automatic apply at completion.
- Auto-apply needs to know whether the user named the session: new `titleSource: 'auto' | 'user' | 'model'` in `session.json`. `createSession` and the link flows write `'auto'`, PATCH writes `'user'`, the completion write turns `'auto'` + a suggestion into `'model'`. A session without the field counts as `'user'`, so existing sessions are never renamed.
- `suggestedTitle` is stored in `session.json` before the completion write, so the polling client can show the chip.
- The apply happens inside the same `completed` write, behind the per-session queue — a PATCH can land before or after it, never be half-overwritten.
- Suggestion input: the first ~2,000 characters of the merged transcript plus action item texts. Output accepted only as one line of 3–80 characters, quotes stripped; anything else is dropped silently (log only). Timeout 20 s; a failed or slow suggestion never delays `completed` beyond that and never fails the session.
- The local model call runs inside the existing batch slot, like the rest of the semantic pass. The Groq call goes through the shared text limiter.
- The pop-up never takes focus, shows only in `preparing` / `transcribing`, and "Later" / ✕ hides it for that session until the app restarts.

## 8. Files for AUG-210

- `client/src/components/TranscriptView.tsx` — pop-up on the timer panel, click-to-edit title.
- `client/src/App.css` — styles.
- `client/src/App.tsx` — `handleRename`: keep a pending rename over poll results until the PATCH resolves.
- `client/src/types.ts`, `server/src/types.ts` — `titleSource`, `suggestedTitle`.
- `server/src/services/sessionManager.ts` — per-session queue inside `updateSession`; default title; `titleSource: 'auto'`.
- `server/src/routes/sessions.ts` — PATCH: length cap, whitespace normalisation, `titleSource: 'user'`; link flows keep `'auto'`; completion write applies the suggestion.
- `server/src/services/semanticCheck.ts` — title suggestion step and engine choice.

No new endpoint, no Electron change.
