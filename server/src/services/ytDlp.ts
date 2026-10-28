import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { trackChildProcess } from './whisper.js';

/// Hosts routed through yt-dlp instead of the direct-download path (AUG-149). Any site with a yt-dlp extractor works — add its host here to enable it. Matched exactly or as a subdomain (www., m., music., player.).
export const PLATFORM_HOSTS: readonly string[] = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'vimeo.com', 'dailymotion.com', 'dai.ly'];

export function isPlatformUrl(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return PLATFORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export class YtDlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YtDlpError';
  }
}

export const YTDLP_MISSING_MESSAGE = 'yt-dlp not found — it is needed for YouTube and other video-site links. Run `npm run setup` to download it (desktop app: reinstall August), set YTDLP_PATH, or install it manually: macOS `brew install yt-dlp`, Windows `winget install yt-dlp`.';

export const CANCELLED_MESSAGE = 'Download cancelled';

/// Maps yt-dlp's stderr to a plain-language message. Pure.
export function classifyYtDlpError(stderr: string): string {
  const errorLines = stderr.split(/\r?\n/).filter((line) => /^ERROR:/.test(line.trim()));
  const lastError = (errorLines[errorLines.length - 1] ?? '')
    .trim()
    .replace(/^ERROR:\s*(\[[^\]]+\]\s*[^:]+:\s*)?/, '')
    .trim();
  const s = stderr.toLowerCase();
  if (/private video/.test(s)) return 'This video is private — only videos you can open without signing in can be transcribed.';
  if (/confirm your age|age-restricted|age restricted|inappropriate for some users/.test(s)) return 'This video is age-restricted and requires signing in — it cannot be downloaded.';
  if (/not a bot/.test(s)) return 'YouTube asked to confirm this is not a bot. Wait a few minutes and try again; if it keeps happening, update yt-dlp (`npm run setup`).';
  if (/members-only|join this channel|music premium|requires payment|purchase/.test(s)) return 'This video is available only to paying members or subscribers — it cannot be downloaded.';
  if (/is live|live event|premieres in|will begin in/.test(s)) return 'Live streams and upcoming premieres cannot be transcribed — try again after the stream has ended.';
  if (/unsupported url/.test(s)) return 'This link is not supported — paste a link to a single video.';
  if (/video unavailable|this video is unavailable|has been removed|does not exist|not available in your country|http error 404/.test(s)) return 'This video is unavailable — it may have been removed, be region-locked, or the link is wrong.';
  if (/requested format is not available|no video formats found|no formats/.test(s)) return 'No downloadable audio stream was found for this video.';
  if (/getaddrinfo|name or service not known|nodename nor servname|timed out|connection (reset|refused|aborted)|network is unreachable|unable to download (webpage|api|json)|ssl|handshake|temporary failure in name resolution/.test(s)) return 'Network error while contacting the video site — check your internet connection and try again.';
  return `yt-dlp failed: ${(lastError || 'unknown error').slice(0, 300)}`;
}

const STDERR_KEEP_BYTES = 64 * 1024;

