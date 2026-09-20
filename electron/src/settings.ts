import fs from 'node:fs';
import path from 'node:path';

export interface DesktopSettings {
  // Electron accelerator string, or null when the global record hotkey is disabled.
  recordHotkey: string | null;
}

// Ctrl/Cmd+Alt+R: free of the browser-reload chord (Ctrl+Shift+R) so it never fights other apps.
export const DEFAULT_RECORD_HOTKEY = 'CommandOrControl+Alt+R';

const DEFAULTS: DesktopSettings = { recordHotkey: DEFAULT_RECORD_HOTKEY };

/// Shell-only settings persisted as <userData>/desktop-settings.json. Kept apart from the server's
/// user-preferences.json because the main process needs them before the server is up.
export class SettingsStore {
  private readonly file: string;
  private cache: DesktopSettings;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'desktop-settings.json');
    this.cache = this.read();
  }

  get(): DesktopSettings {
    return { ...this.cache };
  }

  update(patch: Partial<DesktopSettings>): DesktopSettings {
    this.cache = { ...this.cache, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    return this.get();
  }

  private read(): DesktopSettings {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<DesktopSettings>;
      return { ...DEFAULTS, ...parsed };
    } catch {
      return { ...DEFAULTS };
    }
  }
}
