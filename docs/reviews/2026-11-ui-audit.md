# August UI audit — first-time user, every screen (AUG-203)

Date: 2026-11-09 · Build: 0.2.0 (master 3583769) · Platform checked: Windows 10 x64 (macOS not checked) · Reviewer: Critic (Claude)

Method: the real desktop app was driven through its windows (main, Dock Strip / Square, Ghost Caption / Coin, compact Copilot and Assistant windows) on an isolated server with a clean data folder and fixture meetings (long Cyrillic names, unbroken 84-character name, failed import, 2-hour transcript). Every screen was captured at the default window (1280×866), the minimum window (960×600) and, where relevant, at 1920×1040 and in the real compact window sizes, then inspected by eye plus an automated scan for clipped text, off-screen elements, stray rounded corners and horizontal scrollbars. 112 screenshots were taken; the 24 behind the Major findings are stored next to this file in `2026-11-ui-audit/`.

---

## Part 1 — Executive summary

**Overall state.** The product works end to end, but a newcomer meets friction at every step: 51 defects, 0 blockers, 14 major, 32 minor, 5 cosmetic. The first ten minutes are confusing enough that a trial user may quit before seeing a transcript.

1. **The app disappears on the first recording.** The window shrinks to a small square or side strip; the only explanation covers the timer, and the button that brings the window back is clipped or missing.
2. **The meeting screen does not fit the default window.** The assistant panel hangs past the right edge; at the smallest window a whole panel is missing and the bottom bar breaks into three lines.
3. **The bottom bar covers controls** at the smallest window: the paste-a-link field, and Cancel / Restart during transcription.
4. **The meeting helpers contradict reality.** During a live recording one says it needs live text, the other says no recording is running; each points to the other.
5. **The first recording is a leap of faith.** Default / Live is unexplained, the language shows "RU" for everyone, the time estimate swings from 35 minutes to 2, and a recording that showed words live can end as "no speech".

**Fix first.** One sprint on the recording flow: items 1–3 are low-risk layout fixes; item 4 is wording and state logic; item 5 needs product decisions.

**Decision needed.** Approve or trim the 12 task groups in Part 5, and decide whether the minimum window rises above 960×600 or every screen is re-flowed.

---

## Part 2 — Coverage: what was checked

Sizes: D = 1280×866, M = 960×600, W = 1920×1040, C = the real compact window size. "Run only" means the screenshot exists in the audit run but is not stored in the repo.

| Screen / state | Status | Sizes | Notes |
|---|---|---|---|
| New Transcription (main), dark | checked | D, M | F-07, F-12, F-19 |
| New Transcription, light | checked | D | F-20 |
| Sessions overlay, empty | checked | D, M | F-21 |
| Sessions overlay with sessions (long / unbroken titles, failed, link import, confidence badges) | checked | D, M, light D | F-34, F-35 |
| Sessions: context menu, rename field, delete + Undo | checked | D | rename not committed; one fixture lost to the 5 s Undo |
| Sessions: sort / filter chips | partly | D | seen, not exercised with data |
| Controls overlay | checked | D, M | F-22 |
| Setup Guide: everything missing / only model missing / all green / CPU-only | checked (mocked via URL flags) | D, M | F-11, F-23, F-24 |
| Model download modal | not checked | — | model present; forcing it starts a real 874 MB download |
| Language picker, microphone picker | checked | D | F-17, F-18 |
| System-audio node tooltip | partly | D | text read from the page, no hover shot |
| Recording mode picker: mode → engine → Groq setup | checked | D, M | F-13 |
| First Default recording → Dock Square (first-time hint) | checked | C 180×180 | F-14 |
| Default-mode recording view (ACTION ITEMS + ASSISTANT) | checked | D, M | F-25 |
| End Meeting hold | checked | D | F-25 |
| Transcribing state (ring, estimate, Cancel / Restart) | checked | D, M | F-08, F-09, F-42 |
| Completed real recording (empty result) | checked | D, M | F-10 |
| Session view: long Cyrillic title, action-items card, URL line, unbroken word, 1500-char line, mic-muted divider | checked | D, M, light D | F-36, F-49 |
| Session view: audio deleted / failed import / interrupted link import | checked | D | F-37, F-38 |
| Export menu | checked | D, light D | F-51 |
| Copy menu, Redo (retranscribe) menu | not checked | — | not opened in the run |
| Send to Praxis modal (long path, prefilled title) | checked | D, M | F-39 |
| Archive page: list, select all, bulk bar, delete confirm | checked | D, M | F-40; per-file expand did not open on click |
| Settings → General (dark + light), Audio, Transcription, Projects (empty / add / long path / detail / expanded editor), AI assistants, Compact mode | checked | D, M | F-26 … F-33, F-46, F-48 |
| API Keys (Groq) modal, About modal | checked | D | F-45, F-47 |
| Live recording → Dock Strip (default 360, min 280, max 520) | checked | C | F-03, F-15, F-16 |
| Dock Strip: [ CP ] / [ AS ] compact windows at default and minimum sizes | checked | C | F-05 |
| Dock Strip: + ADD long item, mute, switch | checked | C | F-04 |
| Live panel in the full window: four columns, collapse to rail, hide, reopen from bar | checked | D, M, W | F-01, F-02, F-06 |
| Dock Square during Live | checked | C | F-44 |
| Ghost Caption at rest / hovered tools / CP / AS cells | checked | C 760×112 | F-41 |
| Ghost Caption CTX badge | not checked | — | needs Copilot hints (paid Claude session) |
| Ghost Coin at rest / expanded | checked | C 56×56 / 372×56 | — |
| End Meeting from Ghost, DONE state | partly | — | window restored with the session; no separate DONE state seen |
| START LIVE TEXT in a Default recording | checked (seen, not pressed) | D | — |
| ASSISTANT project picker, enabled chat, long project name in the compact Assistant select | not checked | — | needs Active session on (real Claude session, costs money) |
| Compact Copilot / Assistant windows at minimum and default sizes | checked | C | F-05 |
| Light theme: Live panel | not checked | — | not captured |
| Tray icon and menu | not checked | — | needs a physical click on the tray |
| Windows notifications | not checked | — | none appeared during the run |
| macOS: native display-media picker, audiotee / BlackHole hints and self-test copy, Library data paths in Archive / Settings, Metal GPU indicator, ⌘ shortcut labels, menu bar and Dock, always-on-top across Spaces for the Ghost window | not checked on macOS (Windows run) | — | — |

---

## Part 3 — First-time walk-through (clean data folder)

Launch → first screen. The circuit screen is attractive but mute: four round nodes say "RU", "MIC", "ON", "LIGHT" with no caption of what they control; the language already reads "RU" although Settings says "Auto" (F-12, F-19). The bottom bar "[ Sessions   Controls ]" is the only navigation and nothing invites a first recording other than the big REC. **Stuck point 1:** which language and what "ON" means.

Setup. With components missing, the guide asks the user to run a command "at the project root"; an installed app has no project root (F-11). Skip and "I don't need GPU" are near-invisible, and the all-green state still claims components are required (F-23). **Stuck point 2:** whether the user may continue.

First recording. REC opens a ring with "DEFAULT" and "LIVE" and nothing else; only the thin arc is clickable (F-13). Picking Default makes the whole window vanish into a 180×180 square whose one-time hint covers the timer and never says how to come back (F-14). Expanding reveals a meeting screen whose right panel is cut off (F-01) and two helper panels that point at each other (F-06). END MEETING does not say it must be held (F-25). **Stuck point 3:** where did the app go, and how do I stop.

