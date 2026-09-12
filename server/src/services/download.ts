import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
}

export class OfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineError';
  }
}

const OFFLINE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function isOfflineError(err: unknown): boolean {
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 5) {
    if (cur instanceof OfflineError) return true;
    const code = (cur as { code?: unknown })?.code;
    if (typeof code === 'string' && OFFLINE_CODES.has(code)) return true;
    cur = (cur as { cause?: unknown })?.cause;
    depth++;
  }
  return false;
}

/// Streams `url` to `destPath` while computing its SHA256 in the same pass.
/// Aborts if no bytes arrive for `stallTimeoutMs` (default 60s). On any
/// failure, `destPath` is deleted (best effort) and the error is rethrown —
/// network-unreachable failures are rethrown as OfflineError so callers can
/// distinguish "no internet" from other failures (bad URL, disk full, ...).
export async function downloadToFile(
  url: string,
  destPath: string,
  opts?: {
    onProgress?: (p: DownloadProgress) => void;
    expectedBytes?: number;
    stallTimeoutMs?: number;
    offlineMessage?: string;
  },
): Promise<{ sha256: string; bytes: number }> {
  const stallTimeoutMs = opts?.stallTimeoutMs ?? 60_000;
  const offlineMessage = opts?.offlineMessage ?? 'No internet connection.';

  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), stallTimeoutMs);
  };

  try {
    resetStallTimer();
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    if (!res.body) {
      throw new Error(`No response body for ${url}`);
    }

    const totalBytes = Number(res.headers.get('content-length')) || opts?.expectedBytes || 0;
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    const hash = createHash('sha256');
    let bytes = 0;
    let lastEmit = 0;

    const emitProgress = (final = false) => {
      if (!opts?.onProgress) return;
      const now = Date.now();
      if (!final && now - lastEmit < 250) return;
      lastEmit = now;
      const percent = totalBytes ? Math.min(100, Math.floor((bytes * 1000) / totalBytes) / 10) : 0;
      opts.onProgress({ bytesDownloaded: bytes, totalBytes, percent: final ? (totalBytes ? 100 : percent) : percent });
    };

    await pipeline(
      Readable.fromWeb(res.body as never),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          bytes += chunk.length;
          resetStallTimer();
          emitProgress();
          cb(null, chunk);
        },
      }),
      createWriteStream(destPath),
    );

    if (stallTimer) clearTimeout(stallTimer);
    emitProgress(true);

    return { sha256: hash.digest('hex'), bytes };
  } catch (err) {
    await fs.unlink(destPath).catch(() => {});
    if (isOfflineError(err)) {
      throw new OfflineError(offlineMessage);
    }
    throw err;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
}
