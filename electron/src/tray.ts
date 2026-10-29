import path from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';
import type { UpdateState, UpdaterControls } from './updater.js';

export interface TrayState {
  recording: boolean;
  transcribing: number;
  update: UpdateState;
  compact: boolean;
  recordingSince: number | null;
}

export interface TrayActions {
  showWindow(): void;
  toggleRecording(): void;
  updater: UpdaterControls | null;
  expandCompact(): void;
  quit(): void;
}

type Variant = 'idle' | 'recording' | 'transcribing';

/// System tray icon + menu. The icon color and tooltip mirror recording/transcription state; the window
/// hides here instead of closing, so this is the only always-visible surface of the app.
export class AppTray {
  private readonly tray: Tray;
  private state: TrayState = { recording: false, transcribing: 0, update: { phase: 'idle' }, compact: false, recordingSince: null };

  constructor(private readonly iconDir: string, private readonly actions: TrayActions) {
    this.tray = new Tray(this.iconFor(this.state));
    this.tray.on('click', () => actions.showWindow());
    this.render();
  }

  update(patch: Partial<TrayState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  /// Tooltip only (no menu rebuild) — driven by a 1 s ticker while compact and recording.
  refreshTooltip(): void {
    this.tray.setToolTip(`August — ${this.statusText()}`);
  }

  destroy(): void {
    this.tray.destroy();
  }

  private statusText(): string {
    if (this.state.recording && this.state.compact && this.state.recordingSince !== null) {
      const total = Math.max(0, Math.floor((Date.now() - this.state.recordingSince) / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const sec = total % 60;
      const pad = (n: number) => String(n).padStart(2, '0');
      return `Recording ${h > 0 ? `${h}:${pad(m)}` : pad(m)}:${pad(sec)}`;
    }
    if (this.state.recording) return 'Recording…';
    if (this.state.transcribing > 0) {
      return `Transcribing ${this.state.transcribing} session${this.state.transcribing === 1 ? '' : 's'}`;
    }
    return 'Idle';
  }

  private iconFor(state: TrayState) {
    const variant: Variant = state.recording ? 'recording' : state.transcribing > 0 ? 'transcribing' : 'idle';
    if (process.platform === 'darwin') {
      // Idle is a template glyph so the menu bar recolors it for light/dark; status variants keep their color.
      const file = variant === 'idle' ? 'trayTemplate.png' : `tray-${variant}-mac.png`;
      const image = nativeImage.createFromPath(path.join(this.iconDir, file));
      if (variant === 'idle') image.setTemplateImage(true);
      return image;
    }
    return nativeImage.createFromPath(path.join(this.iconDir, `tray-${variant}.png`));
  }

  /// One menu item mirrors the updater: it is disabled while busy and becomes "Restart to Update" once downloaded.
  private updateItem(updater: UpdaterControls): Electron.MenuItemConstructorOptions {
    const u = this.state.update;
    switch (u.phase) {
      case 'checking':
        return { label: 'Checking for updates…', enabled: false };
      case 'downloading':
        return { label: `Downloading update ${u.version} (${u.percent}%)…`, enabled: false };
      case 'ready':
        return { label: `Restart to Update to ${u.version}`, click: () => updater.installNow() };
      default:
        return { label: 'Check for Updates…', click: () => updater.checkNow() };
    }
  }

  private render(): void {
    this.tray.setImage(this.iconFor(this.state));
    this.tray.setToolTip(`August — ${this.statusText()}`);
    const template: Electron.MenuItemConstructorOptions[] = [
      ...(this.state.compact ? [{ label: 'Expand August', click: () => this.actions.expandCompact() }] : []),
      { label: 'Show August', click: () => this.actions.showWindow() },
      { label: this.state.recording ? 'Stop Recording' : 'Start Recording', click: () => this.actions.toggleRecording() },
      { type: 'separator' },
      { label: `Status: ${this.statusText()}`, enabled: false },
      { type: 'separator' },
    ];
    if (this.actions.updater) template.push(this.updateItem(this.actions.updater));
    template.push({ label: `Quit August ${app.getVersion()}`, click: () => this.actions.quit() });
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