Transcript. The estimate starts at 35 minutes for a 2-minute file and drops to 2 (F-08); the finish time is in Russian on an English screen (F-42). At the small window Cancel is under the bar (F-09). A silent-mic recording that showed live words ends "Completed — no speech" with a red badge and no next step (F-10). **Stuck point 4:** is it still working, and was my meeting lost.

Settings. Six tabs of mostly jargon (Groq, whisper, CUDA, LLM, Variant A/B, pixel widths) with little plain-language help (F-29, F-30, F-32, F-33); the hotkey conflict warning offers no remedy (F-28); scroll position carries over between tabs (F-27). At the small window about 310 px of content is visible (F-26). **Stuck point 5:** what is safe to change.

---

## Part 4 — Findings table (51)

Severity: Blocker = cannot complete the core task · Major = core task possible but the user is likely stuck, misled or loses data · Minor = visible defect, no blocking · Cosmetic = polish / brandbook.

| # | Sev | Screen | Size | Problem | User impact | Suggested fix | Shot |
|---|---|---|---|---|---|---|---|
| F-14 | Major | First recording (Dock Square) | compact | The window turns into a 180x180 square and the only explanation sits on top of the timer | My app vanished; the card that should tell me where it went hides the timer and does not say how to restore it. | Show the hint as a short toast next to the square ("August keeps recording here. Press [ expand ] to return") and never overlap the timer. | [25](2026-11-ui-audit/25-default-recording-main.png) |
| F-03 | Major | Dock Strip (compact live widget) | compact | Dock Strip: [ Expand ] is clipped at the default width; [ switch ] and [ Expand ] vanish at the minimum width | There is no visible way to get my window back; I only found Esc by accident. | Let the header row wrap onto two lines (timer row / controls row) or move expand + switch into a fixed right-aligned cluster that never shrinks; raise the minimum strip width to the width of the header. | [84](2026-11-ui-audit/84-live-dockstrip-main.png), [92](2026-11-ui-audit/92-dockstrip-min280.png), [93](2026-11-ui-audit/93-dockstrip-max520.png) |
| F-01 | Major | Live recording panel (main window) | default | Live panel: ASSISTANT column runs off the right edge of the window | The right-hand chat panel is sliced in half; I cannot tell what it says or how to send a question. | Make the columns flex with a min-width and, when their sum exceeds the window width, auto-collapse the lowest-priority column (COPILOT, then ASSISTANT) to its rail instead of overflowing. | [94](2026-11-ui-audit/94-live-panel-default.png) |
| F-02 | Major | Live recording panel (main window) | min | Live panel at minimum size: ASSISTANT is completely off-screen, COPILOT cut, toolbar and pin bar wrap | On a small laptop window half the live screen is missing and the bottom bar looks broken; I do not know a third panel exists. | Below ~1100 px show one side column at a time (tabs or rail) and keep pin-bar labels on one line with a shorter label set ("Items / Copilot / Assistant"). | [95](2026-11-ui-audit/95-live-panel-min.png) |
| F-07 | Major | New Transcription | min | Pin bar covers the paste-a-link row at the minimum window size, even when scrolled to the bottom | I cannot see or click the left part of the link field; the bar sits on top of the text I am trying to read. | Add bottom padding equal to the pin bar height + 16 px to .main-content so the last row always ends above the bar. | [02](2026-11-ui-audit/02-newtranscription-min-dark.png), [03](2026-11-ui-audit/03-newtranscription-min-dark-scrolled.png) |
| F-09 | Major | Transcribing state (session view) | min | At the minimum size the Cancel and Restart buttons are hidden behind the pin bar | I want to cancel a long transcription and the button is covered. | Reserve pin-bar height as padding on every full-page view (shared layout rule) and move Cancel/Restart above the ring on short windows. | [31](2026-11-ui-audit/31-transcribing-min.png) |
| F-04 | Major | Live recording panel (main window) | default | Manually added action item shows an empty row (textarea collapsed to 5 px) | I typed a task and it looks lost; I cannot read or edit what I wrote during the meeting. | Auto-size the textarea after mount and on visibility change (measure scrollHeight in a layout effect), with a CSS min-height of one line. | [94](2026-11-ui-audit/94-live-panel-default.png), [96](2026-11-ui-audit/96-live-panel-wide.png) |
| F-05 | Major | COPILOT / ASSISTANT panels (compact windows and columns) | compact | Copilot says "Hints need live text" and Assistant says "No recording is running" while a live recording is running | The app tells me the opposite of what is happening and I do not know what to press next. | Drive these messages from real state: when Copilot is off say "Copilot is off - turn it on in Settings -> AI assistants" with a button; when no project is chosen say that, never "no recording". | [88](2026-11-ui-audit/88-panel-copilot-default.png), [89](2026-11-ui-audit/89-panel-assistant-default.png), [105](2026-11-ui-audit/105-ghost-panel-assistant.png) |
| F-06 | Major | Live recording panel: COPILOT and ASSISTANT columns | default | COPILOT and ASSISTANT send the user to each other and neither offers a way forward | I follow the instructions and end up where I started; I do not know what these panels would give me. | One shared empty state: "Meeting helpers are off" with two lines on what they do and what is sent where, and a single button that opens the exact setting. | [94](2026-11-ui-audit/94-live-panel-default.png) |
| F-13 | Major | Recording mode picker | default | DEFAULT / LIVE choice is unexplained; only a thin arc is clickable; the Groq option asks for a key with no privacy statement | I cannot tell what DEFAULT or LIVE do, which one is safe for a private call, or what happens if I paste a key. | Add one-line captions under each arc ("Record now, transcribe after" / "Words appear while you talk"), make labels clickable, and add "Audio is sent to Groq" with a consent checkbox on the key card. | [18](2026-11-ui-audit/18-modepicker-default-step1.png), [20](2026-11-ui-audit/20-modepicker-live-step2-engine.png), [21](2026-11-ui-audit/21-modepicker-groq-setup-default.png) |
| F-12 | Major | New Transcription / Settings -> Audio | default | Language is "RU" on the main screen but "Auto" in Settings on a fresh install | An English-speaking first user records a meeting with the language forced to Russian and gets garbage. | Use one source of truth with default Auto and show the word "Auto" on the node with a tooltip "Language of the recording". | [01](2026-11-ui-audit/01-newtranscription-default-dark.png), [35](2026-11-ui-audit/35-settings-AUDIO-default.png) |
| F-10 | Major | Session view (empty result) | default | A recording with live captions ends as "Completed - No speech was detected" with 0-41% red confidence and no next step | I recorded a meeting, saw words on screen, and the saved result is empty but says "Completed". | Keep the live lines as the fallback transcript when the final pass is empty, and replace the bare message with "Nothing was recognised" plus [Redo] and [Check microphone] actions and a neutral (not red) badge. | [58](2026-11-ui-audit/58-realrecording-completed-default.png), [99](2026-11-ui-audit/99-after-live-end-transcribing-default.png), [106](2026-11-ui-audit/106-after-ghost-end-restored.png) |
| F-08 | Major | Transcribing state (session view) | default | Remaining time and percent are not credible: 35:44 and 7% at 2 s, 22:37 and 41% at 15 s for a 2-minute file | It tells me the transcript will take 35 minutes, then 18, then it finishes in two; I trust none of the numbers. | Hide the estimate until two consecutive samples agree, show an indeterminate "Transcribing..." state with audio-position percentage only, and take the clock from the server estimatedDuration. | [30](2026-11-ui-audit/30-transcribing-default.png), [31](2026-11-ui-audit/31-transcribing-min.png) |
| F-11 | Major | Setup Guide / Diagnostics | default | Setup Guide tells the user to run a PowerShell script "at the project root"; the command is cut off in a scroll box | I do not know what a project root is, and I am asked to type a command I cannot even read in full. | Offer a single [ Install ] button that runs the script from the app; if the command must be shown, wrap it with a copy button and an install-folder-relative path. | [09](2026-11-ui-audit/09-setupguide-allmissing-default.png), [11](2026-11-ui-audit/11-setupguide-allmissing-default-bottom.png) |
| F-15 | Minor | Dock Strip (compact live widget) | compact | Dock Strip hint card covers the action-items block; "Groq off - only manual items" is jargon | I cannot reach [ + ADD ] until I dismiss a hint; I do not know what Groq is. | Show the hint above the header row, and replace the amber text with "Action items: add by hand" plus a link to turn on automatic ones. | [84](2026-11-ui-audit/84-live-dockstrip-main.png) |
| F-16 | Minor | Live transcript (Dock Strip and main live panel) | compact | Live text invents a phrase from silence ("Спасибо.") and shows no sign of uncertainty | I see words nobody said and may copy them into my notes. | Drop one-word low-confidence lines during silence (VAD gate) or render low-confidence lines dimmed. | 86 |
| F-17 | Minor | Language picker | default | Language picker uses red for EN and amber for AUTO | Red EN looks like "EN is an error" or "disabled". | Use the Necron accent for every option and mark the selected one with a filled arc, never red/amber. | 16 |
| F-18 | Minor | Microphone picker | default | Microphone names run past the right edge of the window and duplicate entries are shown | I cannot read which microphone I am choosing. | Render the list as a vertical menu inside the window with ellipsis + tooltip and hide the "Default" / "Communications" duplicates. | 17 |
| F-19 | Minor | New Transcription | default | The paste-a-link placeholder is cut mid-word; the nodes ON and LIGHT carry no caption of what they control | I do not know that ON means "capture the other side of the call" or that LIGHT is a theme switch until I hover. | Shorten the placeholder to "Paste a YouTube or file link" and give the nodes visible captions ("Their audio: on", "Theme: light"). | [01](2026-11-ui-audit/01-newtranscription-default-dark.png) |
| F-20 | Minor | New Transcription (light theme) | default | Light theme keeps dark grey fills on the drop zone and the link field | The two most important inputs look disabled or dirty on the light theme. | Use the light surface token for these fills and keep a 1 px accent outline. | 04 |
| F-21 | Minor | Sessions overlay (empty) | default | Empty sessions list: cryptic UPL / PREP / TRC / ERR filter nodes and an unlabelled arrow | I do not know what UPL/PREP/TRC/ERR mean and the arrow does not say where it leads. | Hide the filter nodes when the list is empty, label the arrow "Start new session" as a button, and set the search input radius to 0. | 05, 08 |
| F-22 | Minor | Controls overlay | default | Controls menu names do not match what the pages do | I expect Archive to hold old meetings and API Keys to hold several keys. | Rename Archive to "Storage", API Keys to "Groq key", Diagnostics to "System check", and give each a distinct icon. | 06 |
| F-23 | Minor | Setup Guide / Diagnostics | default | Setup Guide: SKIP SETUP and "I DON'T NEED GPU SUPPORT" are near-invisible and the copy contradicts itself | I cannot tell whether I may skip, and the heading contradicts the all-green table. | Hide SKIP when required parts are missing, raise its contrast, and swap the heading to "All set" when every row is green. | [11](2026-11-ui-audit/11-setupguide-allmissing-default-bottom.png), 13 |
| F-24 | Minor | Setup Guide / Diagnostics | default | Optional LANGUAGE MODEL is painted red like a failure; jargon rows | A fully working install still looks broken. | Use a neutral "Optional - off" state for optional rows and plain names (Speech engine, Speech model, Audio converter). | 13, 12 |
| F-25 | Minor | Recording view (Default mode) | default | Default-mode recording view is full of unexplained terms; END MEETING does not say "hold" | I click END MEETING and nothing happens; I do not know I must hold it. | Label the button "Hold to end meeting", show the progress fill from the first press, and replace "Live text off" with "Words appear after you finish. [Show words live]". | 26, 28 |
| F-26 | Minor | Settings (all tabs) | min | Settings at minimum size shows about 310 px of content; Projects prompt editor collapses under its own buttons | I have to scroll a tiny window and the remove button sits on top of the text I am editing. | Make the modal taller with a compact header and give the textarea min-height 120 px with the buttons below it. | 49, 52 |
| F-27 | Minor | Settings (tabs) | default | Settings keeps the scroll position when switching tabs | I think the tab has no first option and miss the master switch. | Reset .settings-body scrollTop to 0 on tab change. | 46 |
| F-28 | Minor | Settings -> General | default | Hotkey fields look read-only and the failure message has no remedy; red buttons for non-destructive actions | I do not know how to change the key or whether DISABLE deletes something. | Show a "Press new keys..." capture field with a Change button and style DISABLE neutral; keep red for delete only. | 33 |
| F-29 | Minor | Settings -> Audio / Transcription | default | Audio and Transcription tabs are full of unexplained jargon | I cannot judge what is safe to change. | Add a one-line plain-language hint under each row and drop file names and model numbers from the labels (keep them in a details expander). | [35](2026-11-ui-audit/35-settings-AUDIO-default.png), 36 |
| F-30 | Minor | Settings -> Projects | default | Projects tab: raw LLM prompt full of tool names, "Praxis" never explained, "REACHABLE" badge, locked default checkbox | It looks like a developer screen; I do not know whether I need a project at all. | Start with a two-line explanation ("A project is a folder where August sends tasks"), collapse the prompt behind "Edit instructions" and rename REACHABLE to "Folder found". | 38, 42 |
| F-31 | Minor | Settings -> Projects | default | Project path list cuts the end of the path; bad-path error leaks an internal server path | I see a developer path I never typed and cannot see which folder I picked. | Truncate in the middle (head + ... + last two folders) and answer "This folder has no Praxis project (.praxis)" without server paths. | 41 |
| F-32 | Minor | Settings -> AI assistants | default | AI assistants tab: radio group drawn as square checkboxes, version number and money amounts in the UI, faint disabled block | I cannot tell if I can pick several modes and what the faint options need. | Render modes as radio circles, drop the version (keep it in logs), and add "Turn on Active session to edit these" beside the dimmed group. | 44, 45 |
| F-33 | Minor | Settings -> Compact mode | default | Compact mode tab uses internal names ("Variant A/B", Dock Square/Strip, Ghost Coin/Caption) and pixel values | I do not know which of the four to choose or what "Variant B needs it" means. | Name options by behaviour ("Small square", "Side strip", "Floating dot", "Floating captions") and show width as Narrow/Wide. | 46, 47, 48 |
| F-34 | Minor | Sessions overlay (populated) | default | Delete and rename are hover-only tiny icons, the context menu has one item, Undo vanishes after 5 s; Esc closes the overlay under an open menu | It is easy to delete by mistake and hard to recover; right-click is useless. | Add Rename / Delete / Copy to the context menu, keep Undo for 10 s with the session title, and close only the menu on Esc. | 61, 63 |
| F-35 | Minor | Sessions overlay (populated) | default | Session rows: failed rows give no reason, long titles lose the meaningful end, auto-names are meaningless | I cannot see why something failed or tell two long meetings apart. | Allow two-line titles, add a one-line reason under Failed, and name recordings by weekday and time ("Meeting, Mon 00:11"). | 60, 64 |
| F-36 | Minor | Session view (TranscriptView) | min | Fixed ~260 px header leaves ~500 px for the transcript; at the minimum size the action-items card pushes the transcript below the fold | I opened a transcript and see no transcript. | Let the header scroll away or collapse to one line after the first scroll, and cap the action-items card at 120 px with its own scroll. | 71, 65 |
| F-37 | Minor | Failed session view | default | Failed session: raw ffmpeg error and "server restart or process crash" as red headline text; only "Transcribe again" | I get a technical message and one button that cannot work. | Map errors to plain causes ("This file could not be read - try another file"), offer Choose another file / Delete next to retry, and keep technical text in a details toggle. | 76, 77 |
| F-38 | Minor | Session view (audio deleted) | default | "NO AUDIO" replaces REDO as a tiny dim label | I do not see why redo is unavailable. | Keep the caption "REDO" and show the reason in a tooltip: "Audio was deleted to save space". | 75 |
| F-39 | Minor | Send to Praxis modal | default | Send to Praxis: unexplained product name, prefilled title cut at the start, hidden side effect, jargon | I do not know what Praxis is or that sending renames my meeting. | Add "Create a task in your Praxis project", shorten the prefilled name to 80 chars, rename "Open" to "Open folder" and hide prompt info. | 73, 74 |
| F-40 | Minor | Archive | default | Archive page: name vs purpose, abbreviations, checkboxes show no tick, bulk bar hides rows at minimum size | I cannot tell what is selected and what YT means. | Show a visible tick, spell the sources out (Mic, File, Link), allow two-line titles and dock the bulk bar below the list. | 79, 81 |
| F-41 | Minor | Ghost Caption (compact) | compact | Ghost Caption controls are 13x16 px, icon-only and hidden until hover | I cannot hit the tiny buttons and do not know that ■ ends the meeting. | Use 24x24 px hit areas with 12 px labels (End, Mute, Expand) and keep the End control always visible in red. | 101, 100 |
| F-42 | Minor | Transcribing state (session view) | default | Mixed languages in the transcribing card | The screen looks half-translated. | Format the label in the UI language: "Done at 23:52". | [30](2026-11-ui-audit/30-transcribing-default.png) |
| F-43 | Minor | Session pages (theme switch) | default | Two different theme switches and a floating "Light" button over content | The same function looks different on every page. | Use one theme control on all pages or move it into Settings -> General. | [58](2026-11-ui-audit/58-realrecording-completed-default.png) |
| F-44 | Minor | Dock Square (compact) | compact | Dock Square during Live shows unexplained counters | I do not know what "2" counts. | Label the counter "2 lines" and give the switch a visible caption. | 98 |
| F-45 | Minor | Groq API key dialog | default | Groq key dialog: no explanation of what Groq is and no privacy line | I would paste a key without knowing what is sent. | Add "Used for faster live text. Audio is sent to Groq" and a link to the privacy note. | 56 |
| F-46 | Minor | Settings -> General (light theme) | default | Amber warning text on the light theme is hard to read | I may miss a warning. | Use a darker amber token in light mode. | 55 |
| F-47 | Cosmetic | About dialog | default | About dialog is squeezed into the 320 px sessions sidebar and shows no app version | Support cannot ask "which version?" and the card looks like a bug. | Render About as a centred modal with the version number. | 57 |
| F-48 | Cosmetic | Settings -> Projects | default | Native light scrollbar in the prompt editor | Breaks the Necron look. | Apply the themed scrollbar (thin, transparent track, accent thumb). | 38 |
| F-49 | Cosmetic | Transcript text | default | Transcript column is a fixed ~620 px and the text start shifts with the speaker label | Reading feels ragged. | Give speaker tags a fixed width and let the text column grow to about 900 px. | 66 |
| F-50 | Cosmetic | Sessions overlay | default | Search input uses border-radius 2px | Brandbook break (0 radius). | Set border-radius: 0 on .session-search-input. | 05 |
| F-51 | Cosmetic | Export menu | default | Export dropdown uses a sans-serif UI font and covers the EXPORT caption | Looks pasted from another app. | Offset the menu 8 px below the caption and use the mono UI font token. | 72 |

