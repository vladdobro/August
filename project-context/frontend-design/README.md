# Frontend Design System

## TL;DR
- The UI uses a Necron-inspired dark color palette (--necron-*) defined as CSS custom properties in App.css.
- Dark/light theme is managed by ThemeProvider context in client/src/theme.tsx with localStorage persistence.
- Light mode uses muted sage/stone grays (#c4cec8, #d0d8d3) — no white backgrounds or bright greens allowed.
- Dark mode accent is gauss green (#00c876); light mode accent is deep forest green (#0a7b50).
- All theme-dependent colors use CSS variables; dark mode overrides use :root[data-theme='dark'] selectors.
- Sidebar uses V3 Bracketed design with [ bracket — node — bracket ] rows, hex grid background, orbital-circle filter chips with connecting rays, and "planet parade" layout.
- FileUpload uses a circuit-node radial layout with SVG connection lines and positioned circular control nodes.
- TranscriptView header uses a circuit diagram with info node and action nodes (Copy, Export, Retranscribe).
- Export dropdown includes "Send to Praxis" option that opens a modal for entering a target Praxis project path.
- During recording, the center node turns red with SVG pulse rings and 12 radial frequency bars from AnalyserNode data.
- ThemeToggle renders as a circuit node inside FileUpload; it renders as a fixed button only when TranscriptView is active.
- Chronometer Ring (Tomb Amber palette) replaces the shimmer bar during transcription with an animated SVG countdown and phase transitions.
- Diagnostics page uses W40K CRT terminal aesthetic: monospace font stack, 0 border-radius, scan-line overlays, staggered fade-in animations.
- Font stacks are defined as CSS custom properties: --font-gothic (UnifrakturMaguntia, reserved for future decorative use), --font-terminal (Cascadia Code stack), and the system UI font.
- Terminal font (--font-terminal) applies to diagnostics page, sidebar menu items, and code blocks — never use hardcoded font-family for terminal fonts.
- Titles (.app-title, .diag-title) use the system UI font — gothic font was too hard to read for headings.
- Sidebar menu (.sidebar-menu) opens a staggered fade-in dropdown from the header, next to the "August" title.
- Brutalist angular design: 0 border-radius (90-degree corners) on all major elements — cards, buttons, inputs, modals, dropdowns. Only status badges (999px pill) and circuit nodes (50% circle) are rounded.
- Color utility schema: top priority = green filled buttons + light green bold text (#a0e2c0); high = yellow filled buttons + green bold text; normal = unfilled green/yellow buttons (80/20 split); low = white/green text, not bold; situational = red for alerts/close.
- Buttons: primary uses accent bg with #e0e8e3 text and 0 border-radius; ghost uses transparent bg with border; both hover with translateY(-1px).
- Inputs: 0 border-radius, 1px border, focus shows accent border with glow.
- Status badges use 999px pill radius with ~15% opacity background matching their status color.
- Modals use rgba(0,0,0,0.45) backdrop with blur(8px), 0 border-radius card with 28px padding, modePickerFadeIn animation.
- All animations and transitions disabled under prefers-reduced-motion: reduce.
- Responsive: 720px switches to vertical layout, shrinks circuit nodes; 640px makes live panel full-width; 600px shrinks chronometer.

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
| --necron-900 | #0a110d | Dark bg, sidebar menu dropdown bg |
| --necron-850 | #101c17 | Sidebar hover bg, diagnostics hint popup bg |
| --necron-800 | #16261e | Sidebar active bg, progress track bg |
| --necron-700 | #1e3429 | Borders (diagnostics), sidebar menu border |
| --necron-600 | #28453a | Accent hover (light mode), proceed button borders |
| --necron-500 | #2d6b4f | Muted text, status-completed (light), hint triggers |
| --necron-400 | #0a7b50 | Primary accent (light mode), deep forest green |
| --necron-300 | #00c876 | Primary accent (dark mode), gauss green |
| --necron-200 | #2dd690 | Accent hover (dark), status-completed (dark) |
| --necron-100 | #6adaa5 | Filter chip text, diagnostics text |
| --necron-50 | #a0e2c0 | Sidebar text, diagnostics headings |

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
- Text: light green (var(--necron-50) #a0e2c0), bold (font-weight 700-800) — like the diagnostics page title
- Use for: main action buttons, primary navigation, key status indicators

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

Monospace (--font-terminal) is mandatory for: code blocks, diagnostics page, search inputs, dropzone text, praxis path input, sidebar menu items.
JetBrains Mono is used exclusively for chronometer timer digits (loaded from Google Fonts).
System UI font for all other text (titles, buttons, body).
Do NOT use --font-gothic (UnifrakturMaguntia) — it is loaded but reserved due to readability concerns.

### Spacing & Layout Rules

Container max-widths:
- Upload panel: 680px
- Circuit diagram: 480px (also circuit-dropzone)
- Diagnostics page: 600px
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

Hexagonal node button (.new-session-node):
- clip-path: polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)
- 40px square, accent bg
- hover: scale(1.1), increased glow shadow

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

Recording indicator:
- Red dot: 10px circle, var(--status-failed) bg, pulse animation
- Timer: tabular-nums, 14px, weight 700, red color
- Audio level bar: 80px wide, 6px tall, red fill

Error/warning boxes:
- Error: background rgba(212,64,64,0.1), color var(--status-failed) or #e05555, border 1px solid rgba(212,64,64,0.2-0.25), border-radius var(--btn-radius) (main) or 0 (diagnostics)
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

### Responsive Breakpoints

720px breakpoint (tablet/mobile):
- App layout switches from horizontal flex to vertical column
- Sidebar: width 100%, max-height 40vh
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
- New session node: outline 3px solid var(--accent), outline-offset 3px
- Mode/language ring arcs: no outline but opacity 1 and increased stroke-width

Interactive accessibility:
- Native select/checkbox elements overlaid with opacity:0 on circuit nodes for screen reader and keyboard access
- Buttons: minimum touch target 44px for theme toggle
- Focus-within triggers same hover state visibility as :hover (edit/delete buttons)

### Chronometer Ring (Transcription Timer)

The ChronoRing component renders during the transcribing state as an SVG circular progress ring with Tomb Amber palette (#d4a028 accent, #f0c040 digits).
Timer displays MM:SS:mm format with centiseconds updating at requestAnimationFrame rate (~60fps).
Three visual phases driven by CSS custom property overrides on .chrono-container: amber (default), red (#e05555, < 60s remaining), zeroed (0:00:00 with pulse animation).
The "Exterminatus Initiated" banner appears at zero via .chrono-phase-zeroed class with scaleX animation and glowing text.
Ring progress is computed client-side from session.estimatedDuration, session.transcriptionStartedAt, and the current time.
Falls back to the original shimmer progress bar when estimatedDuration is not available.
JetBrains Mono (Google Fonts) is used for timer digits with tabular-nums for stable width.
All chrono animations are disabled under prefers-reduced-motion: reduce.

### Interactive Component Patterns

Export dropdown (TranscriptView): a position:relative wrapper (.export-dropdown) with an absolutely positioned menu (.export-menu).
Dropdown menu items (.export-menu-item) use accent-light on hover and 8px inner border-radius.
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
SessionList New Session button is a 40px hexagonal node (clip-path polygon) with accent background and glow shadow.
Recording mode picker (RecordingModePicker.tsx) renders as ring segments expanding from the center Record button: two SVG arc paths (left arc = DEFAULT, right arc = LIVE) form a split ring around the button perimeter. Arcs use thick stroke (18px) with hover glow and scale-expand animation. Labels positioned outside each arc. Backdrop click or Escape key closes it.
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

### Font Standards

Three font stacks are defined as CSS custom properties in :root of App.css.
Gothic display font: var(--font-gothic) — 'UnifrakturMaguntia', cursive — loaded from Google Fonts in index.html, reserved for future decorative use (too stylized for headings).
Terminal/diagnostic font: var(--font-terminal) — 'Cascadia Code', 'Fira Code', 'Consolas', monospace — used wherever a CRT/terminal aesthetic is needed.
Default UI font: the system font stack inherited from the browser (used for titles, labels, body text, general UI).
Terminal font applies to: diagnostics page text (.diag-subtitle, .diag-section-desc, .diag-info-line, .diag-hint-popup, .diag-node-status, .diag-skip-warning), sidebar menu items (.sidebar-menu-item), and code blocks.
JetBrains Mono (Google Fonts) is used exclusively for Chronometer Ring timer digits.
New terminal-styled components must use var(--font-terminal), not hardcode the font-family stack.
Gothic font (--font-gothic) is available but not currently applied — too stylized for heading readability.

### Sidebar Menu

The sidebar header contains a hamburger menu button (.sidebar-menu-trigger) next to the "August" title.
Clicking the trigger opens a dropdown (.sidebar-menu-dropdown) with angular styling (0 border-radius, necron-900 background, necron-700 border).
Menu items appear with staggered slide-in animation (.sidebar-menu-item--1 at 0.04s, --2 at 0.12s, --3 at 0.20s) via sidebar-menu-fade-in keyframes.
Menu closes on click-outside via a mousedown document listener registered only while open.
Current menu items: Diagnostics (opens diagnostics page), tooltip_missing (external link).
Menu z-index (1000) requires the header z-index (20) to be above the filters section below.

### Diagnostics Page (SetupGuide)

The diagnostics page (.diag-page) renders when components are missing or when triggered from the sidebar menu.
It uses a W40K CRT terminal aesthetic: angular corners (0 border-radius), monospace terminal font, necron palette.
A 45°-rotated Necron symbol SVG logo (.diag-logo) is centered at the top.
Circuit-node layout: three absolutely positioned circles connected by animated dashed SVG lines with percentage-based coordinates.
Node colors are fixed fills: Whisper (yellow, rgba(212,170,60,0.25)), GGML (red, rgba(212,80,80,0.22)), FFmpeg (yellow, rgba(212,170,60,0.25)).
Only checkmark icons use green (#00c876) — circle fills keep their assigned color even when operational.
FFmpeg node renders only on Windows (isMac detection via navigator.userAgent).
Adaptive reveal logic: GPU button when whisper missing, direct download when only model missing, staggered fade-in via diag-reveal--1/2/3 classes.
Proceed button uses W40K CRT styling: metallic frame, arrow pseudo-elements, scan-line overlay, necron palette gradient.
Refresh and Skip buttons share a horizontal row (.diag-actions) with equal flex:1 width. Skip turns red on hover.
The ?diagnostics query param forces the diagnostics view; ?mock=whisper,model,ffmpeg simulates missing components.
ffmpeg is mandatory — allReady requires whisperReady && modelReady && ffmpegReady, and needsSetup in App.tsx includes !healthStatus.ffmpegAvailable.
When ffmpeg is missing but whisper+model are ready, a "Install FFmpeg" section with `winget install ffmpeg` and a copy button appears (Windows only; macOS covers ffmpeg via `brew install whisper-cpp ffmpeg`).
Clickable whisper/models/ path opens the native file manager via POST /api/setup/open-model-folder.

### Praxis Modal

PraxisModal (.praxis-backdrop + .praxis-modal) opens from the "Send to Praxis" export menu item in TranscriptView.
The modal reuses the same backdrop pattern as ModelDownloadModal: fixed overlay with blur, modePickerFadeIn animation.
Project path input uses --font-terminal and persists the last-used path in localStorage under "august-praxis-project-path".
Success state shows a checkmark icon with the created task ID in a code-style badge (.praxis-task-id).
The "Send to Praxis" export menu item is accent-colored (.export-menu-item--praxis) to distinguish it from download actions.

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
- Never use red (#e05555, #dc2626) for normal UI flow — it signals danger or termination exclusively.

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
- client/src/components/TranscriptView.tsx — Transcript display, export dropdown with copy/download options; includes the ChronoRing local component for transcription ETA countdown.
- client/src/components/FileUpload.tsx — Circuit-node radial layout for recording and upload controls
- client/src/components/SessionList.tsx — Sidebar with V3 Bracketed session items, hex grid SVG, orbital-circle filter chips, hexagonal New Session node
- client/src/components/RecordingModePicker.tsx — Radial expanding mode picker (DEFAULT / LIVE) rendered inside circuit-diagram with SVG connection lines
- client/src/components/PraxisModal.tsx — Modal for entering a target Praxis project path and creating a task from a session transcript.
- client/src/components/SetupGuide.tsx — Diagnostics page with circuit-node layout, W40K CRT aesthetic, adaptive GPU/model reveal logic
