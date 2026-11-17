import { spawn, type StdioOptions } from 'node:child_process';

import { app, Notification } from 'electron';
import electronUpdater, { type NsisUpdater } from 'electron-updater';

import { pinnedInstallDir, verbatimInstallerSpawn, windowsCommandLine } from './installLocation.js';

type SpawnLog = (cmd: string, args?: string[], env?: NodeJS.ProcessEnv, stdio?: StdioOptions) => Promise<boolean>;

/// AUG-217: electron-updater (written against 6.8.9) starts the installer through BaseUpdater.spawnLog, and Node
/// quotes `/D=<dir>` when dir has a space. This instance-level override keeps spawnLog's contract (detached,
/// unref, resolve once a pid exists, reject on 'error' so NsisUpdater's EACCES -> elevate.exe fallback still runs)
/// and only switches to a verbatim command line when verbatimInstallerSpawn says so; every other call goes to the original.
function pinVerbatimInstallerStart(installDir: string): void {
  const updater = autoUpdater as unknown as { spawnLog: SpawnLog };
  const original: SpawnLog = updater.spawnLog.bind(autoUpdater);
  updater.spawnLog = (cmd, args = [], env, stdio = 'ignore') => {
    const verbatim = verbatimInstallerSpawn(process.platform, cmd, args, installDir);
    if (!verbatim) return original(cmd, args, env, stdio);
    console.log(`[updater] Executing (verbatim): ${windowsCommandLine(verbatim)}`);
    return new Promise<boolean>((resolve, reject) => {
      try {
        const child = spawn(cmd, verbatim.args, { stdio, env, detached: true, argv0: verbatim.argv0, windowsVerbatimArguments: true });
        child.on('error', reject);
        child.unref();
        if (child.pid !== undefined) resolve(true);
      } catch (error) {
        reject(error);
      }
    });
  };
}

const { autoUpdater } = electronUpdater;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/// What the tray shows for the update item. 'error' is transient: the tray treats it like 'idle'.
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string };

export interface UpdaterControls {
  /// Manual check (tray). Every outcome — up to date, downloading, failed — is reported with a notification.
  checkNow(): void;
  /// Quit, install silently and relaunch. No-op unless an update is downloaded.
  installNow(): void;
}

export interface UpdaterHooks {
  onShowWindow(): void;
  onState(state: UpdateState): void;
}

/// GitHub Releases auto-update (feed comes from `publish` in electron/electron-builder.yml). Checks on
/// start() and every 4 hours, downloads silently and installs on quit (electron-updater passes `--updated /S`
/// to the NSIS installer). Background checks only surface the "ready" notification; a manual check reports
/// every outcome. State changes go to the tray via onState (AUG-141).
export function setupAutoUpdater(hooks: UpdaterHooks): UpdaterControls & { start(): void } {
  // electron-updater logs at info level; route it through console.log so the file logger mirrors it.
  autoUpdater.logger = {
    info: (m: unknown) => console.log('[updater]', m),
    warn: (m: unknown) => console.warn('[updater]', m),
    error: (m: unknown) => console.error('[updater]', m),
    debug: () => {},
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true;
  // AUG-216: update the copy that is running. Without /D= the NSIS installer takes its folder only from the
  // registry and falls back to %LOCALAPPDATA%\Programs\August when an interrupted update lost the key (AUG-207).
  // /D= must be the last installer argument: keep disableWebInstaller true (a web installer appends --package-file).
  if (process.platform === 'win32' && app.isPackaged) {
    const installDir = pinnedInstallDir(process.platform, app.isPackaged, process.execPath);
    if (installDir) {
      (autoUpdater as NsisUpdater).installDirectory = installDir;
      pinVerbatimInstallerStart(installDir);
    } else {
      console.log('[updater] Install folder not pinned (path contains a quote); the installer uses its registry location');
    }
  }

  let state: UpdateState = { phase: 'idle' };
  let manual = false;
  let pendingVersion = '';
  let lastPercent = -1;

  const setState = (next: UpdateState) => {
    state = next;
    hooks.onState(next);
  };
  const notify = (title: string, body: string) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', hooks.onShowWindow);
    n.show();
  };

  autoUpdater.on('checking-for-update', () => {
    lastPercent = -1;
    setState({ phase: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version;
    setState({ phase: 'downloading', version: info.version, percent: 0 });
    if (manual) notify('Update available', `Downloading August ${info.version} in the background. You will be told when it is ready.`);
    manual = false;
  });
  autoUpdater.on('update-not-available', () => {
    setState({ phase: 'idle' });
    if (manual) notify('August is up to date', `You are running the latest version (${app.getVersion()}).`);
    manual = false;
  });
  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.floor(progress.percent);
    if (percent === lastPercent) return;
    lastPercent = percent;
    setState({ phase: 'downloading', version: pendingVersion, percent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setState({ phase: 'ready', version: info.version });
    const uac = process.platform === 'win32' ? ' Windows may ask for permission to install.' : '';
    notify(
      'August update ready',
      `Version ${info.version} is downloaded. Choose "Restart to Update" in the tray menu, or it installs when you quit August.${uac}`,
    );
    manual = false;
  });
  autoUpdater.on('error', (err) => {
    const message = err?.message ?? String(err);
    // A failed re-check must not hide an update that is already downloaded.
    if (state.phase !== 'ready') setState({ phase: 'error', message });
    if (manual) notify('Update check failed', message);
    manual = false;
  });

  const check = (isManual: boolean) => {
    if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'ready') return;
    manual = isManual;
    // Failures are reported through the 'error' event above; the rejection carries the same error.
    autoUpdater.checkForUpdates().catch(() => {});
  };

  return {
    checkNow: () => check(true),
    installNow: () => {
      if (state.phase !== 'ready') return;
      // Silent install + --force-run: the NSIS installer relaunches August when it is done.
      autoUpdater.quitAndInstall(true, true);
    },
    start: () => {
      check(false);
      setInterval(() => check(false), CHECK_INTERVAL_MS);
    },
  };
}