### Finding details (what was seen, how to reproduce)

**F-14 · Major · First recording (Dock Square)**  
Starting the first Default recording collapses the 1280x866 window into a square at the bottom-right of the desktop. The one-time hint "Snap your call into the freed space / [ GOT IT ]" covers the timer and level bars, does not say the app is still recording or how to bring the window back, and the title bar shows only "A." with window buttons.  
Repro: Fresh preferences → REC -> DEFAULT. Window: 180x180 client (196x219 outer). Data: compactHintSeen=false.  
Screenshots: [25-default-recording-main.png](2026-11-ui-audit/25-default-recording-main.png)

**F-03 · Major · Dock Strip (compact live widget)**  
The header row holds timer, LISTENING, [ CP ], [ AS ], [ switch ], [ expand ]. At the default 360 px strip the last button is cut to a bare "[" (DOM rect 323..371 in a 344 px viewport). At the minimum 280 px both [ switch ] and [ expand ] are outside the window. Only at ~500 px are all four visible. Esc restores the window but nothing on screen says so.  
Repro: Settings -> Compact mode: keep defaults → REC -> LIVE -> LOCAL → The shell collapses to the strip; look at the top-right corner. Window: strip 360x1080 default; 280 and 520 via resize. Data: Live recording, local engine.  
Screenshots: [84-live-dockstrip-main.png](2026-11-ui-audit/84-live-dockstrip-main.png), [92-dockstrip-min280.png](2026-11-ui-audit/92-dockstrip-min280.png), [93-dockstrip-max520.png](2026-11-ui-audit/93-dockstrip-max520.png)

