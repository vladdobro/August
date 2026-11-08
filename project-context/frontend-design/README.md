# Frontend Design System

## TL;DR
- The UI uses a Necron-inspired dark color palette (--necron-*) defined as CSS custom properties in App.css.
- Dark/light theme is managed by ThemeProvider context in client/src/theme.tsx with localStorage persistence.
- Light mode uses muted sage/stone grays (#c4cec8, #d0d8d3) — no white backgrounds or bright greens allowed.
- Dark mode accent is gauss green (#00c876); light mode accent is deep forest green (#0a7b50).
- All theme-dependent colors use CSS variables; dark mode overrides use :root[data-theme='dark'] selectors.
- Layout is transcript-first (AUG-154): main content always takes 100% width; SessionList lives in a left overlay and ControlsPanel (New session, Settings, Archive, API Keys, Diagnostics, plus a desktop-only update item) in a right glass overlay, opened by the always-visible bottom pin bar ([ Sessions / Controls ]), Ctrl/Cmd+1 / Ctrl/Cmd+2, or 8px edge-hover zones (200ms); Esc, backdrop click or the toggle closes them. Only one overlay is open at a time; state is not persisted.
- Sidebar uses V3 Bracketed design with [ bracket — node — bracket ] rows, hex grid background, orbital-circle filter chips with connecting rays, and "planet parade" layout.
- Sidebar header shows the clickable August logo left of the title; clicking it creates a new session.
- FileUpload uses a circuit-node radial layout with SVG connection lines and positioned circular control nodes.
- TranscriptView header uses a circuit diagram with info node and action nodes (Copy, Export, Retranscribe).
- Export dropdown includes "Send to Praxis", which opens a modal with project chips (a dropdown above 5 projects), an always-visible path input and a prompt note.
- Settings modal uses a tab strip (General, Audio, Transcription, Projects, AI assistants, Compact mode) in the terminal font with an accent bottom border on the active tab.
- UI audit 2026-11 (AUG-203): @docs/reviews/2026-11-ui-audit.md lists 51 first-time-user defects (14 Major) found in the running app on Windows; fixes are pending user approval as follow-up tasks.
- Known layout gaps from the audit: the pin bar reserves no bottom space on full-page views, and the live columns (300+300+380 px) overflow the 1264 px default viewport.
- During recording, the center node turns red with SVG pulse rings and 12 radial frequency bars from AnalyserNode data.
- ThemeToggle renders as a circuit node inside FileUpload; it renders as a fixed button only when TranscriptView is active.
- Chronometer Ring (Tomb Amber palette) replaces the shimmer bar during transcription with an animated SVG countdown and phase transitions. After zero it runs a tick sweep, and after a 2 s hold the 00:00:00 digits fade into the server stage inside the ring until the server finishes (AUG-189).
- Diagnostics page uses W40K CRT terminal aesthetic: monospace font stack, 0 border-radius, scan-line overlays, staggered fade-in animations.
- Font stacks are defined as CSS custom properties: --font-gothic (UnifrakturMaguntia, reserved for future decorative use), --font-terminal (Cascadia Code stack), and the system UI font.
- Terminal font (--font-terminal) applies to diagnostics page, session context menu items, and code blocks — never use hardcoded font-family for terminal fonts.
- Titles use system UI font; page headings use accent gradient, modal titles use var(--accent).
- ControlsPanel is the only app menu (AUG-160): the sidebar hamburger (≡) menu was removed; the sidebar header keeps only the logo (New session) and the "August" title (About).
- Brutalist angular design: 0 border-radius (90-degree corners) on all major elements — cards, buttons, inputs, modals, dropdowns. Only status badges (999px pill) and circuit nodes (50% circle) are rounded.
- Color utility schema: top priority = green filled buttons + light green bold text (#a0e2c0); high = yellow filled buttons + green bold text; normal = unfilled green/yellow buttons (80/20 split); low = white/green text, not bold; situational = red for alerts/close.
- Buttons: primary uses accent bg with #e0e8e3 text and 0 border-radius; ghost uses transparent bg with border; both hover with translateY(-1px).
- Inputs: 0 border-radius, 1px border, focus shows accent border with glow.
- Status badges use 999px pill radius with ~15% opacity background matching their status color.
- Modals use rgba(0,0,0,0.45) backdrop with blur(8px), 0 border-radius card with 28px padding, modePickerFadeIn animation.
- Long-press (≥500ms) on the Record button starts recording with saved preferences, bypassing the RecordingModePicker.
- All animations and transitions disabled under prefers-reduced-motion: reduce.
- Responsive: 720px shrinks circuit nodes and paddings (no vertical sidebar stack — the sidebar is an overlay of width min(320px, 88vw)); 640px lets the live top bar wrap; 600px shrinks chronometer.
- Sidebar footer shows a GPU/CPU indicator strip; green for GPU, yellow for CPU fallback, with an Idle/Transcribing sublabel.
- Archive page (AUG-150) is a standalone page from ControlsPanel (not a Settings tab): storage card, CRT scan-line session list with select-all, expandable per-file breakdown, sticky bulk bar and in-app blur-backdrop confirm dialogs; red only on destructive buttons.
- Confidence badge (.confidence-badge, AUG-152): terminal-font 10px outline chip with 0 radius and a 5px square marker; green ≥ 80 (--status-completed), amber 60–79 (--status-uploading), red < 60 (--status-failed); shown in the sidebar session meta and the transcript header for completed sessions only.
- Compact Mode (AUG-156, implemented; designed in AUG-155): 300 ms after a recording starts, the desktop app collapses to a widget chosen in Settings → Compact mode — Variant A in the same window (Dock Strip for the transcript, Dock Square for the indicator) or Variant B as a ghost overlay with August in the tray (Ghost Caption / Ghost Coin); it restores on End Meeting or stays as DONE until clicked.
- Correction diff cards (.correction-card, AUG-163): under a transcript line, one card per pending meaning fix — 'Was' / 'Now' rows with a word-level LCS diff (removed words <del class=correction-del> red line-through, inserted <ins class=correction-ins> green bold), outline 0-radius Accept (green, --status-completed) and Reject buttons; amber 3px left border (--status-uploading); decided fixes collapse to a 'Fix accepted · Undo' / 'Fix rejected · Undo' row; accepted text is shown in the line; no scores or flags are rendered.
- Live columns (AUG-199, supersedes the single AUG-165 Action items column): Transcript canvas (flex, min 360 px) | ACTION ITEMS (300) | COPILOT (300) | ASSISTANT (380) side by side, nothing overlaps; each column (LiveColumn) collapses to a 28 px rail (count + vertical title), hides with × and returns from the pin-bar toggles `[ ACTION ITEMS ] [ COPILOT ] [ ASSISTANT ]` (LiveColumnToggles in OverlayLayer's `extra` slot, only while the live panel is visible), and resizes by its left splitter 240–560 px (double-click resets; the canvas never drops below 360 px).
- Below 900 px the live columns stack under the canvas (the canvas minimum resets to 0); TranscriptView reuses ActionItemsPanel as a card at the top when a session has action items (AUG-165).
- Column layout (visible / collapsed / width per column) is a client preference in localStorage key `august.liveColumns.v1.<s|m|l>` by window width (< 1280 / < 1680 / larger), never on the server; Ctrl/Cmd+3 toggles ASSISTANT, Ctrl/Cmd+4 toggles COPILOT; `CTX n` in the live topbar shows COPILOT (hidden while n = 0).
- ASSISTANT column (AUG-199): project tabs with marks ● running / ○ not started / ! unavailable and a `+` picker (praxisProjects with DEFAULT tag, Recent = praxisRecentPaths, Open… folder dialog).
- ASSISTANT chat: YOU / CLAUDE messages, '+ last N min of the transcript' sub-line, plain-language tool chips (dashed while running), `→ Action item` (✓ Added / Already in the list), `→ Praxis task` (Creating… → ✓ TAG-123 / ✓ TAG-123 (created directly)), Copy.
- ASSISTANT controls: Stop (red) while streaming, Send (green) otherwise; footer Stop session.
- ASSISTANT block states: no project, session off, Claude Code missing / not signed in / too old / unsupported install, PraxisOS not running, spending limit reached, three sessions running, crashed → restarted (system line + 'Ask again').
- ASSISTANT never shows money, model name, token counts or tool names.
- COPILOT column (AUG-197, client/src/components/live/CopilotColumn.tsx): mode strip = mode name (or 'Local hints (Claude Code not available)') + model select (only in Claude modes; the only place a model name appears) + mode select (Claude options disabled while Claude Code is unusable) + Open Settings; picking Always-on opens the shared AlwaysOnConfirmModal (also used by Settings → AI assistants).
- COPILOT Hints block: header 'n shown · m checked silently' (or 'paused'); empty states 'Copilot is off…', 'Pick a project in ASSISTANT to start hints.', 'PraxisOS is not running. Hints are paused…', 'Listening for references to past agreements.'; yellow warn 'Spending limit reached — switched to Claude explains'.
- Hint cards (`.cp-*` in App.css, newest first, yellow left border, 0 radius): searching (dashed, 'Looking for the earlier agreement…' + caret), found (route/task + 2 note lines + optional foot note), explained (EXPLAINED tag, sentence, Source, Show note lines), dismissed row with Undo; actions Open route (TL;DR inline), Ask (prefills the ASSISTANT input), Dismiss; no model names, prices or token counts in cards.
- `CTX n` = shown, not dismissed hints of the active tab (useCopilotHintCount, re-renders only on change).
- Compact Copilot / Assistant windows (AUG-199): frameless windows rendered by CompactCopilotApp / CompactAssistantApp (`?panel=`), drag by the title bar (-webkit-app-region), × hides.
- Compact Copilot window (AUG-197) shows the newest hint (sentence, or route — first line, or 'Looking for…') with Ask and Dismiss, 'n more in the full window', and the budget / PraxisOS-off text; Ask asks directly when the session input is usable, else expands the full window with the input prefilled.
- Compact Assistant window shows a project select, only the last exchange and a one-line input (↵ green, Stop red).
- Dock Strip and Ghost Caption have `[ CP ]` / `[ AS ]` toggles (AUG-201: one shared PanelToggles in DockWidgets.tsx; rendered only when the bridge has setCompactPanel; CP only while Live, AS always); Dock Square and the hover-expanded Ghost Coin show `CTX n` when hints exist and it opens COPILOT in the full window; compact panel styles live in client/src/components/compact/compactPanels.css.
- Ghost Caption (AUG-201): `CTX n` sits in the timer row (always visible when hints exist, hidden on CAPTURE LOST) and opens the compact Copilot window, so August stays in Ghost mode. CP / AS are the last cells of the hover tools grid; with them the tools zone is 128 px and 4 columns (`.ghost-caption--panels`) so the grid stays two rows and the 112 px default height keeps the rectangle layout instead of tipping into the square row. Why: the AUG-195 Ghost Caption scene needs Caption + Copilot + Assistant side by side, and Ghost users had no way to open the panels without leaving Ghost mode.
- Action items export (AUG-166): live and session panels have checkboxes, Select all, a green 'Separate tasks' button, an outline 'One task' button and a per-item '→ Praxis' button; sent items show a short task-id badge such as AUG-12 (AUG-166).
- Also known as: Bold Layout, transcript-first layout, overlay panels, pin bar, panel layout, layout overlays (AUG-154), Compact Mode, compact layout, dock strip, timer square, Ghost HUD, auto-collapse on recording (AUG-155), Ghost Caption, Ghost Coin, Dock Square, Compact mode settings tab, CompactLayer (AUG-156), Archive page, storage page, delete audio UI, bulk delete (AUG-150), confidence badge, auto-deleted label, threshold slider (AUG-152), hamburger menu, ≡ menu, sidebar menu, update menu (removed AUG-160 → ControlsPanel), correction card, diff card, Accept / Reject fix (AUG-163), Action items panel, ActionItemsPanel, participants fields, inline owner edit (AUG-165), Separate tasks, One task, → Praxis, select all, praxis badge, Send again (AUG-166), dynamic action items height, Dock Strip action items cap, teleprompter re-pin (AUG-169), export menu z-index, Export/Redo menu overlap, stacking context trap (AUG-170), mic mute, mute button, MIC OFF tag, muted hint, mic muted divider (AUG-181), Copy & Clear, CLEAR TRANSCRIPT? confirm, hold to stop, HoldToStopButton, useHoldToStop, STOP LIVE TEXT, END MEETING, Hold hint, hold-stop-ring, equal-width Ghost Caption tools (AUG-182), compact daily-use controls, switch widget in place, start live text again, Ghost Caption text size / opacity (AUG-178), [ ⇄ ] switch, pickCompactWidget, overrideRef, START LIVE TEXT, ▶ LIVE, Ghost Caption copy toolbar, A− / A+, background opacity, Dock Square pause, → PRAXIS in compact (AUG-188), post-100% spinner, processing indicator, tick sweep, Still working bar (AUG-177), Chronometer ring zeroed state, chrono-processing, processing stage label, in-ring status, Almost done banner (AUG-189), offReason, Live items off hint, Online text (Groq) child checkboxes, settings-child (AUG-190), Default Prompt field size, prompt textarea 2 rows, expand prompt editor, full-window prompt editor, ⤢ Expand, Ctrl+Shift+E, praxis-expand overlay (AUG-172 → AUG-191), AI assistants tab, settings-choice, settings-money, settings-status, settings-tag, settings-confirm-card, 680px Settings card (AUG-198), live columns, ASSISTANT column, COPILOT column, LiveColumn, column rail, column splitter, pin-bar column toggles, compact Assistant window, compact Copilot window (AUG-199), UI audit, first-time user audit, exec-style report, docs/reviews, coverage table, severity Blocker / Major / Minor / Cosmetic (AUG-203).

The frontend design system defines the Necron-themed visual language, color tokens, theme switching, and component styling rules for the August web app.

## Purpose

Ensure visual consistency and maintainability across all UI components by centralizing design decisions in CSS custom properties and a React theme context. The design uses a Necron-inspired (Warhammer 40k) palette — dark, high-contrast, muted greens with glowing gauss-green accents.

## Core Concepts

### Color Palette

The Necron palette spans from --necron-950 (#040806, near-black) to --necron-50 (#a0e2c0, muted green).
Primary accent in light mode is --necron-400 (#0a7b50, deep forest green).
Primary accent in dark mode is #00c876 (gauss green).
All semantic colors (--accent, --sidebar-bg, --card-bg, --text-primary, etc.) reference the necron scale.
Light mode backgrounds are muted sage (#c4cec8) and stone (#d0d8d3) — never white.
Constraint: avoid very light colours like blanc white or bright/neon green.

### Theme System

ThemeProvider (client/src/theme.tsx) wraps the entire app and provides theme state via React context.
Theme is persisted in localStorage under the key "august-theme".
When no stored preference exists, the system theme (prefers-color-scheme) is used as default.
applyTheme() sets data-theme attribute on document root and color-scheme CSS property.

### Design Tokens (CSS Custom Properties)

All visual values are defined as CSS custom properties on :root in App.css.
Dark mode overrides are scoped under :root[data-theme='dark'].
Token categories: palette (--necron-*), semantic (--accent, --text-primary), component (--card-bg, --sidebar-bg), layout (--btn-radius, --card-radius — both set to 0 for angular design), effects (--shell-gradient, --accent-glow).

### Design Patterns from Brandbook

Border radii: 0 (angular, 90-degree corners) for ALL major elements — cards, shells, buttons, inputs, modals, dropdown menus. This is the brutalist foundation of the design. Only status badges (999px pill) and circuit nodes (border-radius: 50%) use rounded shapes. Never apply rounded corners to new UI elements unless they are explicitly circular/pill components.
Shadows use necron-green-tinted rgba values for colored glow effects.
Buttons and interactive elements use translateY(-1px) on hover for elevation effect.
Transitions use 180ms ease for background and color changes.
Glass effect uses backdrop-filter: blur() on transcript header and theme toggle.
Reduced motion: all transitions and animations are disabled under prefers-reduced-motion: reduce.

### Complete Color Reference

The Necron palette (all values defined in :root of App.css):
| Token | Hex | Usage |
|---|---|---|
| --necron-950 | #040806 | Near-black, page bg (dark), sidebar bg |
| --necron-900 | #0a110d | Dark bg, session context menu bg |
| --necron-850 | #101c17 | Sidebar hover bg, diagnostics hint popup bg |
| --necron-800 | #16261e | Sidebar active bg, progress track bg |
| --necron-700 | #1e3429 | Borders (diagnostics), session context menu border |
| --necron-600 | #28453a | Accent hover (light mode), proceed button borders |
| --necron-500 | #2d6b4f | Muted text, status-completed (light), hint triggers |
| --necron-400 | #0a7b50 | Primary accent (light mode), deep forest green |
| --necron-300 | #00c876 | Primary accent (dark mode), gauss green |
| --necron-200 | #2dd690 | Accent hover (dark), status-completed (dark) |
| --necron-100 | #6adaa5 | Filter chip text, diagnostics text |
| --necron-50 | #a0e2c0 | Sidebar text, section labels, diagnostic node labels |

Semantic color mapping (light → dark):
- --accent: #0a7b50 → #00c876
- --accent-hover: #28453a → #2dd690
- --accent-light: rgba(10,123,80,0.12) → rgba(0,200,118,0.10)
- --accent-glow: rgba(10,123,80,0.20) → rgba(0,200,118,0.30)
- --page-bg: #c4cec8 → #060b08
- --main-bg: #d0d8d3 → #0a110d
- --text-primary: #141e18 → #c0cec4
- --text-secondary: #3e5548 → #5e7d6a
- --card-bg: rgba(195,206,200,0.88) → rgba(12,20,16,0.92)
- --circuit-node-bg: #c0cec4 → #0c1410
- --border-color: rgba(10,123,80,0.22) → rgba(0,200,118,0.18)

Status colors (light → dark):
- --status-uploading: #d49a00 → #d4a020 (amber)
- --status-transcribing: #0a7b50 → #00c876 (green)
- --status-completed: #2d6b4f → #2dd690 (muted green)
- --status-failed: #d44040 → #e05555 (red)

Special accent colors (not from necron scale):
- Recording red: #e05555 (dark), rgba(212,64,64) (light)
- Tomb amber: #d4a028 (accent), #f0c040 (bright), used for chronometer and LIVE mode
- "Them" speaker: #b07d2e (light) → #e2b860 (dark)
- Destructive/delete: #dc2626 (border and hover)
- Button text on accent bg: #e0e8e3

Constraint: never use pure white (#fff, #ffffff) backgrounds or bright/neon green. Light mode backgrounds are muted sage/stone (#c4cec8, #d0d8d3). The only allowed #fff usage is .praxis-btn--send text.

### Color Utility Schema (Priority-Based Styling)

Every UI element that conveys importance or calls for action must follow this priority-based color system. This is the single source of truth for choosing color treatments.

Top priority (critical actions, primary CTA):
- Buttons: green filled (var(--accent) background, #e0e8e3 text)
- Page headings: accent gradient (linear-gradient(135deg, #00c876, #2dd690) with background-clip: text) — e.g. .app-title, .circuit-title, .diag-title, .live-panel-title
- Modal/sub-page headings: color: var(--accent) — e.g. .praxis-modal-title, .model-download-title, .transcript-circuit-title
- Use for: main action buttons, primary navigation, page titles, key status indicators

High priority (important but secondary):
- Buttons: yellow/amber filled (#d4a028 background, var(--necron-950) dark text)
- Text: green bold (var(--accent), font-weight 700-800)
- Use for: download actions, LIVE mode indicators, time-sensitive elements, prominent warnings

Normal priority (standard UI, majority of interface):
- Buttons: NOT filled — outline/ghost style with 1px solid border
- Green elements: ~80% of normal-priority UI (border-color var(--accent), text var(--accent))
- Yellow/amber elements: ~20% of normal-priority UI (border-color #d4a028, text #d4a028)
- Use for: secondary actions, filter chips, navigation items, form controls

Low priority (passive, informational):
- Text: white/light (var(--text-primary) or #c0cec4) and green (var(--accent)), NOT bold (font-weight 400-500)
- No filled backgrounds, no glows
- Use for: metadata, timestamps, descriptions, helper text, muted labels

Situational (alerts, destructive, close):
- Buttons: red filled or red-bordered (#e05555 or #dc2626)
- Text: red (#e05555, var(--status-failed))
- Use for: delete confirmations, error states, close/dismiss buttons, stop/cancel actions, skip warnings
- Red should never appear in normal UI flow — it signals danger or termination only

Audit rule — when auditing color compliance, three passes are mandatory:
- Pass 1 (palette constraints): forbidden values, missing dark overrides, hardcoded vs token usage
- Pass 2 (semantic compliance): for every visible text element and button, verify its color treatment matches its importance level per the schema above. Elements to check: page titles, section titles, button labels, status text, metadata, action labels, modal titles. Each element must be classified by importance level and its CSS verified against the matching schema tier. Page headings (22-26px, weight 800) are top-priority and must use accent gradient; modal/sub-page titles (16-20px, weight 700-800) must use color: var(--accent). Recovery/retry buttons must use green accent (not red) — red is for danger/destruction only.
- Pass 3 (token consistency): all error/warning colors must use var(--status-failed) token, never hardcoded hex values (#c0392b, #e05555, #dc2626). CSS variable fallbacks must match the actual token value.

Third-party integration components (Groq, Praxis, etc.) are NOT exempt from the brandbook — all UI within the product follows the same Necron color system.
An agent performing an audit must flag ALL deviations without exception — never self-exempt elements based on assumed design intent. The user decides which deviations are intentional.
When an agent's output does not match the scope or expectations of the initial task, an RCA task MUST be created before proceeding.

### Typography Rules

Font scale by element type (derived from App.css):
- Page/section titles: 22-26px, weight 800, letter-spacing -0.02em (system UI font)
- Modal titles: 16px, weight 700
- Body text: 14-15px, weight 400-500
- Labels/meta: 12-13px, weight 600-700
- Small labels/badges: 9-11px, weight 700-800, uppercase, letter-spacing 0.04-0.14em
- Circuit node labels: 9-10px, weight 700-800, uppercase, letter-spacing 0.05-0.1em

Font weight conventions:
- 800: titles, headings, primary emphasis
- 700: buttons, labels, strong text, meta items
- 600: secondary emphasis, status text, timestamps
- 500: menu items, dropdown items, moderate emphasis
- 400: body text, descriptions

Letter-spacing conventions:
- Negative (-0.02em): titles and headings for tighter display feel
- Normal (0): body text, descriptions
- Slight (0.02-0.06em): terminal text, search inputs, status labels
- Wide (0.08-0.14em): uppercase labels, CRT text, exterminatus banner, dropzone text

Text transform conventions:
- uppercase: labels, badges, diagnostic section titles, CRT elements, button text in diagnostics
- capitalize: status badges
- none (default): body text, titles, transcript text

Monospace (--font-terminal) is mandatory for: code blocks, diagnostics page, search inputs, dropzone text, praxis path input, session context menu items.
JetBrains Mono is used exclusively for chronometer timer digits (loaded from Google Fonts).
System UI font for all other text (titles, buttons, body).
Do NOT use --font-gothic (UnifrakturMaguntia) — it is loaded but reserved due to readability concerns.

### Spacing & Layout Rules

Container max-widths:
- Upload panel: 680px
- Circuit diagram: 480px (also circuit-dropzone)
- Diagnostics page: 600px
- Archive page: max-width min(620px, 100%), centered; ≤720px rows collapse to a grid-template-areas layout and the bulk bar stretches full width.
- Transcript lines: 760px
- Transcript circuit diagram: 340px
- Modals: min(440-460px, 100%)
- Chronometer info bar: 300px
- Transcription progress: 400px

Standard paddings:
- Card/modal padding: 28-32px
- Section padding: 20-24px horizontal, 16-24px vertical
- Button padding: 8-9px vertical, 14-20px horizontal
- Input padding: 9-10px vertical, 12-14px horizontal
- Small badges: 2px vertical, 8-10px horizontal

Gap system:
- Large (16-24px): between major sections, circuit layout elements
- Medium (10-12px): between controls, action buttons, meta items
- Small (4-8px): between inline elements, filter chips, list items

### Button & Action Patterns

All buttons use border-radius: 0 (angular). See Color Utility Schema for when to use filled vs outline.

Primary / Top-priority button (e.g. .copy-button, .new-session-button, .praxis-btn--send):
- background: var(--accent), color: #e0e8e3
- border-radius: 0
- font-size: 13px, font-weight: 700
- box-shadow: 0 6px 16px var(--accent-glow)
- hover: background var(--accent-hover), translateY(-1px)

High-priority button (e.g. .diag-download-btn):
- background: #d4a028, color: var(--necron-950)
- border-radius: 0
- font-weight: 700, text-transform: uppercase
- hover: background #e0b030, translateY(-1px)

Ghost/outline button — normal priority (e.g. .record-button, .retranscribe-button, .transcription-cancel-btn):
- background: transparent or var(--card-bg)
- border: 1px solid var(--border-color)
- border-radius: 0
- color: var(--text-primary)
- hover: border-color var(--accent), color var(--accent), translateY(-1px)

Destructive / situational button (e.g. .session-delete-button, hover on .diag-btn--skip):
- border: 1px solid rgba(220,38,38,0.2), border-radius: 0
- hover: color #dc2626, background rgba(220,38,38,0.1), border-color rgba(220,38,38,0.5), box-shadow 0 0 8px rgba(220,38,38,0.2)

CRT/diagnostics button (e.g. .diag-btn, .diag-proceed):
- border-radius: 0 (matches global angular rule)
- text-transform: uppercase, letter-spacing 0.04em
- border: 1px solid rgba(0,200,118,0.2)

Disabled state (universal):
- opacity: 0.5
- cursor: not-allowed
- transform: none (removes hover translateY)

Logo button (.app-logo-button) — New Session action in the sidebar header:
- 32px square, transparent bg, no border, border-radius 0
- Renders the August app icon (green "A" #00c876 on #0a110d) as inline SVG, the same mark as electron/build/icon.svg
- Inline SVG, not an image file, so it renders identically under Vite dev and Electron file:// on macOS and Windows
- hover: scale(1.1) plus accent-glow box-shadow

### Input & Form Patterns

All inputs use border-radius: 0 (angular), matching the global brutalist rule.

Standard text input (e.g. .praxis-input, select elements):
- padding: 9-10px vertical, 12px horizontal
- border-radius: 0
- border: 1px solid var(--border-color)
- background: var(--card-bg) or var(--main-bg)
- font-size: 13-14px
- focus: border-color var(--accent), box-shadow 0 0 0 2px var(--accent-light)
- dark mode: background rgba(10,17,13,0.8), border-color rgba(0,200,118,0.3)

CRT search input (sidebar .session-search-input):
- border-radius: 0
- border-left: 3px solid rgba(0,200,118,0.7) (accent bar)
- background: rgba(0,20,12,0.6)
- font-family: var(--font-terminal)
- focus: inset glow box-shadow

Checkbox inputs:
- accent-color: var(--accent)
- width/height: 14-16px
- dark mode: accent-color #00c876

Native select/checkbox overlaid on circuit nodes use opacity:0 for visual hiding while keeping accessibility.

### Status & Indicator Patterns

Status badges (.status-badge):
- border-radius: 999px (pill shape)
- font-size: 11px, font-weight: 700, text-transform: capitalize
- padding: 2px 10px
- Each status has background at ~15% opacity and text at full color:
  - uploading: rgba(212,154,0,0.15) / var(--status-uploading)
  - transcribing: rgba(10,123,80,0.15) / var(--status-transcribing)
  - completed: rgba(45,107,79,0.15) / var(--status-completed)
  - failed: rgba(212,64,64,0.15) / var(--status-failed)

Confidence badge (.confidence-badge, AUG-152, client/src/components/ConfidenceBadge.tsx):
- border 1px solid currentColor, border-radius 0 (a measurement chip, deliberately not a pill), padding 1px 6px
- font var(--font-terminal) 10px weight 700, letter-spacing .04em, tabular-nums; ::before draws a 5px square in currentColor
- tiers from confidenceTier(): ok ≥ 80 → var(--status-completed), warn 60–79 → var(--status-uploading), bad < 60 → var(--status-failed)
- sidebar shows "87%", transcript header shows "87% confidence"; both render only when status is completed and confidenceScore is a number
- the title attribute explains the inputs (token probabilities, audio coverage, filtered hallucinations); no breakdown numbers appear in the UI

Correction cards (AUG-163, client/src/components/TranscriptView.tsx): TranscriptView fetches GET /api/sessions/:id/corrections when a completed session opens; items are grouped by line index and filtered to those whose original text is still inside the line (applyItemsToText mirrors the server); the card sits under the text column (margin-left 84px = timestamp 68px + gap 16px); while any fix is pending a sticky .corrections-bar ('N suggested fixes' + green 'Accept all', amber left border, opaque var(--main-bg) because --card-bg is translucent) sits at the top of .transcript-lines so long recordings are not reviewed card by card; Export menu gets 'Download corrected .txt' (from GET /api/sessions/:id/transcript/corrected) only when at least one fix is accepted; Copy / Download .txt / .srt keep using the original transcript.

Action items panel (AUG-165, client/src/components/ActionItemsPanel.tsx):
- Live variant: rendered inside the ACTION ITEMS LiveColumn with the `embedded` prop (column header replaces its own title row); LiveTranscriptPanel takes the columns through its `columns` prop (`aside` kept as an alias); assistant-created items show a small green-outline `AI` tag (.live-ai-tag).
- Header shows "Action items" and the item count; terminal font and 0 border-radius everywhere.
- Participants fields (Me / Them names, both optional) commit on blur or Enter.
- When live action items are off, a yellow-framed hint explains why (AUG-190, prop offReason fed from the action-items frame field groqText): Online text (Groq) off → 'Turn on Online text (Groq) in Settings → Transcription …', compact 'Groq off — only manual items'; Groq on but 'Collect live action items' off → 'Turn on Collect live action items in Settings → Transcription …', compact 'Live items off — only manual items'.
- Each item has an inline-editable text (textarea), a Me / Them source tag (Me var(--accent), Them #d4a843 like the live speakers), an arrow and an owner input.
- The owner input shows the participant names for Me / Them owners.
- Delete is a × button that turns red only on hover.
- Escape reverts an inline edit; empty text is not committed.
- A user-edited item gets a green left border and the tooltip "Edited by you — the model will not change it".
- Session variant (TranscriptView): card style, a read-only participants line "Me = … · Them = …", and the panel is the first block of .transcript-body when the session has action-items.json or is completed (so notes can be added to any finished session).
- "+ Add an item" sits in the panel header ([ + ADD ] in compact) and opens an inline form right under it (task textarea, optional owner, green Add, Cancel); Enter or Add adds the item and closes the form, Escape or Cancel closes it without adding; manual items show a dashed "Manual" tag instead of Me/Them.
- The header and the add form never scroll; only the item list does (session card: list max-height 40vh), and items render newest first, so a new item appears right under the form.
- Compact variant: no participants fields, header "ACTION ITEMS" + count + [ + ADD ], 11 px text; shown only while live is active — in Dock Strip as a block between the transcript and the footer, in Ghost Caption as a 240 px right column.
- Ghost Caption stops being click-through while the pointer is over the Action items column or an input in it has focus; Escape inside an input cancels the edit instead of expanding August.
- Export bar (AUG-166, live and session variants only, not compact): .action-items-export under the header with a Select all checkbox (indeterminate when some are selected), 'N selected', .action-items-praxis-btn--primary 'Separate tasks' (accent background, like .praxis-btn--send) and outline .action-items-praxis-btn 'One task'; both are disabled with nothing selected.
- Selectable items (AUG-166): li gets .action-item--selectable (flex row) with a .action-item-check checkbox and the content wrapped in .action-item-body; the compact variant keeps the old layout.
- Per-item (AUG-166): .action-item-praxis '→ Praxis' button before delete (= Separate tasks for one item) and .action-item-praxis-badge with the task id without its random suffix; the badge title holds the project path.
- TranscriptView stops rendering transcript lines at the "## Action items" heading — the panel shows those items (AUG-166).

Recording indicator:
- Red dot: 10px circle, var(--status-failed) bg, pulse animation
- Timer: tabular-nums, 14px, weight 700, red color
- Audio level bar: 80px wide, 6px tall, red fill

Error/warning boxes:
- Error: background rgba(212,64,64,0.1), color var(--status-failed), border 1px solid rgba(212,64,64,0.2-0.25), border-radius var(--btn-radius) (main) or 0 (diagnostics). Always use var(--status-failed) token for error text — never hardcode hex values.
- Warning: background rgba(212,160,40,0.08), color #d4a028, border 1px solid rgba(212,160,40,0.2), border-radius 0 (CRT)
- Notice: background rgba(0,200,118,0.06), border-left 3px solid rgba(0,200,118,0.25), border-radius 2px

### Shadow & Glow System

Card shadows:
- Light mode: 0 12px 34px rgba(0,60,36,0.10)
- Dark mode: 0 14px 40px rgba(0,0,0,0.4)
- Shell shadow: 0 24px 70px rgba(0,60,36,0.10) / 0 28px 80px rgba(0,0,0,0.52)

Accent glow pattern:
- Button glow: 0 6px 16px var(--accent-glow)
- Circuit node glow: 0 0 12-24px var(--accent-glow)
- Active node glow: 0 0 8px var(--accent-glow)
- Hover escalation: increase glow spread (e.g. 12px → 24px, 8px → 16px)

Status-colored glows:
- Uploading: box-shadow 0 0 12px rgba(212,154,0,0.2)
- Recording: box-shadow 0 0 30-35px rgba(224,85,85,0.35-0.4)
- Completed: box-shadow 0 0 12px rgba(45,214,144,0.2)
- Failed: box-shadow 0 0 8-12px rgba(224,85,85,0.2)

CRT inset shadows (diagnostics):
- Card: inset 0 1px 0 rgba(0,200,118,0.08), external 0 0 40px rgba(0,200,118,0.06)
- Dropzone: inset 0 0 30-40px rgba(0,10,6,0.4-0.6)

Backdrop-filter blur:
- Transcript header: blur(8px)
- Theme toggle: blur(12px)
- Export/retranscribe menus: blur(12px)
- Modal backdrops: blur(8px)

### Modal & Overlay Patterns

Modal backdrop:
- position: fixed, inset: 0, z-index: 50
- background: rgba(0,0,0,0.45)
- backdrop-filter: blur(8px)
- display: grid, place-items: center
- animation: modePickerFadeIn 0.12s ease-out (opacity 0→1)

Modal card:
- width: min(440-460px, 100%)
- background: var(--card-bg)
- border: 1px solid var(--card-border)
- border-radius: 0 (angular, matching global rule)
- box-shadow: var(--card-shadow)
- padding: 28px

Mode picker backdrop:
- background: rgba(0,0,0,0.2) light / rgba(0,0,0,0.35) dark
- no blur (lighter overlay than modal)

### Scrollbar Styling

Sidebar and live panel scrollbars:
- scrollbar-width: thin
- scrollbar-color: rgba(0,200,118,0.25) transparent
- webkit: width 5px, thumb rgba(0,200,118,0.15), track transparent, hover rgba(0,200,118,0.35)
- border-radius: 0 on thumb
- Diagnostics code block: scrollbar-width thin, thumb var(--necron-700)

### Dark Mode Implementation Rules

CSS variable override pattern: all dark mode styles use `:root[data-theme='dark']` selector prefix. Never use `.dark` class or JS-conditional styling.
Components that override for dark mode must re-declare the specific CSS variables they change — they inherit unchanged values.
Sidebar uses its own always-dark color set (--sidebar-*) independent of theme toggle — sidebar colors never change between themes.
Bracket colors in sidebar use hardcoded rgba(0,200,118,...) because the sidebar bg is always dark.
Dark mode body additionally gets a radial gradient background-image overlay with necron green accents.
Recording state colors (red #e05555) stay the same in both themes.
In dark mode, accent shifts from deep forest (#0a7b50) to gauss green (#00c876) — all accent-dependent elements follow via CSS variables.
Dark mode card backgrounds shift from translucent sage to translucent near-black with slightly higher opacity (0.88 → 0.92).
Dark mode borders use necron green rgba instead of forest green rgba — all borders slightly greener.

### Transcript-first layout and overlays (AUG-154)

- App.tsx renders `.app-layout` (full-width `.main-content`) plus `OverlayLayer`; SessionList and ControlsPanel are passed in as overlay contents and stay mounted (hidden with transform + visibility), so sidebar state survives closing.
- Overlay state is `openOverlay: 'sessions' | 'controls' | null` in App.tsx; it is never persisted, so the app always starts with both overlays closed.
- Every navigation action from either overlay (select session, New session, Diagnostics, Archive, API Keys, Settings) closes the overlay before acting, so modals (z-index 50) never open beneath an overlay.
- Z-order: edge triggers 44 < pin bar 45 < backdrop 46 < overlay panels 47 < modals 50. The fixed ThemeToggle (z 50) is hidden while an overlay is open (`.app-layout--overlay-open .theme-toggle`).
- Keyboard: a window keydown listener in App.tsx maps Ctrl or Cmd + Digit1/Digit2 (checked by `e.code` so non-Latin layouts work) to toggle, Escape to close all.
- Edge triggers are disabled on `(hover: none)` devices and while an overlay is open.
- After an overlay closes, edge hover is suppressed until the cursor leaves the edge zone (or 400ms pass with no zone hovered); otherwise Esc after an edge-hover open re-opened the panel 200ms later, because the zone reappears under the resting cursor.
- `.main-content` reserves 56px bottom padding for the pin bar; the Archive sticky bulk bar sits at `bottom: 60px` and the live "↓ Live" jump button at `bottom: 72px` for the same reason.
- Scan-line texture (2px/4px repeating-linear-gradient) covers `.transcript-body` and the live transcript canvas.

### Compact Mode (AUG-156)

- Status: implemented in AUG-156 (designed in AUG-155); build, server tests and the Electron smoke test pass, interactive verification on Windows and macOS is pending.
- Daily-use controls (AUG-188, implemented from @docs/mockups/AUG-178/compact-controls.html, decisions D1–D6; interactive check on Windows and macOS pending): in-place widget switch, Start Live Text again, Ghost Caption text toolbar, Dock Square Pause, action items → Praxis. Rejected (D6): Copy in Dock Square / Ghost Coin, participants fields in compact — the indicator widgets stay minimal.
- In-place switch [ ⇄ ] (AUG-188, D2): Dock Strip header and Ghost Caption tools have [ ⇄ ]; on Dock Square the mid-row "▤ N ⇄" and on Ghost Coin the face "▤ N" (plus [ ⇄ ] in the expanded row) switch instead of expanding. The switch stays in the variant (Square ↔ Strip, Coin ↔ Caption) whatever Settings pair, is a per-recording override in CompactLayer (overrideRef, reset when a recording starts, Settings untouched) and is resolved by pickCompactWidget in client/src/services/compact.ts: a transcript widget override falls back to its indicator pair while Live is off, and the switch to a transcript widget is refused while Live is off.
- Start Live Text again (AUG-188, D3): the standard view shows [ ▶ START LIVE TEXT ] in the circuit recording info while recording without Live; Dock Strip turns the STOP LIVE TEXT slot into [ ▶ START LIVE TEXT ], Dock Square shows [ ▶ LIVE ] under the timer, Ghost Coin [ ▶ LIVE ] in the expanded row, Ghost Caption a [ ▶ ] tool in place of Stop Live Text. Start buttons are accent-filled (.compact-btn--solid, .ghost-btn--solid, .recording-start-live-btn). Mechanics: See: transcription/live-transcription.
- Ghost Caption text toolbar (AUG-188, D4): on hover a row on the top edge of the lines (.ghost-caption-tbar inside .ghost-caption-mid) with [ COPY ALL ] [ COPY & CLEAR ] (green) [ CLEAR ] (red outline) | [ A− ] size [ A+ ] (12/14/16/18/22 px, default 14) | [ ◐ N% ] background opacity cycle 40/60/78/90/100 % (default 78; text stays opaque). Size and opacity are prefs (See: preferences) applied as CSS vars --ghost-line-size / --ghost-bg on the caption root. CLEAR with skipClearConfirmation off replaces the row with CLEAR TRANSCRIPT? [ YES ] [ NO ] (.ghost-caption-tbar--confirm). The toolbar and confirm are hidden in the square-tools (72 px) layout; there the six left tools are 14 px squares.
- Ghost commands added in ghostProtocol.ts (AUG-188): switch, start-live, copy-all, copy-clear, clear, font-down, font-up, opacity-next; GhostAction 'praxis' {ids}; GhostState carries skipClearConfirmation, captionFontSize, captionOpacity. Copy runs in the main window through the desktop clipboard bridge (See: desktop-shell) because the hidden main window has no document focus.
- Dock Square Pause (AUG-188, D5): an icon (❚❚ / ▶) in the top row only while Live is on and not interrupted, amber when paused; the square top-row icons (pause, mic, expand) render the glyph without brackets and the tag (.compact-square-tag) ellipsizes.
- Action items → Praxis in compact (AUG-188, D1): the compact ActionItemsPanel shows a per-item → and a header [ → PRAXIS ] (all items) in Dock Strip and Ghost Caption; both expand August and open the existing Send to Praxis modal in 'separate' mode with those items (CompactActions.sendToPraxis); no one-click send.
- Settings → Compact mode tab (after Projects): the Enable toggle comes first and every other control is disabled while it is off.
- Mode radios are follow, indicator and transcript; the browser build shows "Desktop app only" with everything locked.
- Indicator widget cards are Dock Square and Ghost Coin; transcript widget cards are Dock Strip and Ghost Caption, each with a mini 16:9 schematic.
- A dashed "More options" box holds keep on top, after recording ends (expand on stop or stay until clicked) and strip width 280–520.
- Preference keys and defaults live in the preferences route, not here.
- Resolution rule (client/src/services/compact.ts): enabled and mode follow picks the transcript widget while Live is active, otherwise the indicator widget.
- A transcript mode recording whose Live was stopped falls back to the indicator because there are no lines to show.
- "Always live transcript" with a Default recording auto-enables Live on the saved liveEngine for that recording only, leaving the saved recordingMode untouched.
- With Live active the indicators show a "▤ N" live-line counter; since AUG-188 clicking it switches to the transcript widget of the same variant in place (it no longer opens the live panel and expands).
- Pause in compact is the Live-transcription pause only (decision 2026-10-29): August has no recording pause, and a real pause would desync the server-capture system track.
- Default-mode widgets have no pause control; Dock Square Pause appears only while Live is on (AUG-188).
- Mic mute UI (AUG-181, implemented from @docs/mockups/AUG-174/mic-mute.html Variant 1): during recording the top-right Mic circuit node is the mute toggle (unmuted "Mic"; muted slashed-mic glyph, "Muted" and a red ring) and the recording info shows a red "MIC OFF — your side is not recorded" tag; the live top bar has "Mute mic" / "Unmute mic" after Pause, red-filled when muted. Compact: Dock Strip [ MUTE ]/[ UNMUTE ] in the foot and a red MIC OFF tag in the head; Dock Square a mic icon button and the tag "SYS · MIC OFF" ("MIC OFF" single-track); Ghost Caption a mic button in the hover tools and a MIC OFF tag that stays visible while muted; Ghost Coin a red 2px border, "MUTED" under the time and [ MUTE ]/[ UNMUTE ] in the expanded actions (expanded width 296 px to fit four buttons). Also on the global hotkey Ctrl/Cmd+Alt+M (configurable in Settings → General) and the tray. Red = muted, never the yellow Pause. Tooltip: "Mute in August's recording" (it does not mute Zoom/Meet/Teams).
- Mute and the live Pause are independent: either can be toggled while the other is active. CompactSnapshot / GhostState carry micMuted and mutedHint; GhostCommand has 'mute' and 'unmute'; CompactActions.setMicMuted(muted).
- Gap markers: muting during Live appends a "— mic muted —" divider line (LiveLine kind 'gap', never merged with the next [Me] text; Copy All keeps it as plain text); the final transcript view renders the untimestamped `— mic muted mm:ss–mm:ss —` lines as a centered divider (transcript-line--gap).
- Speaking while muted: a non-blocking "You're muted in August" notice in the standard view and live panel, and a "YOU'RE MUTED" tag in the compact widgets (the coin's MUTED label blinks).
- Paused visuals: amber blinking timer, PAUSED tag and flat level bars.
- Collapse happens 300 ms after the recording actually starts (CompactLayer watches the recording flag), closes overlays, Settings and the Groq modal, and switches App to the recording view.
- Variant A hides #root with `html.compact-dock #root { display: none }` and renders the widget through a React portal on document.body, so nothing unmounts and FileUpload stays mounted.
- Expand triggers: [ ⤢ ], Esc, Ctrl/Cmd+Shift+C (in-window, not global), double-click on the strip header, tray "Expand August", and tray or notification click during a ghost compact.
- Re-enter with [ ⤡ COMPACT ] in the circuit recording info, "⤡ Compact" in the live top bar, or Ctrl/Cmd+Shift+C.
- A manual expand disables auto-collapse until the next recording.
- On End Meeting the expand policy applies: "stop" restores immediately, "click" shows the DONE face ("DONE · mm:ss") until clicked or Esc.
- Dock Strip: 24px header with rec dot, timer, status, [ ⇄ ] (AUG-188) and [ ⤢ ]; the tools row (AUG-182; always visible since AUG-188 — hover-only hid it when it was needed) is [ COPY ALL ] [ COPY & CLEAR ] (green) [ CLEAR ] (red outline) [ STOP LIVE TEXT ] (red outline, 1.5 s hold with a red progress fill, shared HoldToStopButton). The row wraps (min-height 24px, flex-wrap) so it fits the 280–520 px strip without horizontal scroll. CLEAR with skipClearConfirmation off shows an inline row under the tools "CLEAR TRANSCRIPT? [ YES ] [ NO ]" (.compact-strip-confirm, red bottom border), reset when live ends. Mockup docs/mockups/AUG-175/live-controls.html option B. With Live off the STOP LIVE TEXT slot is [ ▶ START LIVE TEXT ] (AUG-188).
- Hold-to-stop pattern (AUG-182): .hold-btn with inner .hold-btn-fill (scaleX(var(--hold-p))) and .hold-btn--past (white label past 50 %); the fill is a span, not the button background, so dark-theme background resets on .live-panel-btn cannot hide it; 0 border-radius. The live panel top bar wraps (min-height 48px) so the added Copy & Clear never overflows. Every stop control uses it (one mechanic, AUG-182 revision 2): a hold released early shows a Hold hint in place of the label for 1.5 s (.hold-btn--hint hides the label, .hold-btn-hint overlays it). Fill colors per variant: live panel End Meeting #a83232, Dock Strip END MEETING a darker mix of --status-failed, Ghost --ghost-red, Dock Square --status-failed. The circuit center node shows END while recording with a red SVG progress ring (.hold-stop-ring, stroke-dashoffset from --hold-p).
- Dock Strip lines use a 3px speaker bar (Me accent, Them --compact-them) with older lines fading, scan lines and a ↓ LIVE jump button.
- Dock Strip action items block (AUG-169): .compact-strip-actions is sized by its content and capped at max-height calc(100% / 3) of .compact-strip (the full strip height, header and footer included); past the cap only .action-items-list scrolls, and the Add header stays in place.
- With 0 action items the Dock Strip block is header-only: the "No items yet" text and the empty list are hidden there (the count shows 0); the live-items-off hint (Groq off or items off) still shows.
- The Dock Strip block, panel and list use flex: 0 1 auto (content basis) instead of the shared flex: 1 rules, scoped under .compact-strip-actions so the live column and Ghost Caption keep flex: 1.
- Dock Strip teleprompter (AUG-169): a ResizeObserver on .compact-strip-body re-pins scrollTop to the bottom while following, because a growing action-items block shrinks the transcript without a new line arriving.
- Dock Strip footer is [ PAUSE ] [ MUTE ] [ END MEETING ]; END MEETING is a 1.5 s hold (red filled), no confirmation; footer buttons are flex 1 1 auto with min-width 0 and 4px side padding so the row fits the 280 px minimum strip.
- Dock Square: tag MIC + SYS or MIC, Pause icon (Live only), mic and expand icons, a "▤ N ⇄" switch or [ ▶ LIVE ] under the timer (AUG-188), 28px tabular timer, 12 level bars without dB numbers, full-width [ END MEETING ] on the bottom edge (1.5 s hold, no confirmation).
- Ghost Caption: translucent ribbon in teleprompter mode — it receives the last 40 live lines, never clips a line (no line-clamp) and auto-scrolls to the newest text (smooth; instant under reduced motion, and on height change), with a 16 px top fade; timer and status on the left, on hover a 3-column equal-width tools grid (.ghost-caption-tools--grid): [ ⤢ ], [ ⇄ ] (AUG-188), Pause/Resume, Mute, Stop Live Text ([ ▶ ] Start Live Text while Live is off; text-lines-with-slash glyph, 1.5 s hold, sends ghost command 'stop-live') and End Meeting [ ■ ] (1.5 s hold).
- Ghost Caption height is user-resizable (resize caption, teleprompter): a 6 px handle on the inner edge (top when docked at the bottom, bottom when docked at the top) shows a 48×2 px accent bar on hover; the drag runs in main from the cursor position and the result is saved as compactCaptionHeight (72–480, default 112).
- Bug fixed: a growing live line used to stop at the frame edge because each line was clamped to 2 rows and only 3 lines reached the ghost; the main window kept transcribing correctly.
- Ghost Caption is click-through outside its controls and snaps Top or Bottom after a vertical drag.
- Ghost Coin: 56px, hover expands (372 px, room for END MEETING; main clamps ghost width at 380) to [ PAUSE ] or [ ▶ LIVE ], [ MUTE ], [ END MEETING ] (1.5 s hold), [ ⇄ ] (Live only) and [ OPEN ]; a face click with ▤ N switches to Ghost Caption (AUG-188); right-click only opens the menu (no END? confirm), and a free drag snaps to the nearest corner.
- Errors never auto-expand: an interrupted live stream shows a red header with [ RETRY ] [ OPEN ]; a lost capture shows CAPTURE LOST with [ OPEN AUGUST ].
- Red in compact widgets is limited to destructive actions (STOP LIVE TEXT, END MEETING, CLEAR, CLEAR TRANSCRIPT? confirm, also in the Ghost Caption toolbar) and error faces (INTERRUPTED, CAPTURE LOST), per the color utility schema.
- A one-time hint "Snap your call into the freed space" with [ GOT IT ] appears in Variant A widgets.
- All compact animations are disabled under prefers-reduced-motion.
- Data flow: FileUpload publishes a snapshot and actions into client/src/services/compactStore.ts, CompactLayer owns the full | compact | done phase machine, and ghost windows talk over BroadcastChannel 'august-compact' (client/src/components/compact/ghostProtocol.ts).
- Electron constraint: the 960×600 minimum window size is lowered only while compact and restored on expand.
- Electron constraint: macOS animates setBounds and Windows cuts, so the in-window fade (200 ms) carries the motion.
- Electron cannot resize other apps' windows, so Variant A docks to the right edge and shows the one-time snap hint.
- Window mechanics (bounds, ghost window, always-on-top, bridge channels) live in the desktop-shell route.

### Responsive Breakpoints

720px breakpoint (tablet/mobile):
- App layout stays a single full-width column (AUG-154 removed the vertical sidebar stack; the sidebar is an overlay)
- Circuit nodes: center 100px → 84px, corners 64px → 56px
- Node glyph: 24px → 20px
- Node ring inset: 8px → 6px
- Audio bar bottom offset: 58px → 50px
- Circuit dropzone padding: 44px 28px → 28px 16px
- Transcript header padding: 24px 32px → 20px 16px
- Transcript body padding: 24px 32px 48px → 16px 16px 32px
- Upload panel padding: 48px 24px → 32px 16px
- Theme toggle: bottom/right 20px → 12px
- Mode ring SVG: 260px → 210px
- Language ring SVG: 200px → 160px
- Transcript circuit: height 110px → 90px, info node 44→36px, action nodes 40→34px
- Live panel padding-right removed from main-content

640px breakpoint:
- Live panel: width 100vw, no border-left, no box-shadow

600px breakpoint:
- Chronometer ring: 200px → 170px, digits 32px → 26px
- Chrono meta gap: 24px → 16px, font 12px → 11px
- Exterminatus text: 14px → 12px, letter-spacing 0.35em → 0.25em

### Accessibility Rules

Reduced motion (prefers-reduced-motion: reduce):
- ALL transitions set to none on interactive elements
- ALL animations disabled (spinners, pulses, flows, shimmers, fades, reveals)
- Pulse rings hidden (display: none)
- Progress fill: static full-width at 0.5 opacity
- Circuit lines: stroke-dasharray removed
- All component transitions: none

Focus-visible patterns:
- Circuit nodes: outline 3px solid var(--accent), outline-offset 3px
- Select inputs: outline 3px solid var(--accent-glow), outline-offset 2px
- Session items: outline 2px solid var(--accent), outline-offset -2px, hover bg
- Logo (New session) button: outline 3px solid var(--accent), outline-offset 3px
- Mode/language ring arcs: no outline but opacity 1 and increased stroke-width

Interactive accessibility:
- Native select/checkbox elements overlaid with opacity:0 on circuit nodes for screen reader and keyboard access
- Buttons: minimum touch target 44px for theme toggle
- Focus-within triggers same hover state visibility as :hover (edit/delete buttons)

### Chronometer Ring (Transcription Timer)

The ChronoRing component renders during the transcribing state as an SVG circular progress ring with Tomb Amber palette (#d4a028 accent, #f0c040 digits).
Timer displays MM:SS:mm format with centiseconds updating at requestAnimationFrame rate (~60fps).
Three visual phases driven by CSS custom property overrides on .chrono-container: amber (default), red (#e05555, < 60s remaining), zeroed (0:00:00 with pulse animation).
The zeroed banner (.chrono-exterminatus, text «Almost done! Just a second more...», uppercased by CSS; was «Exterminatus Initiated» before AUG-189) appears at zero via .chrono-phase-zeroed class with scaleX animation and glowing text; .chrono-ext-text has max-width 100% so the longer line wraps on narrow screens.
After zero (AUG-189) the ring stays visibly busy while the server post-processes: .chrono-processing is added to .chrono-container when the ring is zeroed and status is transcribing; the 60 ticks (each line carries a --i custom property) run the chrono-sweep keyframes (2.4 s linear infinite, delay i × 40 ms) in the zeroed red palette, and the stage lives inside the ring: the center has two stacked .chrono-center-layer layers; remaining / 00:00:00 / 100% holds for 2 s after zero (showStage timer in ChronoRing), then fades out (0.6 s opacity) while .chrono-center-stage fades in with the label «status», the stage text (.chrono-stage-text, uppercase), three 4×4 px square .chrono-blinkers (0 radius) and 100%. Nothing is shown under the ring after zero (the «Завершение в HH:MM» bar is removed). Mockup docs/mockups/AUG-177/processing-spinner.html, Variant B; user review on 2026-11-04 rejected the first build's stage bar under the ring (AUG-177 D3) in favour of the in-ring stage after a 2 s digit hold, and replaced the Exterminatus text.
A set session.processingStage forces the zeroed state (full ring, 100%, red palette, banner) even when the client ETA has not run out, because whisper is already done and the ETA is only a guess (AUG-189).
Stage label rule (AUG-189): STAGE_LABELS in client/src/components/TranscriptView.tsx maps cleaning → cleaning up, checking → checking the text, correcting → suggesting fixes, saving → saving; a missing or unknown stage reads finishing. User words only — no method names, timings, model names or percentages beyond the existing 100%. The shimmer fallback (no estimatedDuration) shows «Still working — <stage>» as its status text when a stage is set.
Ring progress is computed client-side from session.estimatedDuration, session.transcriptionStartedAt, and the current time.
Falls back to the original shimmer progress bar when estimatedDuration is not available.
JetBrains Mono (Google Fonts) is used for timer digits with tabular-nums for stable width.
All chrono animations, including the AUG-189 tick sweep, the blinkers and the digit-to-stage fade, are disabled under prefers-reduced-motion: reduce (blinkers turn static at full opacity, the swap after 2 s is instant); the stage text and the Elapsed counter keep updating.

### Interactive Component Patterns

Export dropdown (TranscriptView): a position:relative wrapper (.export-dropdown) with an absolutely positioned menu (.export-menu).
Dropdown menu items (.export-menu-item) use accent-light on hover and 0 border-radius (matching global angular rule).
Menu appears with a 0.12s ease-out slide-down animation (exportMenuIn keyframes).
Dropdown closes on click-outside via a mousedown document listener registered only while open.
File downloads use Blob + URL.createObjectURL + programmatic anchor click for .txt and .srt export.
SRT generation derives end timestamps from the next segment's start; the last segment uses start + 5s.

### Circuit-Node Layout System

The circuit layout uses absolute positioning with percentage-based coordinates inside a relative container.
SVG connection lines use viewBox-based scaling with stroke-dasharray animation for energy-flow effect.
Corner nodes (Language, Mic, System Audio, Theme) are 64px circles at 18%/82% positions.
The center Record node is a 100px circle at 50%/50% with an inner ring and glyph.
Native select/checkbox elements are overlaid on circular nodes with opacity:0 for accessibility.
Recording state: center border turns #e05555, SVG pulse rings animate via circuit-pulse keyframe, corner nodes dim to opacity 0.3.
Radial audio bars: 12 bars positioned with CSS transform rotate(N*30deg), driven by AnalyserNode frequencyBinCount bucketed into 12 averages.
Transcript circuit header: info node (44px) at top-center, action nodes (40px) at 25%/50%/75% bottom, connected by SVG lines.
SessionList New Session action is the August logo button placed left of the "August" title in .session-header-left (AUG-122).
The hexagonal .new-session-node was removed; the logo is the only New Session trigger in the UI, so never make it decorative.
Recording mode picker (RecordingModePicker.tsx) renders as ring segments expanding from the center Record button: two SVG arc paths (left arc = DEFAULT, right arc = LIVE) form a split ring (R=72, stroke 18px) around the button perimeter with hover glow and scale-expand animation. When LIVE is selected, the mode ring stays visible (DEFAULT dimmed, LIVE highlighted/active, both non-interactive) and two engine sub-arcs appear on an outer ring (R=108, stroke 14px) on the right side only: top-right quarter = LOCAL (green/accent), bottom-right quarter = GROQ (red #e04040). Labels positioned outside each arc. Backdrop click or Escape key closes it.
Long-press quick-record: holding the center Record button for ≥500ms bypasses the RecordingModePicker and starts recording immediately using saved preferences (recordingMode and liveEngine from UserPreferences).
Long-press visual feedback: an SVG progress ring (.long-press-ring) animates stroke-dashoffset from 289→0 over 500ms around the button perimeter; the button scales down to 0.96 during the press.
Long-press detection uses pointer events (onPointerDown/Up/Leave/Cancel) with a 500ms setTimeout; a longPressFiredRef flag prevents the subsequent onClick from also firing the mode picker.
Upload dropzone (.circuit-dropzone) uses W40K CRT terminal styling: 2px border-radius, 2px solid border, large (32px) L-bracket corner accents (3px thick, 0.7 opacity) via ::before/::after, repeating-linear-gradient scan-line overlay on dark background, inset shadow for depth, uppercase industrial typography with wide letter-spacing.
All circuit animations (stroke-dashoffset, pulse rings, bar transitions, mode-picker pop) are disabled under prefers-reduced-motion.

### Sidebar V3 Bracketed Design

The sidebar uses the V3 Bracketed pattern — each session item has a bracket-row above the title providing vertical symmetry.
Bracket-row structure: left bracket — connecting line — central node — connecting line — right bracket.
Brackets are angular [ ] shapes built from ::before/::after pseudo-elements and a .session-bracket-bb child span.
The central node (.session-bnode) is a 10px circle with a 3px inner dot, growing to 12px with glow on active.
Active node emits animated pulse rings (.session-bracket-pulse) via @keyframes node-pulse (scale 1→2.2, opacity 0.4→0).
Session titles and metadata are centered (text-align: center, justify-content: center).
Hex grid SVG background (.session-list-hex-bg) covers the sidebar at opacity 0.025 using a repeating hex pattern.
Filter chips use orbital-circle design: circular (border-radius: 50%) with varied sizes per nth-child and slight Y-axis offsets creating a "planet parade" effect. Abbreviated labels (UPL, TRC, DONE, ERR) with full labels in title attributes. Active chips glow with status-colored box-shadow. Dashed animated SVG rays (chip-ray class) connect adjacent chips, styled like circuit-line with dasharray animation.
Hex dot dividers (.session-hex-divider) use tiny hex-shaped dots between the filter chips and session items.
Search input uses angular styling (border-radius: 2px) with a 3px left accent bar, dark background, and inset glow on focus.
Session list scrollbar is custom-styled: thin (5px), no border-radius, necron-green thumb on transparent track.
Edit/delete buttons are positioned absolutely (top-right corner) and appear on hover with z-index: 3.
Session items use flex-direction: column layout instead of the previous horizontal row.
Bracket colors use hardcoded rgba(0, 200, 118, ...) since the sidebar background is always dark regardless of theme.
Pulse animations are disabled under prefers-reduced-motion: reduce.
Responsive: at 720px, center node shrinks to 84px, corner nodes to 56px.
- Sidebar footer GPU/CPU indicator (.sidebar-footer-indicator) shows the current transcription engine as a slim strip at the bottom of the session list with an icon, label (GPU/CPU), and sublabel (Idle/Transcribing.../GPU not available).
- GPU indicator uses --gpu-color (green) with --gpu-bg background; CPU fallback uses --cpu-fallback-color (yellow) with --cpu-fallback-bg — never red.
- The indicator reads gpuBackend from /api/health (vulkan/metal/cuda → GPU green, cpu → CPU fallback yellow, unknown → hidden).
- Running state for the GPU/CPU indicator is derived from sessions.some(s => s.status === 'transcribing'), not from a separate API field.

### Font Standards

Three font stacks are defined as CSS custom properties in :root of App.css.
Gothic display font: var(--font-gothic) — 'UnifrakturMaguntia', cursive — loaded from Google Fonts in index.html, reserved for future decorative use (too stylized for headings).
Terminal/diagnostic font: var(--font-terminal) — 'Cascadia Code', 'Fira Code', 'Consolas', monospace — used wherever a CRT/terminal aesthetic is needed.
Default UI font: the system font stack inherited from the browser (used for titles, labels, body text, general UI).
Terminal font applies to: diagnostics page text (.diag-subtitle, .diag-section-desc, .diag-info-line, .diag-hint-popup, .diag-node-status, .diag-skip-warning), session context menu items (.sidebar-menu-item), and code blocks.
JetBrains Mono (Google Fonts) is used exclusively for Chronometer Ring timer digits.
New terminal-styled components must use var(--font-terminal), not hardcode the font-family stack.
Gothic font (--font-gothic) is available but not currently applied — too stylized for heading readability.

### Controls Panel Menu (AUG-160)

ControlsPanel (client/src/components/ControlsPanel.tsx) is the single app menu; the sidebar hamburger (.sidebar-menu, .sidebar-menu-trigger) was removed in AUG-160 to end the duplicate menu.
Items in order: New session, Settings, Archive, API Keys, Diagnostics, then the desktop-only update item (glyph ↻).
The update item renders only when window.august.getUpdateState resolves non-null; the browser build and unpackaged desktop runs never show it.
Update labels: "Check for Updates" (idle/error) → "Checking for Updates…" and "Downloading Update v{version} ({percent}%)…" (disabled) → "Restart to Update to v{version}".
Busy states use .controls-item:disabled: secondary text color, default cursor, no accent border on hover.
The former hamburger-only "tooltip_missing" external link was dropped.

### Archive Page (AUG-150)

The Archive page is opened from the ControlsPanel item "Archive"; component client/src/components/ArchivePage.tsx, all classes prefixed archive-.
The page title uses the accent gradient linear-gradient(135deg, #00c876, #2dd690) with background-clip text.
Session row grid: 20px 18px minmax(0,1fr) 92px 56px 76px with gap 10px.
Source labels: MIC (accent), FILE (text-primary), YT/VIDEO (status-failed red), LINK (status-uploading yellow).
Active rows (uploading, preparing, transcribing) render at opacity .4 with a Transcribing/Uploading badge and are not selectable.
Deleted audio files are struck through with a red "deleted" label; WAVs removed by the confidence rule get an accent "auto-deleted" label (.archive-file-auto-tag) and the row shows "WAV auto-deleted" next to the title (AUG-152).
Per-file Delete is offered only on audio files.
The sticky bulk bar has "Delete Audio Only" (accent-outline) and "Delete Sessions" (danger-outline).
Confirm dialogs are in-app, never native confirm: fixed backdrop rgba(0,0,0,.45) with blur(8px), card max-width min(420px,100%), closed by Escape or backdrop click.
Light theme uses tokens; dark overrides use necron values under :root[data-theme='dark'].
All Archive elements use border-radius 0, including badges.
TranscriptView shows the ".transcript-audio-deleted" line "Audio deleted — transcript only." with a Re-download link; when only the WAV was auto-deleted it shows "WAV removed after transcription (N%). Re-transcribing rebuilds it from the original file." in the same style and Redo stays enabled (AUG-152).

### Session Context Menu

Right-clicking a .session-item opens a context menu at the cursor (desktop shell only; the browser build keeps the native menu).
The context menu reuses .sidebar-menu-dropdown and .sidebar-menu-item with the .session-context-menu modifier (position: fixed, left/top inline, clamped to the viewport). It is rendered through createPortal into document.body: the sidebar sits in .overlay-panel, whose transform makes it the containing block for fixed children and whose overflow: hidden clipped the menu under the main area. Any fixed popup opened from inside an overlay panel needs the same portal. Only the --1 stagger delay remains; the --2..--6 delays left with the hamburger (AUG-160).
The single item label is "Show in Finder" on macOS, "Show in Explorer" on Windows, "Show in File Manager" elsewhere.
The context menu closes on mousedown outside, Escape, scroll, resize, window blur, and after the action.
Only one context menu exists at a time.
Right-click is ignored on the session currently being renamed.

### Diagnostics Page (SetupGuide)

The diagnostics page (.diag-page) renders when components are missing or when triggered from ControlsPanel.
It uses a W40K CRT terminal aesthetic: angular corners (0 border-radius), monospace terminal font, necron palette.
A 45°-rotated Necron symbol SVG logo (.diag-logo) is centered at the top.
Component status is a Service | Status table (.diag-table, AUG-162; the earlier circle-node circuit was removed): rows Whisper Engine, GGML Model, FFmpeg (both platforms) and Language Model (optional tag), each with a HintPopup.
Status tones: ok green (Operational / Downloaded, sleeping / Loaded in memory), warn yellow (installed but off), progress pulsing yellow (downloading, moving, waking), danger red (not installed / not downloaded / folder not available); each row gets a 3 px tone-coloured inset edge, red and yellow rows a faint tinted background; the marker is an 8 px square, never a circle.
.diag-hint-popup resets white-space, text-transform, letter-spacing and font-weight because it sits inside nowrap uppercase table header cells.
The Language Model section shows progress / Retry / Test while on; while off it shows a one-line description and a "Turn on…" button that opens Settings on the Transcription tab (SettingsModal initialTab), where enabling still requires the download confirmation.
The page polls GET /api/llm/status every 3 s and refetches when Settings closes, so changes made in Settings show without a Refresh button.
Short windows (max-height 860px / 720px) tighten .circuit-layout gaps and shrink .circuit-diagram to 400 / 320 px so the link row on New Transcription stays above the fixed pin bar.
Adaptive reveal logic: GPU button when whisper missing, direct download when only model missing, staggered fade-in via diag-reveal--1/2/3 classes.
Proceed button uses W40K CRT styling: metallic frame, arrow pseudo-elements, scan-line overlay, necron palette gradient.
Refresh and Skip buttons share a horizontal row (.diag-actions) with equal flex:1 width. Skip turns red on hover.
The ?diagnostics query param forces the diagnostics view; ?mock=whisper,model,ffmpeg simulates missing components.
ffmpeg is mandatory — allReady requires whisperReady && modelReady && ffmpegReady, and needsSetup in App.tsx includes !healthStatus.ffmpegAvailable.
When ffmpeg is missing but whisper+model are ready, an "Install FFmpeg" section appears on both platforms: `npm run setup` (downloads the bundled ffmpeg) with a copy button, then a one-line manual fallback (`winget install ffmpeg` / `brew install ffmpeg`).
Clickable whisper/models/ path opens the native file manager via POST /api/setup/open-model-folder.
- On Windows with nvidiaGpu.detected and gpuEngine='cpu' (or gpuEngine='cuda' with cudaStatus 'missing'), the Diagnostics page shows a "Switch to GPU (NVIDIA)" / "Install GPU engine (NVIDIA)" button below the CPU notice.
- The GPU switch button calls POST /api/engine/switch and streams CUDA download progress (~457 MB) inline via SSE, reusing the diag-progress styles.
- Diagnostics shows green "GPU (NVIDIA) — active" only when gpuBackend is 'cuda'; 'unknown' shows "GPU (NVIDIA) — starting…", and engine cuda with gpuBackend 'cpu' shows "GPU (NVIDIA) could not be used — transcription runs on CPU" (AUG-140).
- The CUDA download progress bar in Diagnostics is driven by health.cudaStatus === 'downloading' (SSE subscription in an effect), not only by the switch button click.
- When gpuEnginePinned is true (WHISPER_GPU_ENGINE env set), the switch button is hidden and replaced with "Engine is set by system configuration."
- macOS and Windows without NVIDIA: Diagnostics GPU switch section is not rendered.

### Praxis Modal

PraxisModal (.praxis-backdrop + .praxis-modal) opens from the "Send to Praxis" export menu item in TranscriptView, and from the Action items export buttons in TranscriptView and the live panel (AUG-166).
PraxisModal action-items mode (AUG-166): with the actionItems prop it is titled 'Action items → Praxis', hides Task name, shows 'N separate task(s), one per item' or 'One task with an N-item checklist', and the button reads 'Create N tasks' / 'Create task'.
When some selected items were already sent, the modal shows .praxis-warning (amber var(--status-uploading)) 'Already sent: … Sending again creates new tasks.' and the button becomes 'Send again'; that click is the re-send confirmation (AUG-166).
With 1 to 5 registered projects the Project field is a row of chips (.praxis-chips, .praxis-chip, .praxis-chip--on): name plus "default" or the folder name, then the Recent group (AUG-192), then an "Other…" chip.
With 0 or more than 5 registered projects the Project field falls back to the SettingsDropdown, which ends with an "Other…" entry; the Recent group renders as a chip row under the dropdown, so every recent entry is reachable and removable in both modes.
The Project path input is always visible; choosing a chip fills it, and typing into it or using Open switches the selection to Other.
The Open button launches the OS native folder picker; the path input uses --font-terminal.
Windows picker (AUG-192): the PowerShell script sets [Console]::OutputEncoding to UTF-8 first; without it PowerShell 5.1 writes stdout in the OEM code page and a Cyrillic folder name came back as mojibake. Paths are stored and sent exactly as picked (never the 8.3 short form).
Recent group (AUG-192, option C of @docs/mockups/AUG-171/send-to-praxis.html): a "Recent" divider (.praxis-chips-divider) and one dashed chip (.praxis-chip--recent in .praxis-chip-wrap) per entry of the praxisRecentPaths preference: name = folder basename, sub = shortened path, title = full path. Each chip has × (.praxis-chip-x, removes it from recents) and Save (.praxis-chip-save, appends an ordinary project named after the folder, default only when no project exists, and removes it from recents). Picking a recent chip selects Other with that path; the Other… chip is lit only when no recent matches.
After a successful export (transcript card or action items) to a path that is not a registered project, the modal moves it to the front of praxisRecentPaths (max 5, the oldest drops off); failed validation or a failed send never adds it. See: preferences
Initial selection: the newest recent path if it matches a registered project, else Other with that path, else the default project, else the first project, else Other.
Why not localStorage (AUG-171): the packaged app starts the server on port 0, so the page origin http://127.0.0.1:<port> and its localStorage change on every launch; the old key august-praxis-project-path was always empty after a restart. Anything that must persist goes into server preferences (same reason as compactHintSeen).
Wiring: PraxisModal takes recentPaths and onPreferenceChange; App passes them through TranscriptView (praxisRecentPaths, onPraxisPreferenceChange) and FileUpload passes its own preferences and onPreferenceChange.
A note under the path shows which prompt will be used: "Prompt: <name> · custom", or "Prompt: default · built-in" or "default · custom"; with a recent chip selected it reads "Recent · last 5 sent, oldest drops off".
The default-prompt note reads the defaultPromptCustom prop, passed from App through TranscriptView as praxisDefaultPromptCustom.
Enter on a chip or inside the open dropdown does not send the task; the dropdown toggles instead.
The modal reuses the same backdrop pattern as ModelDownloadModal: fixed overlay with blur, modePickerFadeIn animation.
The task-name field shows the note "Also becomes the session name".
After a successful export, if the task name differs from the session title, the modal calls onRenameSession, which updates the sessions state optimistically and then PATCHes the session title.
The sidebar and TranscriptView title update without a reload; a failed rename shows "Task created, but the session could not be renamed." on the success screen.
Success state shows a checkmark icon with the created task ID (comma-separated IDs for several action-item cards) in a code-style badge (.praxis-task-id).
The "Send to Praxis" export menu item is accent-colored (.export-menu-item--praxis) to distinguish it from download actions.

### Settings Tabs and Projects Tab (master-detail)

The Settings modal tab strip uses .settings-tabs with .settings-tab buttons; the active tab gets .settings-tab--active with an accent bottom border.
Tab labels use var(--font-terminal) and 0 border-radius.
The Settings modal width is min(680px, 100%) for every tab (AUG-198: six tabs — General, Audio, Transcription, Projects, AI assistants, Compact mode — need ≈ 680 px with the unchanged tab CSS; the user chose the wider card over tighter tabs or a shorter label), wider than the 440-460px standard modal.
The Projects tab (PraxisProjectsPage.tsx) is master-detail: a 210px listbox on the left and an editor on the right, each scrolling independently.
The Settings card gets settings-card--projects (height 85vh) and settings-body--projects (no padding, no outer scroll) on the Projects tab.
The list pins "Default settings" first, then one item per project with name, path and Default / prompt / "!" badges; "+ Add project" sits under the list.
Items, buttons and inputs on the Projects tab keep 0 border-radius and CSS variables only.
Default, prompt and missing badges follow the brutalist rules and the color priority schema.
The editor header shows a "Saved" label (.praxis-saved) for 1.5 s after each autosave on blur; it has no transition under prefers-reduced-motion.
Variable chips (.praxis-vars, .praxis-var-chip) use a dashed accent border and insert {sessionName}, {date} or {duration} at the textarea cursor.
Variable chips use onMouseDown preventDefault so the textarea keeps focus; both the Default settings and the per-project prompt textareas sit in .praxis-md-field--grow and fill the remaining editor height (min 120px, long text scrolls inside; AUG-191).
Expand prompt editor (AUG-191, decision B + C of AUG-172, mockup docs/mockups/AUG-172/default-prompt.html): an outline ⤢ Expand button at the right end of the chips row in both prompt editors, or Ctrl+Shift+E (Windows) / Cmd+Shift+E (macOS, IS_MAC from navigator.platform; e.code 'KeyE' so it works on any keyboard layout) in the prompt textarea, opens a full-window editor portaled to document.body (.praxis-expand-backdrop, z-index 300 above the Settings backdrop at 50; card = window minus 48px). The overlay edits the same draft state (defaultDraft or promptDraft), has its own textarea ref so chips insert at its caret, and commits only on close through commitDefault / commitPrompt. Esc, Done or a backdrop click close only the overlay: a capture-phase window keydown listener stops Escape before SettingsModal's window listener, the backdrop closes on click (not mousedown) so the click cannot fall through to the Settings backdrop, and focus returns to the Expand button. A drag handle was rejected because the Projects tab is capped at 85vh; no height preference is persisted.
Prompt editor styling uses the .praxis-md* classes; the "custom · use default" link uses .praxis-link.
Inline editor actions use .praxis-btn-inline; the primary one (Add project) uses .praxis-btn-inline--primary.
ArrowUp/ArrowDown on the focused list move the selection; Escape in an editor input returns focus to the list without closing the modal.
At widths of 560px and below the list stacks above the editor.
The former .praxis-project-card, .praxis-project-add and .praxis-hint rules are removed; .praxis-project-badge* and .praxis-project-path remain.
The Transcription tab's auto-delete threshold (AUG-152) is a native range input styled by .settings-slider: 160px wide, 2px track in var(--border-color), 12×16px square accent thumb with 0 radius, focus-visible 1px accent outline, and a .settings-slider-value label in the terminal font; it appears only while the "Delete audio.wav after transcription" toggle is on.
- Settings → Transcription Online text (Groq) (AUG-190, Option A of @docs/mockups/AUG-173/transcription-settings.html): master toggle with hint 'Sends transcript text to Groq's free tier. Choose what it does:', then an indented .settings-child block (2 px accent border-left, 14 px left padding, 0 radius) with 'Fix live lines' and 'Collect live action items' checkboxes and their hints; while the master is off the block gets .settings-child--off (opacity 0.45, not-allowed cursor) and the inputs are disabled; master on with both children off shows the warn hint 'Live features off. Only fixes after recording use Groq.'

### AI assistants tab (AUG-198)

- Tab `assistants` between Projects and Compact mode; the design and every text are final in @docs/mockups/AUG-194/ai-assistants-tab.html — the app reproduces it, do not reword. Behaviour and preferences: See: ai-assistants.
- Status rows use `.settings-status` (terminal font, right-aligned, muted) / `.settings-status--warn` (yellow #d4a028); commands in hints use `.settings-code`; the single RECHECK button (`.settings-btn-inline` inside `.settings-recheck`) appears only when Claude Code is unusable or PraxisOS is down, and shows 'Checking…' disabled while probing.
- Copilot modes are a radio list: `.settings-choice-list` > `.settings-choice` (1 px border; `--selected` = accent border + --accent-light background with a filled 14 px square mark; `--disabled` = opacity .45, not selectable), name + `.settings-tag` (`--accent` RECOMMENDED, `--danger` red EXPENSIVE), description and a 260 px price column that stacks below 560 px. role=radiogroup / radio, Enter and Space select.
- Money field (both spending limits): `.settings-money` = `$` + `.settings-input` 96 px right-aligned number input without spinners, placeholder '0 = no limit'; committed on blur / Enter; empty, negative or non-numeric input reverts to the saved value; 0 switches the hint to 'No limit: usage is capped only by your Claude plan.'
- Model and Transcript window use SettingsDropdown with `settings-dropdown--fit` (min-width 230px); SettingsDropdown has a `disabled` prop (trigger disabled, menu never opens) used inside `.settings-child--off`.
- Modals: the Active session consent reuses the GroqTextConsentModal classes (`.groq-setup-*`, lettered list `.groq-setup-steps--lettered`, accent title); the Always-on confirmation is `.settings-confirm-card` (red 1 px border, red title, red checkbox, `.settings-confirm-btn--danger` Turn on enabled only with the checkbox) — red appears only on the EXPENSIVE tag and this modal. Both render through createPortal(document.body); Esc and backdrop cancel; while one is open Settings ignores Esc (onModalChange).

### UI audit reports (AUG-203)

- UI audits live in docs/reviews/<yyyy-mm>-ui-audit.md with screenshots in a sibling folder of the same name; the first is @docs/reviews/2026-11-ui-audit.md (2026-11-09, Windows, build 0.2.0).
- Report contract: Part 1 exec summary ≤ 250 words in business language, Part 2 coverage table (screen → checked / not checked + reason, macOS rows marked "not checked on macOS"), Part 3 first-time walk-through, Part 4 findings table with severity / screen / size / impact / fix / repro / screenshot, Part 5 follow-up task groups for approval.
- Method: the real Electron dev shell on an isolated server with a clean data dir and fixture sessions, each screen at 1280×866, 960×600 and the real compact sizes; shell-side mechanics: See: desktop-shell.
- Audit-time checklist per screen: text clipping without tooltip, overlap, long values (long Cyrillic titles, unbroken 84-char title, long project path, 1500-char transcript line), jargon, missing empty / error states, unclear next action, brandbook (radius other than 0 / 50 % / pill, light-mode white or bright green, red outside destructive use).
- Audit rule: findings are written from the first-time user's view and are not softened; "it works for the team" is not an argument.
- Why the Major findings matter for new UI work: fixed column widths must not exceed the default viewport, every full-page view must reserve the pin-bar height, compact widgets must keep an always-visible way back, and helper empty states must describe real state (never "no recording is running" during a recording).

## Invariants

Every color in the UI must reference a CSS custom property, never a hardcoded hex value (except within :root definitions).
Dark mode must be achieved solely through CSS variable overrides on :root[data-theme='dark'], not by conditional class toggling in components.
ThemeProvider must wrap the entire component tree; it must be the outermost provider in main.tsx.
The theme toggle renders as a circuit node in FileUpload and as a fixed bottom-right button in TranscriptView.
New UI components must use the existing design token variables, not introduce new color values.
Chronometer Ring colors use scoped CSS custom properties (--chrono-*) on .chrono-container, not the global Necron palette — phase transitions swap all chrono tokens at once.
Terminal-styled components must use var(--font-terminal) — do not hardcode the font-family stack or introduce alternative monospace fonts.
Gothic font (--font-gothic) is loaded but reserved — not applied to titles due to readability concerns.
- All buttons must use translateY(-1px) on hover for elevation effect, except disabled buttons which must have transform: none.
- All major UI elements (cards, buttons, inputs, modals, dropdowns, menus) must use border-radius: 0 — angular, 90-degree corners. This is the brutalist design foundation. Only status badges (999px pill) and circuit nodes (50% circle) are exceptions.
- Status badges must use 999px border-radius (pill shape) with ~15% opacity background and full-color text.
- Error/warning containers must use 0 border-radius everywhere.
- Modal backdrops must use rgba(0,0,0,0.45) with backdrop-filter blur(8px) and modePickerFadeIn animation.
- New interactive elements must have a :focus-visible style with at least outline: 2-3px solid var(--accent).
- All animations and transitions must be disabled under @media (prefers-reduced-motion: reduce).
- Scrollbars in sidebar and panels must use the custom thin scrollbar pattern (5px width, necron-green thumb, transparent track).
- Never use pure white backgrounds. Light mode uses muted sage (#c4cec8) and stone (#d0d8d3).
- Dark mode button text on accent backgrounds uses #0a110d (near-black), not #e0e8e3.
- Color utility schema is mandatory: green filled = top priority, yellow filled = high priority, green/yellow outline = normal, plain text = low, red = situational/destructive only. See "Color Utility Schema" section.
- Never use red (#e05555, #dc2626) for normal UI flow — it signals danger or termination exclusively. Recovery/retry buttons must use green accent, not red.
- All error text colors must use var(--status-failed) token — never hardcode #c0392b, #e05555, or #dc2626 directly.
- Page headings (.circuit-title, .diag-title, .app-title, .live-panel-title) must use accent gradient (linear-gradient(135deg, #00c876, #2dd690) with background-clip: text).
- Modal and sub-page headings (.praxis-modal-title, .model-download-title, .transcript-circuit-title) must use color: var(--accent).
- The global `button:hover:not(:disabled)` rule (App.css) applies `animation: btn-target-pulse` to all hovered buttons. Elements with their own animation lifecycle (e.g. `.sidebar-menu-item` stagger fade-in) must be excluded via `:not()` to prevent the shorthand from clobbering `animation-fill-mode: forwards` and resetting opacity. Use animation longhand properties on such elements and add breathing as a second animation-name on :hover to preserve the base animation at index 0.
- A dropdown's z-index only competes inside its nearest stacking context: `backdrop-filter`, `transform`, `opacity < 1` or positioned + z-index create one. `.transcript-circuit-header` creates one via `backdrop-filter`; without a z-index it sat at level 0, so the Export/Redo menus (`z-index: 100`) that open down into `.transcript-body` were covered by `.action-items-panel` and `.corrections-bar` (both z 2) (AUG-170). Since AUG-180 the header has `position: relative; z-index: 3` (App.css, `.transcript-circuit-header`), so its menus paint above the body. Rule: keep every body element of the transcript view below z 3 (raise the header instead of lowering body z-indexes, which AUG-163/165 rely on), and keep all of them below overlays (44–47) and modals (50). Menus are not portalled to document.body — rejected as 40–60 lines of TSX plus outside-click rework.

## Route-Specific Constraints

Do not add Tailwind CSS or other CSS frameworks; the design system uses plain CSS with custom properties.
FileUpload.tsx imports useTheme() to embed the theme toggle as a circuit node; other components should not import theme.tsx unless they need direct theme access.
The sidebar uses its own dark color set (--sidebar-*) independent of the main theme toggle, since it is always dark-toned.
Status badge colors (uploading, transcribing, completed, failed) must remain distinct in both light and dark modes.

## Key Files

- client/src/App.css — All design tokens and component styles
- client/src/theme.tsx — ThemeProvider, ThemeToggle, useTheme hook
- client/src/main.tsx — ThemeProvider mounting point
- client/index.html — Inline SVG favicon with necron dark background and gauss green text
- client/src/components/TranscriptView.tsx — Transcript display, export dropdown with copy/download options, AUG-163 correction diff cards and 'Download corrected .txt'; AUG-165 Action items card; includes the ChronoRing local component for transcription ETA countdown.
- client/src/components/FileUpload.tsx — Circuit-node radial layout for recording and upload controls
- client/src/components/OverlayLayer.tsx — edge triggers, backdrop, left/right overlay panels and the bottom pin bar (AUG-154)
- client/src/components/ControlsPanel.tsx — right overlay list and the only app menu: New session, Settings, Archive, API Keys, Diagnostics, desktop-only update item, with active-item highlight (AUG-154, AUG-160)
- client/src/components/SessionList.tsx — Sidebar with V3 Bracketed session items, hex grid SVG, orbital-circle filter chips, August logo New Session button
- client/src/components/RecordingModePicker.tsx — Radial expanding mode picker (DEFAULT / LIVE inner ring, LOCAL / GROQ outer right-side sub-arcs) rendered inside circuit-diagram with SVG connection lines
- client/src/components/PraxisModal.tsx — Modal with project chips (SettingsDropdown above 5 projects), an always-visible path input with browse, a prompt note, task creation from a session transcript, session rename sync, and the action-items mode with the Send again confirmation (AUG-166).
- client/src/components/SettingsDropdown.tsx — shared angular dropdown with optional per-option sublabel and placeholder, used by SettingsModal and PraxisModal.
- client/src/components/AiAssistantsTab.tsx — Settings → AI assistants tab (AUG-198).
- client/src/components/PraxisProjectsPage.tsx — Settings Projects tab: master-detail layout with a project list, default-prompt and per-project editors, and a New project mode.
- client/src/components/ArchivePage.tsx — Archive page: storage card, session list with per-file breakdown, bulk delete bar, confirm dialogs (AUG-150)
- client/src/components/ConfidenceBadge.tsx — confidence percentage chip with tier colouring (AUG-152)
- client/src/components/ActionItemsPanel.tsx — Action items panel (live column and TranscriptView card), InlineField, displayOwner (AUG-165); selection and Praxis export bar (AUG-166).
- client/src/components/compact/CompactLayer.tsx — compact phase machine (full | compact | done), auto-collapse and expand triggers (AUG-156)
- client/src/components/compact/DockWidgets.tsx — Dock Strip and Dock Square widgets (AUG-156)
- client/src/components/HoldToStopButton.tsx — shared hold-to-stop button (AUG-182).
- client/src/components/compact/GhostApp.tsx — Ghost Caption and Ghost Coin overlay app loaded with ?ghost=caption|coin (AUG-156)
- client/src/components/compact/ghostProtocol.ts — BroadcastChannel 'august-compact' message types between main and ghost windows (AUG-156)
- client/src/services/compact.ts — compact widget resolution rule and auto-Live helper (AUG-156)
- client/src/services/compactStore.ts — useSyncExternalStore snapshot and actions published by FileUpload (AUG-156)
- client/src/components/SetupGuide.tsx — Diagnostics page with the Service | Status table, W40K CRT aesthetic, adaptive GPU/model reveal logic, Language Model section (AUG-162)