function runYtDlp(
  args: string[],
  opts: { sessionKey: string; signal?: AbortSignal; stallTimeoutMs: number; onStdoutLine?: (line: string) => void },
): Promise<{ code: number | null; stderr: string; stalled: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytDlpPath, ['--ignore-config', ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const untrack = trackChildProcess(opts.sessionKey, child);

    let settled = false;
    let stalled = false;
    let stderr = '';
    let stdoutBuf = '';
    let stallTimer: NodeJS.Timeout | null = null;

    const onAbort = () => { child.kill(); };
    const cleanup = () => {
      untrack();
      if (stallTimer) clearTimeout(stallTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const resetStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        child.kill();
      }, opts.stallTimeoutMs);
    };

    if (opts.signal) {
      if (opts.signal.aborted) child.kill();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    resetStall();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      resetStall();
      stdoutBuf += chunk;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) opts.onStdoutLine?.(trimmed);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      resetStall();
      stderr += chunk;
      if (stderr.length > STDERR_KEEP_BYTES) stderr = stderr.slice(-STDERR_KEEP_BYTES);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new YtDlpError(err.code === 'ENOENT' ? YTDLP_MISSING_MESSAGE : `yt-dlp could not start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const rest = stdoutBuf.trim();
      if (rest) opts.onStdoutLine?.(rest);
      resolve({ code, stderr, stalled });
    });
  });
}

export const INFO_JSON_NAME = 'ytdlp-info.info.json';

export interface PlatformVideoInfo {
  title: string;
  durationSec: number | null;
  isLive: boolean;
  infoJsonPath: string;
}

/// Resolves the video's metadata without downloading media. yt-dlp writes it as a UTF-8 .info.json (stdout is in the console codepage on Windows, so titles are never parsed from it); the same file feeds --load-info-json, so the page is extracted only once.
export async function probePlatformVideo(
  url: string,
  opts: { destDir: string; sessionKey: string; signal?: AbortSignal },
): Promise<PlatformVideoInfo> {
  await fs.mkdir(opts.destDir, { recursive: true });
  const { code, stderr, stalled } = await runYtDlp(
    ['--no-playlist', '--skip-download', '--write-info-json', '--no-write-playlist-metafiles', '--quiet', '--no-warnings', '-P', opts.destDir, '-o', 'ytdlp-info', url],
    { sessionKey: opts.sessionKey, signal: opts.signal, stallTimeoutMs: 120_000 },
  );
  if (opts.signal?.aborted) throw new YtDlpError(CANCELLED_MESSAGE);
  if (stalled) throw new YtDlpError('The video site did not respond — check your internet connection and try again.');
  if (code !== 0) throw new YtDlpError(classifyYtDlpError(stderr));

  const infoJsonPath = path.join(opts.destDir, INFO_JSON_NAME);
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(await fs.readFile(infoJsonPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    throw new YtDlpError('yt-dlp returned no video information for this link.');
  }
  const title = typeof info.title === 'string' ? info.title.trim() : '';
  const durationSec = typeof info.duration === 'number' && info.duration > 0 ? info.duration : null;
  const isLive = info.is_live === true || info.live_status === 'is_live' || info.live_status === 'is_upcoming';
  return { title, durationSec, isLive, infoJsonPath };
}

export interface PlatformAudioResult {
  filePath: string;
  extension: string;
}

/// Downloads the best audio-only stream (or the smallest complete file when a site has no separate audio) as audio.<ext> in destDir, reporting progress. The file is left in its original container — the standard ensureWav step converts it (AUG-149). On any failure the partial audio.* files are removed so a retranscribe never picks up a truncated download.
export async function downloadPlatformAudio(
  infoJsonPath: string,
  opts: { destDir: string; sessionKey: string; signal?: AbortSignal; onProgress?: (percent: number) => void },
): Promise<PlatformAudioResult> {
  const removePartials = async () => {
    try {
      const entries = await fs.readdir(opts.destDir);
      await Promise.all(entries.filter((name) => name.startsWith('audio.')).map((name) => fs.unlink(path.join(opts.destDir, name)).catch(() => {})));
    } catch {
      // best effort
    }
  };

  try {
    if (opts.signal?.aborted) throw new YtDlpError(CANCELLED_MESSAGE);

    let ext = '';
    let lastEmit = 0;
    const args = [
      '--load-info-json', infoJsonPath,
      '--no-playlist',
      '-f', 'bestaudio/best',
      '-P', opts.destDir,
      '-o', 'audio.%(ext)s',
      '--no-mtime',
      '--newline',
      '--progress',
      '--progress-template', 'download:AUGPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
      '--no-simulate',
      '--print', 'after_move:AUGEXT %(ext)s',
      ...(path.isAbsolute(config.ffmpegPath) ? ['--ffmpeg-location', config.ffmpegPath] : []),
    ];

    let result: { code: number | null; stderr: string; stalled: boolean };
    try {
      result = await runYtDlp(args, {
        sessionKey: opts.sessionKey,
        signal: opts.signal,
        stallTimeoutMs: 120_000,
        onStdoutLine: (line) => {
          if (line.startsWith('AUGPROG ')) {
            // yt-dlp prints NA for unknown values: Number('NA') is NaN, treated as 0.
            const [d, t, e] = line.slice('AUGPROG '.length).split(/\s+/).map((v) => Number(v) || 0);
            const total = t || e;
            const percent = total > 0 ? Math.min(99, Math.floor((d * 100) / total)) : 0;
            const now = Date.now();
            if (now - lastEmit >= 500) {
              lastEmit = now;
              opts.onProgress?.(percent);
            }
          } else if (line.startsWith('AUGEXT ')) {
            ext = line.slice('AUGEXT '.length).trim();
          }
        },
      });
    } catch (err) {
      await removePartials();
      throw err;
    }

    const filePath = ext ? path.join(opts.destDir, `audio.${ext}`) : '';
    const produced = result.code === 0 && ext !== '' && await fs.access(filePath).then(() => true, () => false);
    if (produced) {
      opts.onProgress?.(100);
      return { filePath, extension: `.${ext.toLowerCase()}` };
    }

    await removePartials();
    if (opts.signal?.aborted) throw new YtDlpError(CANCELLED_MESSAGE);
    if (result.stalled) throw new YtDlpError('Download stalled — check your internet connection and try again.');
    if (result.code === 0) throw new YtDlpError('yt-dlp finished without producing an audio file.');
    throw new YtDlpError(classifyYtDlpError(result.stderr));
  } finally {
    await fs.unlink(infoJsonPath).catch(() => {});
  }
}
