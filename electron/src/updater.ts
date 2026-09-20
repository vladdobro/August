import { Notification } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/// GitHub Releases auto-update (feed comes from `publish` in electron/electron-builder.yml). Downloads
/// silently and installs on quit; the user is told once the download is ready. Returns a "check now" trigger.
export function setupAutoUpdater(onShowWindow: () => void): () => void {
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'August update ready',
      body: `Version ${info.version} installs the next time you quit August.`,
    });
    n.on('click', onShowWindow);
    n.show();
  });
  autoUpdater.on('error', (err) => console.warn('Auto-update error:', err?.message ?? err));

  const check = () => {
    autoUpdater.checkForUpdates().catch((err: unknown) => console.warn('Update check failed:', (err as Error).message));
  };
  check();
  setInterval(check, CHECK_INTERVAL_MS);
  return check;
}
