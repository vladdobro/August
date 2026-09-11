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
- During recording, the center node turns red with SVG pulse rings and 12 radial frequency bars from AnalyserNode data.
- ThemeToggle renders as a circuit node inside FileUpload; it renders as a fixed button only when TranscriptView is active.
- Chronometer Ring (Tomb Amber palette) replaces the shimmer bar during transcription with an animated SVG countdown and phase transitions.

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
Token categories: palette (--necron-*), semantic (--accent, --text-primary), component (--card-bg, --sidebar-bg), layout (--btn-radius, --card-radius), effects (--shell-gradient, --accent-glow).

### Design Patterns from Brandbook

Border radii: 22-24px for cards/shells, 12px for buttons/inputs, 999px for badges and toggle.
Shadows use necron-green-tinted rgba values for colored glow effects.
Buttons and interactive elements use translateY(-1px) on hover for elevation effect.
Transitions use 180ms ease for background and color changes.
Glass effect uses backdrop-filter: blur() on transcript header and theme toggle.
Reduced motion: all transitions and animations are disabled under prefers-reduced-motion: reduce.

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

## Invariants

Every color in the UI must reference a CSS custom property, never a hardcoded hex value (except within :root definitions).
Dark mode must be achieved solely through CSS variable overrides on :root[data-theme='dark'], not by conditional class toggling in components.
ThemeProvider must wrap the entire component tree; it must be the outermost provider in main.tsx.
The theme toggle renders as a circuit node in FileUpload and as a fixed bottom-right button in TranscriptView.
New UI components must use the existing design token variables, not introduce new color values.
Chronometer Ring colors use scoped CSS custom properties (--chrono-*) on .chrono-container, not the global Necron palette — phase transitions swap all chrono tokens at once.

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