**F-01 · Major · Live recording panel (main window)**  
With ACTION ITEMS + COPILOT + ASSISTANT open the columns are fixed at 300+300+380 px starting at x=360, so the ASSISTANT column ends at x=1340 in a 1264 px viewport. Its text ("Turn it on in Se...", the helper line under the input) is cut by the window edge and the SEND button is not reachable. The DOM scan reports nothing because the overflow is clipped by the window, not by an element.  
Repro: Start a Default recording (REC -> DEFAULT arc) → Press Expand (or Esc) on the Dock Square → Look at the right edge of the live view with ACTION ITEMS, COPILOT and ASSISTANT columns. Window: 1280x866 outer (1264x827 inner). Data: Fresh data dir, no Praxis project, Active session off.  
Screenshots: [94-live-panel-default.png](2026-11-ui-audit/94-live-panel-default.png)

**F-02 · Major · Live recording panel (main window)**  
At 960x600 the top toolbar wraps to two rows (COMPACT and x drop under PAUSE), COPILOT is cut at the edge, ASSISTANT is not visible at all, and the pin bar buttons break into three lines ("[", "ACTION ITEMS", "]"). Column widths do not respond to the window.  
Repro: Start a recording, expand to the full window → Resize the window to 960x600 (the minimum the app allows). Window: 960x600 outer (944x561 inner). Data: Default recording, three columns open.  
Screenshots: [95-live-panel-min.png](2026-11-ui-audit/95-live-panel-min.png)

