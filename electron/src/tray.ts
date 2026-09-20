import path from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';

export interface TrayState {
  recording: boolean;
  transcribing: number;
}

export interface TrayActions {
  showWindow(): void;
  toggleRecording(): void;
  checkForUpdates: (() => void) | null;
  quit(): void;
}

type Variant = 'idle' | 'recording' | 'transcribing';

/// System tray icon + menu. The icon color and tooltip mirror recording/transcription state; the window
/// hides here instead of closing, so this is the only always-visible surface of the app.
export class AppTray {
  private readonly tray: Tray;
  private state: TrayState = { recording: false, transcribing: 0 };

  constructor(private readonly iconDir: string, private readonly actions: TrayActions) {
    this.tray = new Tray(this.iconFor(this.state));
    this.tray.on('click', () => actions.showWindow());
    this.render();
  }

  update(patch: Partial<TrayState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  destroy(): void {
    this.tray.destroy();
  }

  private statusText(): string {
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

  private render(): void {
    this.tray.setImage(this.iconFor(this.state));
    this.tray.setToolTip(`August — ${this.statusText()}`);
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: 'Show August', click: () => this.actions.showWindow() },
      { label: this.state.recording ? 'Stop Recording' : 'Start Recording', click: () => this.actions.toggleRecording() },
      { type: 'separator' },
      { label: `Status: ${this.statusText()}`, enabled: false },
      { type: 'separator' },
    ];
    if (this.actions.checkForUpdates) {
      template.push({ label: 'Check for Updates…', click: () => this.actions.checkForUpdates?.() });
    }
    template.push({ label: `Quit August ${app.getVersion()}`, click: () => this.actions.quit() });
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
