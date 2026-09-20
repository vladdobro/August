import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  session,
  shell,
} from 'electron';

import { applyRecordHotkey } from './hotkey.js';
import { installFileLogger } from './log.js';
import { startSessionWatcher } from './sessionWatcher.js';
import { DEFAULT_RECORD_HOTKEY, SettingsStore } from './settings.js';
import { AppTray } from './tray.js';
import { setupAutoUpdater } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// electron/dist -> repo root (dev) or the unpacked app dir (packaged; asar is disabled in electron-builder.yml).
const appRoot = path.resolve(__dirname, '..', '..');

const APP_USER_MODEL_ID = 'com.august.desktop';
// `electron . --dev` = attach to the running Vite + tsx dev servers instead of embedding the server.
const isDevRenderer = process.argv.includes('--dev');
const rendererDevUrl = process.env.AUGUST_RENDERER_URL ?? 'http://127.0.0.1:5175';
const devApiBase = process.env.AUGUST_API_URL ?? 'http://127.0.0.1:3001';
// CI/dev smoke test: exit 0 with "SMOKE_OK" once the renderer has loaded, without showing a window.
const smokeTest = process.env.AUGUST_SMOKE_TEST === '1';
// Must match WHISPER_MODEL.fileName in server/src/config.ts (auto-download only works for that name).
const WHISPER_MODEL_FILE = 'ggml-large-v3-turbo-q8_0.bin';

// Memory hygiene: whisper inference needs the RAM more than idle Chromium features do.
app.commandLine.appendSwitch(
  'disable-features',
  'SpareRendererForSitePerProcess,MediaRouter,Translate,OptimizationHints,CalculateNativeWinOcclusion',
);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');

// Stable user-data folder in both dev (package name "august") and packaged (productName "August") runs.
app.setPath('userData', path.join(app.getPath('appData'), 'August'));
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

interface RunningServer {
  port: number;
  close(): Promise<void>;
}
interface ServerModule {
  startServer(options: { port: number }): Promise<RunningServer>;
}

let mainWindow: BrowserWindow | null = null;
let tray: AppTray | null = null;
let server: RunningServer | null = null;
let isQuitting = false;
let recording = false;
let hotkeyRegistered = false;
const settings = new SettingsStore(app.getPath('userData'));

function whisperPlatformDir(): string | null {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win-x64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64';
  return null;
}

/// GUI apps on macOS don't inherit the shell PATH, so Homebrew tools (audiotee, the ffmpeg PATH fallback) are invisible without this.
function ensureToolPaths(): void {
  if (process.platform !== 'darwin') return;
  const current = (process.env.PATH ?? '').split(':').filter(Boolean);
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'].filter((p) => !current.includes(p));
  process.env.PATH = [...current, ...extra].join(':');
}

/// Environment for the embedded server. Packaged builds keep every writable file under userData (the
/// install dir is read-only) and take whisper-cli, ffmpeg and ffprobe from resources/; unpackaged runs
/// reuse the repo layout (server/data, whisper/bin, whisper/models) so `npm run electron:start` shares
/// state with `npm run dev`.
function configureServerEnv(): void {
  process.env.NODE_ENV = 'production';
  if (!app.isPackaged) return;

  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  const modelsDir = path.join(userData, 'whisper', 'models');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  process.env.AUGUST_DATA_DIR ??= dataDir;
  process.env.WHISPER_MODEL_PATH ??= path.join(modelsDir, WHISPER_MODEL_FILE);

  const platformDir = whisperPlatformDir();
  if (platformDir && !process.env.WHISPER_BIN_PATH) {
    const binName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
    const bundled = path.join(process.resourcesPath, 'whisper', 'bin', platformDir, binName);
    if (fs.existsSync(bundled)) process.env.WHISPER_BIN_PATH = bundled;
  }

  // ffmpeg + ffprobe ship next to whisper-cli (AUG-115). FFMPEG_PATH is the server's highest-precedence
  // override; the server also finds the bundled copy on its own via WHISPER_BIN_PATH, this just makes it explicit.
  if (platformDir && !process.env.FFMPEG_PATH) {
    const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const bundledFfmpeg = path.join(process.resourcesPath, 'whisper', 'bin', platformDir, ffmpegName);
    if (fs.existsSync(bundledFfmpeg)) process.env.FFMPEG_PATH = bundledFfmpeg;
  }
}