**F-07 · Major · New Transcription**  
At 960x600 the page scrolls (vertical scrollbar) and the fixed [ Sessions Controls ] bar sits on top of the "OR PASTE A LINK" label and the left half of the URL input (bar rect y=508..545, input y=528..565). Scrolling to the end does not clear it.  
Repro: Resize to 960x600 → Open New Transcription → Scroll to the bottom. Window: 960x600 outer. Data: Fresh install.  
Screenshots: [02-newtranscription-min-dark.png](2026-11-ui-audit/02-newtranscription-min-dark.png), [03-newtranscription-min-dark-scrolled.png](2026-11-ui-audit/03-newtranscription-min-dark-scrolled.png)

**F-09 · Major · Transcribing state (session view)**  
At 960x600 the transcribing page scrolls; Cancel (red) and Restart sit at the very bottom exactly under the fixed pin bar, so only their top edge is visible.  
Repro: Start any transcription → Resize to 960x600. Window: 960x600 outer. Data: 2 min recording.  
Screenshots: [31-transcribing-min.png](2026-11-ui-audit/31-transcribing-min.png)

**F-04 · Major · Live recording panel (main window)**  
An action item added with [ + ADD ] in the Dock Strip appears in the strip with its text, but in the full-window ACTION ITEMS column the row shows only a checkbox and "Manual -> Owner": the textarea .action-item-text is 5 px tall (scrollHeight 94, overflow hidden). The text becomes visible again only after the session is saved and reopened.  
Repro: Start Live (LOCAL engine) → In the Dock Strip press [ + ADD ], type a long text, Enter → Press Esc to expand the window and look at the ACTION ITEMS column. Window: 1280x866 and 1920x1040. Data: Text: Подготовить спецификацию интеграции платёжного шлюза ... (150 chars).  
Screenshots: [94-live-panel-default.png](2026-11-ui-audit/94-live-panel-default.png), [96-live-panel-wide.png](2026-11-ui-audit/96-live-panel-wide.png)

**F-05 · Major · COPILOT / ASSISTANT panels (compact windows and columns)**  
During a Live recording (timer running, live lines on screen) the compact COPILOT window reads "COPILOT - OFF / Hints need live text." and the compact ASSISTANT window reads "NO PROJECT / No recording is running." with a disabled input "Start a recording to ask about the project." Seen in both the Dock Strip and the Ghost Caption flows.  
Repro: REC -> LIVE -> LOCAL → In the strip press [ CP ] and [ AS ]. Window: copilot 356x228 outer, assistant 376x428 outer (276x148 / 296x248 at minimum). Data: Copilot Off (default), Active session off (default).  
Screenshots: [88-panel-copilot-default.png](2026-11-ui-audit/88-panel-copilot-default.png), [89-panel-assistant-default.png](2026-11-ui-audit/89-panel-assistant-default.png), [105-ghost-panel-assistant.png](2026-11-ui-audit/105-ghost-panel-assistant.png)

**F-06 · Major · Live recording panel: COPILOT and ASSISTANT columns**  
COPILOT column: "Pick a project in ASSISTANT to start hints." ASSISTANT column: "Active session is off. Turn it on in Settings -> AI assistants to ask Claude about this project." [OPEN SETTINGS]. The Settings tab then needs Claude Code, a Praxis project and an Active-session switch. The two empty states form a loop and the word "project" is never explained.  
Repro: Start a Default recording, expand → Read the COPILOT and ASSISTANT columns. Window: 1280x866 outer. Data: Fresh install, no projects.  
Screenshots: [94-live-panel-default.png](2026-11-ui-audit/94-live-panel-default.png)

**F-13 · Major · Recording mode picker**  
Pressing REC opens a ring labelled DEFAULT and LIVE and nothing else. Clicking the label text does nothing (only the 18 px arc responds), Escape steps back one level instead of closing, LIVE leads to LOCAL / GROQ where GROQ is red with 7 px "setup required". The Groq setup card ("Set up Groq API", paste key, "Free tier: 20 requests / minute") never says that audio or text leaves the computer.  
Repro: New Transcription -> press REC → Click the word DEFAULT; then click LIVE -> GROQ. Window: 1280x866 and 960x600. Data: Groq not configured.  
Screenshots: [18-modepicker-default-step1.png](2026-11-ui-audit/18-modepicker-default-step1.png), [20-modepicker-live-step2-engine.png](2026-11-ui-audit/20-modepicker-live-step2-engine.png), [21-modepicker-groq-setup-default.png](2026-11-ui-audit/21-modepicker-groq-setup-default.png)

**F-12 · Major · New Transcription / Settings -> Audio**  
Right after a clean start the top-left node shows RU, while Settings -> Audio -> Language shows Auto and the picker offers AUTO, RU, EN. Nothing explains which is used or why RU is pre-selected.  
Repro: Fresh data dir, open the app → Look at the language node, then Settings -> Audio. Window: 1280x866 outer. Data: Preferences reset (DELETE /api/preferences).  
Screenshots: [01-newtranscription-default-dark.png](2026-11-ui-audit/01-newtranscription-default-dark.png), [35-settings-AUDIO-default.png](2026-11-ui-audit/35-settings-AUDIO-default.png)

**F-10 · Major · Session view (empty result)**  
Two Live recordings that showed live lines ("Спасибо.", "Снимай его! Я не могу. Подпишись." from system audio) ended with a final transcript "No speech was detected in this recording." with status Completed and a red 30% / 0% confidence badge. The text is left-aligned off-centre (x=283) with no hint to check the microphone, try Redo, or open Diagnostics. The microphone itself captured silence in this audit; the disappearance of the live lines is the issue.  
Repro: REC -> LIVE -> LOCAL, wait ~4 min with system audio playing → Hold END MEETING → Open the resulting session. Window: 1280x866 outer. Data: Silence on mic, speech on system audio.  
Screenshots: [58-realrecording-completed-default.png](2026-11-ui-audit/58-realrecording-completed-default.png), [99-after-live-end-transcribing-default.png](2026-11-ui-audit/99-after-live-end-transcribing-default.png), [106-after-ghost-end-restored.png](2026-11-ui-audit/106-after-ghost-end-restored.png)

**F-08 · Major · Transcribing state (session view)**  
The chronometer ring shows REMAINING 00:35:44 / 7% right after End Meeting and 00:22:37 / 41% 13 s later; for a 27-second recording it later showed 00:02:52 / 64%. Elapsed counts seconds while percent and estimate jump. The sessions API reports estimatedDuration 38 (seconds) for the same job, so the UI estimate disagrees with the server estimate.  
Repro: Record 2 minutes in Default mode → Hold END MEETING → Watch the transcribing view for 30 s. Window: 1280x866 outer. Data: 2 min recording, CPU whisper, no GPU.  
Screenshots: [30-transcribing-default.png](2026-11-ui-audit/30-transcribing-default.png), [31-transcribing-min.png](2026-11-ui-audit/31-transcribing-min.png)

**F-11 · Major · Setup Guide / Diagnostics**  
With whisper missing the card says "Run this command in a terminal at the project root" and shows "powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1" in a one-line box with a horizontal scrollbar (code.diag-code-text overflows by 34 px). A user of the installed app has no project root and no terminal habit.  
Repro: Open ?diagnostics&mock=model,whisper,ffmpeg (or break the whisper install). Window: 1280x866 and 960x600. Data: Whisper, model, ffmpeg missing.  
Screenshots: [09-setupguide-allmissing-default.png](2026-11-ui-audit/09-setupguide-allmissing-default.png), [11-setupguide-allmissing-default-bottom.png](2026-11-ui-audit/11-setupguide-allmissing-default-bottom.png)

**F-15 · Minor · Dock Strip (compact live widget)**  
On first display the [ HINT ] "Snap your call into the freed space" sits on top of the ACTION ITEMS header and [ + ADD ]. The permanent amber box says "Groq off - only manual items".  
Repro: Start Live for the first time. Window: 360x1080 strip. Data: compactHintSeen=false.  
Screenshots: [84-live-dockstrip-main.png](2026-11-ui-audit/84-live-dockstrip-main.png)

**F-16 · Minor · Live transcript (Dock Strip and main live panel)**  
With a silent microphone the first live line was "Спасибо." attributed to Me. The strip shows it in the same style as real speech.  
Repro: REC -> LIVE -> LOCAL, stay silent for 60 s. Window: 360x1080 strip. Data: Silent mic.  
Screenshots: 86-live-dockstrip-add-item.png (audit run only)

**F-17 · Minor · Language picker**  
The ring picker colours AUTO amber, RU green and EN red, and the AUTO/EN labels are clipped (8 and 31 px per DOM scan). Red must mean danger only.  
Repro: Click the language node. Window: 1280x866. Data: Fresh install.  
Screenshots: 16-langpicker-default.png (audit run only)

**F-18 · Minor · Microphone picker**  
The device list fans out to the right; "Default - Настольный микрофон (6- Microsoft LifeCam ...", "Communications - Головной телефон (MONITOR III A.N...", "Головной телефон ... Hands-Free AG A..." are cut by the window edge, and several entries refer to the same device.  
Repro: Click the MIC node. Window: 1280x866. Data: 4 Windows audio devices incl. Cyrillic names.  
Screenshots: 17-micpicker-default.png (audit run only)

**F-19 · Minor · New Transcription**  
Placeholder reads "https://youtube.com/watch?v=... or https:// e" (cut). Under the circuit nodes "ON" and "LIGHT" are shown without saying they mean system audio and theme.  
Repro: Open New Transcription. Window: 1280x866. Data: Fresh install.  
Screenshots: [01-newtranscription-default-dark.png](2026-11-ui-audit/01-newtranscription-default-dark.png)

**F-20 · Minor · New Transcription (light theme)**  
In light mode the drop zone and URL input are filled with mid-grey while the page is cream; the disabled TRANSCRIBE button is pale green; placeholder contrast is low.  
Repro: Click LIGHT on New Transcription. Window: 1280x866. Data: -.  
Screenshots: 04-newtranscription-default-light.png (audit run only)

**F-21 · Minor · Sessions overlay (empty)**  
The empty state shows a 3-step explanation and a bare arrow icon, plus four round nodes UPL, PREP, TRC, ERR that filter a list that is empty. No button starts a recording from here. The search box has a 2 px radius (brandbook 0).  
Repro: Ctrl+1 on a clean install. Window: 1280x866 and 960x600. Data: No sessions.  
Screenshots: 05-sessions-empty-default.png (audit run only), 08-sessions-empty-min.png (audit run only)

**F-22 · Minor · Controls overlay**  
"Archive - Storage and audio cleanup" is a disk clean-up page, "API Keys - Groq and engine tokens" opens a single Groq key dialog, "Diagnostics" has an unclear "~" icon and mentions Whisper/FFmpeg/GPU.  
Repro: Ctrl+2. Window: 1280x866 and 960x600. Data: -.  
Screenshots: 06-controls-default.png (audit run only)

**F-23 · Minor · Setup Guide / Diagnostics**  
With nothing installed the card says "Transcription runs on CPU" and offers "I don't need GPU support" and SKIP SETUP in a dim colour (contrast about 1.8:1); with everything installed the heading still reads "August requires local components to be installed." above a green PROCEED.  
Repro: ?diagnostics&mock=model,whisper,ffmpeg, then ?diagnostics. Window: 1280x866. Data: mock params.  
Screenshots: [11-setupguide-allmissing-default-bottom.png](2026-11-ui-audit/11-setupguide-allmissing-default-bottom.png), 13-diagnostics-green-default.png (audit run only)

**F-24 · Minor · Setup Guide / Diagnostics**  
The optional row shows a red bar and "Not installed" in the same red as WHISPER ENGINE. A second "LANGUAGE MODEL" section repeats the name; "meaning-based text checks", GGML MODEL, FFMPEG need (?) tooltips to be understood.  
Repro: ?diagnostics (all green). Window: 1280x866. Data: -.  
Screenshots: 13-diagnostics-green-default.png (audit run only), 12-setupguide-modelmissing-default.png (audit run only)

**F-25 · Minor · Recording view (Default mode)**  
"LIVE TEXT OFF", "START LIVE TEXT", "Me / Them", "Active session is off", "Turn on Online text (Groq)..." appear together; the big left area only says live text is off. END MEETING is a hold button but nothing in the main view says "hold".  
Repro: Start a Default recording, expand. Window: 1280x866. Data: Fresh install.  
Screenshots: 26-default-recording-restored-default.png (audit run only), 28-end-meeting-holding.png (audit run only)

**F-26 · Minor · Settings (all tabs)**  
At 960x600 header + tab strip + footer take about 60% of the window. General shows three rows; on Projects the prompt textarea is about 50 px tall and REMOVE PROJECT / "Saves automatically" overlap it. The six-tab strip itself fits.  
Repro: Resize to 960x600 → Settings -> Projects -> select a project. Window: 960x600 outer. Data: 1 project.  
Screenshots: 49-settings-GENERAL-min.png (audit run only), 52-settings-PROJECTS-min.png (audit run only)

**F-27 · Minor · Settings (tabs)**  
After scrolling TRANSCRIPTION to the bottom and opening COMPACT MODE, the tab opened mid-page (the intro and "Enable Compact mode" were above the fold).  
Repro: Scroll a long tab to the end → Click another tab. Window: 1280x866. Data: -.  
Screenshots: 46-settings-COMPACT-default.png (audit run only)

**F-28 · Minor · Settings -> General**  
"Ctrl + Alt + R" and "Ctrl + Alt + M" are placeholder-styled boxes, the amber text says the shortcut "could not be registered - another application may already use it" with no way to record a new combination; DISABLE and RESET TO DEFAULTS are red.  
Repro: Settings -> General. Window: 1280x866. Data: Hotkey held by another app.  
Screenshots: 33-settings-general-default-dark.png (audit run only)