async function startEmbeddedServer(): Promise<RunningServer> {
  ensureToolPaths();
  configureServerEnv();
  const entry = path.join(appRoot, 'server', 'dist', 'app.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`Server build not found at ${entry}. Run "npm run build" first.`);
  }
  const mod = (await import(pathToFileURL(entry).href)) as ServerModule;
  return mod.startServer({ port: Number(process.env.AUGUST_PORT) || 0 });
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}. Is "npm run dev" running?`);
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  if (onClick) n.on('click', onClick);
  n.show();
}

/// Hotkey/tray toggle: forwarded to the renderer, which owns MediaRecorder. The window stays where it is
/// (hidden or shown) so a hotkey press during a call never steals focus.
function requestToggleRecording(): void {
  mainWindow?.webContents.send('august:toggle-recording');
}

function openSession(sessionId: string): void {
  showWindow();
  mainWindow?.webContents.send('august:open-session', sessionId);
}

function createWindow(appUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'August',
    backgroundColor: '#0a110d',
    autoHideMenuBar: process.platform !== 'darwin',
    icon: process.platform === 'darwin' ? undefined : path.join(appRoot, 'electron', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A window hidden to the tray must keep MediaRecorder / timers running at full rate.
      backgroundThrottling: false,
      spellcheck: false,
      webgl: false,
      plugins: false,
      enableWebSQL: false,
      devTools: isDevRenderer || !app.isPackaged,
    },
  });

  win.once('ready-to-show', () => {
    if (!smokeTest) win.show();
  });
  // Close = hide to tray. Quit is explicit (tray menu, Cmd+Q, app.quit()).
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  const appOrigin = new URL(appUrl).origin;
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== appOrigin) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, description) => {
    console.error(`Renderer failed to load (${code}): ${description}`);
  });
  win.webContents.on('did-finish-load', () => {
    if (smokeTest) {
      console.log('SMOKE_OK');
      isQuitting = true;
      app.quit();
    }
  });

  void win.loadURL(appUrl);
  return win;
}

function setupSessionHandlers(): void {
  // getDisplayMedia() has no built-in picker in Electron. Windows can deliver system audio as a loopback
  // track; macOS gets the native picker on 15+ (falls back to the first screen without audio on older
  // releases — the app's server-side capture is the preferred macOS path anyway).
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (sources.length === 0) {
            callback({} as Electron.Streams);
            return;
          }
          const streams: Electron.Streams = { video: sources[0] };
          if (process.platform === 'win32') streams.audio = 'loopback';
          callback(streams);
        })
        .catch(() => callback({} as Electron.Streams));
    },
    { useSystemPicker: process.platform === 'darwin' },
  );

  const allowed = new Set(['media', 'display-capture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
}

function buildMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]),
    );
    return;
  }
  // Windows/Linux: no menu bar in production; dev keeps Electron's default (reload/devtools) behind Alt.
  if (!isDevRenderer) Menu.setApplicationMenu(null);
}

function registerIpc(): void {
  ipcMain.handle('august:get-app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
  }));

  ipcMain.handle('august:get-settings', () => ({
    ...settings.get(),
    defaultRecordHotkey: DEFAULT_RECORD_HOTKEY,
    hotkeyRegistered,
  }));

  ipcMain.handle('august:set-record-hotkey', (_e, accelerator: unknown) => {
    const next = typeof accelerator === 'string' && accelerator.trim() ? accelerator.trim() : null;
    const result = applyRecordHotkey(next, requestToggleRecording);
    if (result.ok) {
      settings.update({ recordHotkey: next });
      hotkeyRegistered = next !== null;
    } else {
      // Keep the previous working shortcut instead of leaving the user with none.
      const previous = settings.get().recordHotkey;
      hotkeyRegistered = applyRecordHotkey(previous, requestToggleRecording).ok && previous !== null;
    }
    return { ok: result.ok, recordHotkey: settings.get().recordHotkey, error: result.error };
  });

  ipcMain.on('august:recording-state', (_e, value: unknown) => {
    const next = value === true;
    if (next === recording) return;
    recording = next;
    tray?.update({ recording });
    if (mainWindow && !mainWindow.isVisible()) {
      notify(
        recording ? 'Recording started' : 'Recording stopped',
        recording ? 'August is recording in the background.' : 'Transcription starts shortly.',
        showWindow,
      );
    }
  });
}

async function main(): Promise<void> {
  if (app.isPackaged) installFileLogger(path.join(app.getPath('userData'), 'logs'));
  console.log(`August ${app.getVersion()} starting (${process.platform}-${process.arch}, packaged=${app.isPackaged})`);

  buildMenu();
  setupSessionHandlers();
  registerIpc();

  let appUrl: string;
  let apiBase: string;
  if (isDevRenderer) {
    console.log(`Dev renderer: waiting for ${rendererDevUrl} (API at ${devApiBase})`);
    await waitForUrl(rendererDevUrl, 60_000);
    appUrl = rendererDevUrl;
    apiBase = devApiBase;
  } else {
    server = await startEmbeddedServer();
    appUrl = `http://127.0.0.1:${server.port}/`;
    apiBase = `http://127.0.0.1:${server.port}`;
  }

  mainWindow = createWindow(appUrl);

  const checkForUpdates = app.isPackaged ? setupAutoUpdater(showWindow) : null;
  tray = new AppTray(path.join(appRoot, 'electron', 'build', 'tray'), {
    showWindow,
    toggleRecording: requestToggleRecording,
    checkForUpdates,
    quit: () => {
      isQuitting = true;
      app.quit();
    },
  });

  const initialHotkey = settings.get().recordHotkey;
  const hotkey = applyRecordHotkey(initialHotkey, requestToggleRecording);
  hotkeyRegistered = hotkey.ok && initialHotkey !== null;
  if (!hotkey.ok) console.warn(`Record hotkey not registered: ${hotkey.error}`);

  const stopWatcher = startSessionWatcher(apiBase, {
    onTranscribingCount: (count) => tray?.update({ transcribing: count }),
    onCompleted: (s) => notify('Transcription complete', s.title, () => openSession(s.id)),
    onFailed: (s) => notify('Transcription failed', s.title, () => openSession(s.id)),
  });

  app.on('will-quit', () => {
    stopWatcher();
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = null;
    void server?.close().catch(() => {});
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => {
    isQuitting = true;
  });
  app.on('activate', () => showWindow());
  // Keep running in the tray when the window is hidden/closed; quitting is always explicit.
  app.on('window-all-closed', () => {});

  app
    .whenReady()
    .then(main)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('August failed to start:', err);
      dialog.showErrorBox('August failed to start', message);
      app.exit(1);
    });
}