**F-29 · Minor · Settings -> Audio / Transcription**  
"Audio Boost", "Live Engine: Local", "Recording Mode: Default", "Retranscription Language: None", "Delete audio.wav after transcription", "Engine CPU", "Local language model - Qwen2.5 1.5B - basic", "Online text (Groq)". Only some have one-line help.  
Repro: Settings -> Audio, then Transcription. Window: 1280x866. Data: -.  
Screenshots: [35-settings-AUDIO-default.png](2026-11-ui-audit/35-settings-AUDIO-default.png), 36-settings-TRANSCRIPTION-default.png (audit run only)

**F-30 · Minor · Settings -> Projects**  
The default prompt (visible without any project) contains "Call search_project_context", "get_active_tasks"; no text says what a project or Praxis is; the project detail has "USE AS DEFAULT PROJECT" greyed and checked and a green "REACHABLE" badge.  
Repro: Settings -> Projects. Window: 1280x866. Data: No project, then 1 project.  
Screenshots: 38-settings-PROJECTS-default.png (audit run only), 42-settings-PROJECTS-detail-default.png (audit run only)

**F-31 · Minor · Settings -> Projects**  
The path under a project is shown as "C:\Users\46AD~1\AppData\Local\..." and the meaningful end is hidden (tooltip only). Entering a path that resolves relative returns "No .praxis/ directory found at: D:\claude\August\server\..." revealing the server working directory in red.  
Repro: Settings -> Projects -> + Add project → Enter a non-existent path such as D:\Пользователи\Влад\.... Window: 1280x866. Data: Long Cyrillic path.  
Screenshots: 41-settings-PROJECTS-longpath-added.png (audit run only)

**F-32 · Minor · Settings -> AI assistants**  
Copilot modes use square checkbox glyphs for a single-choice group; "Claude Code Signed in 2.1.319" shows a version; "About $0.10-0.20 per meeting hour", "$1-2.50"; the Active session options are almost invisible when off, with no reason.  
Repro: Settings -> AI assistants. Window: 1280x866. Data: Claude Code logged in.  
Screenshots: 44-settings-AIASSISTANTS-default.png (audit run only), 45-settings-AIASSISTANTS-default-bottom.png (audit run only)

**F-33 · Minor · Settings -> Compact mode**  
Cards are labelled VARIANT A / VARIANT B, widgets are called Dock Square, Ghost Coin, Dock Strip, Ghost Caption, the slider shows "360 px", a dashed amber MORE OPTIONS box.  
Repro: Settings -> Compact mode. Window: 1280x866 and 960x600. Data: -.  
Screenshots: 46-settings-COMPACT-default.png (audit run only), 47-settings-COMPACT-default-bottom.png (audit run only), 48-settings-COMPACT-default-top.png (audit run only)

**F-34 · Minor · Sessions overlay (populated)**  
Right-click gives only "Show in Explorer". Rename and x appear on hover (about 20 px). After x the row becomes "Deleted  Undo" with no title; when I returned about 10 s later Undo was gone and the session (fx-short) was permanently deleted. Escape with the context menu open closes the whole overlay.  
Repro: Ctrl+1 → Hover a row and press x → Wait 10 s. Window: 1280x866. Data: Fixture sessions.  
Screenshots: 61-sessions-contextmenu-default.png (audit run only), 63-sessions-delete-undo-default.png (audit run only)

**F-35 · Minor · Sessions overlay (populated)**  
Failed sessions show only a red "Failed" pill; the title "Еженедельный синк по проекту «Август...»" is cut after about 30 characters (tooltip only); confidence badges 83% green / 55% and 41% red; new recordings are named "Recording 09.11.2026, 00:11:30".  
Repro: Ctrl+1 with the fixtures. Window: 1280x866 and 960x600. Data: fx-long-ru, fx-nospace, fx-failed.  
Screenshots: 60-sessions-fixtures-default.png (audit run only), 64-sessions-fixtures-min.png (audit run only)

**F-36 · Minor · Session view (TranscriptView)**  
The three-line title + meta + node cluster occupy the top 260 px at all times. At 960x600 the first screen shows title, nodes and two action items; the transcript is not visible without scrolling the page body (pin bar overlaps the bottom).  
Repro: Open fx-long-ru at 960x600. Window: 960x600 outer. Data: fx-long-ru (3 action items).  
Screenshots: 71-session-longru-min.png (audit run only), 65-session-longru-default.png (audit run only)

**F-37 · Minor · Failed session view**  
"ffmpeg exited with code 1: Invalid data found when processing input (D:...m4a)" and "Transcription interrupted (server restart or process crash)" are shown in red with a single [Transcribe again] button, also for a corrupt file where retry cannot help.  
Repro: Open fx-failed and fx-link. Window: 1280x866. Data: Failed sessions.  
Screenshots: 76-session-fx3-default.png (audit run only), 77-session-fx4-default.png (audit run only)

**F-38 · Minor · Session view (audio deleted)**  
For a session with deleted audio the REDO node becomes a disabled node with a 6 px "NO AUDIO" caption and low contrast; the header line says "Audio deleted - transcript only."  
Repro: Open fx-nospace. Window: 1280x866. Data: fx-nospace.  
Screenshots: 75-session-fx2-default.png (audit run only)

**F-39 · Minor · Send to Praxis modal**  
Task name is prefilled with the 120-char title and scrolled to its end; the helper "Also becomes the session name" changes the session; "Prompt: default - built-in"; the project path field is cut ("C:\Users\46AD~1\AppData\Local\Temp\clau"); the "Open" button names no object. At 960x600 it still fits.  
Repro: Open fx-long-ru -> EXPORT -> Send to Praxis. Window: 1280x866 and 960x600. Data: fx-long-ru, 1 project with long path.  
Screenshots: 73-sendpraxis-default.png (audit run only), 74-sendpraxis-min.png (audit run only)

**F-40 · Minor · Archive**  
The page lists storage; SOURCE shows MIC / FILE / YT (YT red); row and header checkboxes look empty even when "5 selected" (only the row tint changes); long titles are cut at about 240 px although the table is 570 px wide; at 960x600 the sticky bulk bar covers rows 3-4.  
Repro: Controls -> Archive → Select all → Resize to 960x600. Window: 1280x866 and 960x600. Data: 5 sessions.  
Screenshots: 79-archive-selected-default.png (audit run only), 81-archive-min.png (audit run only)

**F-41 · Minor · Ghost Caption (compact)**  
On hover the left block shows glyphs for expand, switch, pause, mute, stop live, end, CP, AS as 13x16 px buttons without captions; END MEETING is an unlabeled "■" that needs a 1.5 s hold. At rest only timer and "LISTENING" show; "Waiting for speech..." is low-contrast grey on translucent grey.  
Repro: Set Compact -> transcript widget = Ghost Caption → REC -> LIVE -> LOCAL → Hover the left block. Window: 760x112 outer. Data: Ghost widgets on.  
Screenshots: 101-ghost-caption-hover.png (audit run only), 100-ghost-caption-rest.png (audit run only)

**F-42 · Minor · Transcribing state (session view)**  
The card is English ("Elapsed", "Audio", "Cancel", "Restart") but the finish time reads "Завершение в 23:52" in Russian.  
Repro: Hold END MEETING after a recording. Window: 1280x866. Data: OS locale ru-RU.  
Screenshots: [30-transcribing-default.png](2026-11-ui-audit/30-transcribing-default.png)

**F-43 · Minor · Session pages (theme switch)**  
New Transcription uses the LIGHT circuit node; every session / archive page uses a separate rectangular "Light" button fixed at the bottom-right that floats over the page bottom.  
Repro: Open any session; compare with New Transcription. Window: 1280x866. Data: -.  
Screenshots: [58-realrecording-completed-default.png](2026-11-ui-audit/58-realrecording-completed-default.png)

**F-44 · Minor · Dock Square (compact)**  
The live square shows "04:12", "■ 2 ⇄" and a bar chart; the 2 is a line counter and ⇄ switches widget, neither is labelled.  
Repro: Live recording -> [ ⇄ ] to Dock Square. Window: 180x180 client. Data: Live recording.  
Screenshots: 98-live-dock-square-switched.png (audit run only)

**F-45 · Minor · Groq API key dialog**  
Both the picker card and Controls -> API Keys show the same 3-step recipe with "Free tier: 20 requests / minute" and no statement of what data goes to Groq.  
Repro: Controls -> API Keys. Window: 1280x866. Data: Groq not configured.  
Screenshots: 56-apikeys-modal-default.png (audit run only)

**F-46 · Minor · Settings -> General (light theme)**  
The hotkey failure text uses amber on a cream surface (contrast about 2:1).  
Repro: Switch to light theme, Settings -> General. Window: 1280x866. Data: Hotkey conflict.  
Screenshots: 55-settings-GENERAL-default-light.png (audit run only)

**F-47 · Cosmetic · About dialog**  
The About card is clipped to the sidebar column (x 16..303) instead of being centred; it lists author, date and purpose but no version number.  
Repro: Ctrl+1, click the August title. Window: 1280x866. Data: -.  
Screenshots: 57-about-modal-default.png (audit run only)

**F-48 · Cosmetic · Settings -> Projects**  
The default prompt textarea shows a light-grey OS scrollbar with arrow buttons on the dark card.  
Repro: Settings -> Projects. Window: 1280x866. Data: -.  
Screenshots: 38-settings-PROJECTS-default.png (audit run only)

**F-49 · Cosmetic · Transcript text**  
Lines start at x=165 for "Me" and x=179 for "Them"; the right 40% of the 1264 px window is empty; the mic-muted divider text is tiny and low contrast.  
Repro: Open fx-long-ru. Window: 1280x866. Data: -.  
Screenshots: 66-session-longru-urlline-default.png (audit run only)

**F-50 · Cosmetic · Sessions overlay**  
DOM scan: input.session-search-input radius 2px, size 295x35 (div.circuit-dropzone 2px is the known one).  
Repro: Ctrl+1. Window: 1280x866. Data: -.  
Screenshots: 05-sessions-empty-default.png (audit run only)

**F-51 · Cosmetic · Export menu**  
The dropdown starts directly under the node and covers the bottom of the "EXPORT" caption; item font differs from the monospace used elsewhere.  
Repro: Open a session, press EXPORT. Window: 1280x866. Data: -.  
Screenshots: 72-export-menu-default.png (audit run only)


---

## Part 5 — Proposed follow-up tasks (not created — for approval)

Grouped so that each is one implementation task with a clear owner and test. Order = suggested priority.

| # | Proposed task | Findings | Size |
|---|---|---|---|
| T1 | Compact widgets: make the way back visible and the first-time hint non-blocking (Dock Strip header wraps or keeps expand/switch in a fixed cluster; Dock Square / Strip hint as a toast that never covers the timer or the action-items header; Ghost Caption hit areas ≥ 24 px with labels; label the Dock Square counter) | F-14, F-03, F-15, F-41, F-44 | M |
| T2 | Live panel responsive columns (flex with min widths; auto-collapse lowest-priority column when the sum exceeds the window; one side column at a time below ~1100 px; pin-bar column labels never wrap) | F-01, F-02 | M |
| T3 | Reserve the pin-bar height on every full-page view (main, transcribing, session view, archive bulk bar) | F-07, F-09, F-36, F-40 (bulk bar) | S |
| T4 | Manual action item textarea auto-size on mount / visibility change | F-04 | S |
| T5 | Meeting helpers: truthful states and one shared empty state (Copilot off / no project / session off messages driven from real state; one explanation of what the helpers do and where data goes; single button to the exact setting) | F-05, F-06, F-30 (Praxis explanation), F-32 | M |
| T6 | First-recording flow copy and defaults (mode picker captions and clickable labels; one language source of truth defaulting to Auto; "Hold to end meeting"; node captions; mic list as a vertical menu without duplicates; language picker without red/amber) | F-13, F-12, F-25, F-19, F-18, F-17 | M |
| T7 | Transcribing and result states (hide the estimate until stable, use the server estimate; UI-language finish time; empty-result screen with "Nothing was recognised" + Redo + Check microphone and a neutral badge; keep live lines as fallback; plain-language failure causes with a details toggle; "NO AUDIO" reason as tooltip) | F-08, F-42, F-10, F-37, F-38, F-16 | M |
| T8 | Setup Guide / Diagnostics copy (install button or copyable command; hide Skip when required parts are missing; "All set" heading when green; neutral state for optional rows; plain names) | F-11, F-23, F-24 | S |
| T9 | Settings usability (reset scroll on tab change; taller modal with compact header at small windows; hotkey capture field; neutral Disable / Reset buttons; one-line plain hints per row; middle-truncated project paths; no server paths in errors; radio glyphs for single choice; no version number or money in the tab; behaviour-based names in Compact mode; themed scrollbar; darker amber in light mode) | F-26 … F-33, F-46, F-48 | L |
| T10 | Sessions list and Archive (hide filter nodes when empty, labelled "New session" action; context menu with Rename / Delete / Copy; Undo 10 s with title; Esc closes only the menu; two-line titles; failure reason under the Failed pill; visible ticks; spelled-out sources; Controls menu names "Storage / Groq key / System check"; About as a centred modal with version) | F-21, F-22, F-34, F-35, F-40, F-47, F-50 | M |
| T11 | Privacy and consent copy where data leaves the computer (Groq key card and API Keys dialog; Send to Praxis explanation, shorter prefilled name, "Open folder") | F-13 (Groq part), F-45, F-39 | S |
| T12 | Brandbook polish (light-theme input fills, one theme control, wider transcript column with fixed speaker-tag width, Export menu offset and mono font) | F-20, F-43, F-49, F-51 | S |

Decisions the team should make before T2 and T9: (a) raise the minimum window above 960×600 or re-flow every screen for it; (b) whether the six-tab Settings modal stays a modal or becomes a page at small windows.

---

## Appendix — Environment and caveats

- App run: Electron dev shell (`--dev`) attached to an isolated server on port 3077 with a clean data folder; preferences reset to defaults before Phase A. The Windows menu bar and DevTools availability of the dev shell differ from the packaged build; nothing else does.
- Data: fixture meetings only plus four short recordings made during the audit with a silent microphone; no user sessions were used. One fixture (short meeting) was lost when the 5-second Undo expired — itself recorded as F-34.
- The automated scan catches clipped text inside elements, elements outside the viewport, border radii other than 0 / 50 % / pill, and horizontal scrollbars. It does not catch content clipped by the window edge (F-01 was found by eye), nor copy problems.
- Not checked: model download modal, tray menu, native notifications, paid Claude-backed states (Copilot hints, Active session chat, CTX badge), Copy / Redo menus, Archive per-file expand, light-theme live panel, everything macOS-specific (listed in Part 2).
- Scope: audit only. No code was changed; no tasks were created.
