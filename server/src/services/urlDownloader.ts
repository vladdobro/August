import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UPLOAD_EXTENSIONS } from './mediaFormats.js';

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_REDIRECTS = 5;
const STALL_TIMEOUT_MS = 60_000;

const ACCEPTED_MEDIA_TYPES = new Set([
  'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/mpeg', 'audio/mp3',
  'audio/ogg', 'audio/vorbis',
  'audio/flac', 'audio/x-flac',
  'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac',
  'video/mp4',
  'video/quicktime',
]);

function isAcceptedContentType(ct: string): boolean {
  const base = ct.split(';')[0].trim().toLowerCase();
  if (base.startsWith('audio/')) return true;
  if (base === 'video/mp4' || base === 'video/quicktime') return true;
  return ACCEPTED_MEDIA_TYPES.has(base);
}

function isHtmlContentType(ct: string): boolean {
  const base = ct.split(';')[0].trim().toLowerCase();
  return base === 'text/html' || base === 'application/xhtml+xml';
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  if (h.startsWith('127.')) return true;
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h === '::') return true;
  return false;
}

export class UrlDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlDownloadError';
  }
}

function validateUrl(urlStr: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new UrlDownloadError('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlDownloadError('Only http and https links are supported');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new UrlDownloadError('Links to local or private network addresses are not allowed');
  }
  return parsed;
}

function extensionFromUrl(url: URL): string | null {
  const lastSegment = url.pathname.split('/').pop() || '';
  const dotIdx = lastSegment.lastIndexOf('.');
  if (dotIdx < 0) return null;
  return lastSegment.slice(dotIdx).toLowerCase();
}

function filenameFromHeaders(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;
  const match = /filename\*?=(?:UTF-8''|"?)([^";]+)/i.exec(contentDisposition);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1].replace(/^"|"$/g, '').trim());
  } catch {
    return match[1].replace(/^"|"$/g, '').trim();
  }
}

function filenameFromUrl(url: URL): string {
  const lastSegment = url.pathname.split('/').pop() || '';
  try {
    return decodeURIComponent(lastSegment) || 'download';
  } catch {
    return lastSegment || 'download';
  }
}

function guessExtensionFromContentType(ct: string): string | null {
  const base = ct.split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav',
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3',
    'audio/ogg': '.ogg', 'audio/vorbis': '.ogg',
    'audio/flac': '.flac', 'audio/x-flac': '.flac',
    'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a', 'audio/aac': '.m4a',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
  };
  return map[base] ?? null;
}

export interface UrlDownloadResult {
  filePath: string;
  fileName: string;
  bytes: number;
  extension: string;
}

export interface UrlDownloadOptions {
  destDir: string;
  onProgress?: (percent: number, bytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

export async function downloadFromUrl(
  urlStr: string,
  opts: UrlDownloadOptions,
): Promise<UrlDownloadResult> {
  let currentUrl = validateUrl(urlStr);
  let response: Response | null = null;
  let redirectCount = 0;

  while (redirectCount <= MAX_REDIRECTS) {
    if (opts.signal?.aborted) throw new UrlDownloadError('Download cancelled');

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const resetStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
    };

    try {
      resetStall();
      const res = await fetch(currentUrl.toString(), {
        signal: controller.signal,
        redirect: 'manual',
      });

      if (stallTimer) clearTimeout(stallTimer);
      opts.signal?.removeEventListener('abort', onAbort);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new UrlDownloadError(`Redirect (${res.status}) with no Location header`);
        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          throw new UrlDownloadError('Too many redirects (limit: 5)');
        }
        currentUrl = validateUrl(new URL(location, currentUrl).toString());
        continue;
      }

      if (!res.ok) {
        throw new UrlDownloadError(`Server returned ${res.status} ${res.statusText}`);
      }

      response = res;
      break;
    } catch (err) {
      if (stallTimer) clearTimeout(stallTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (err instanceof UrlDownloadError) throw err;
      if (opts.signal?.aborted) throw new UrlDownloadError('Download cancelled');
      throw new UrlDownloadError(`Download failed: ${(err as Error).message}`);
    }
  }

  if (!response || !response.body) {
    throw new UrlDownloadError('No response body');
  }

  const contentType = response.headers.get('content-type') || '';
  if (isHtmlContentType(contentType)) {
    throw new UrlDownloadError(
      'This link is not a direct media file — download it and upload the file instead.',
    );
  }

  const urlExt = extensionFromUrl(currentUrl);
  const hasAcceptedExt = urlExt !== null && (UPLOAD_EXTENSIONS as readonly string[]).includes(urlExt);
  const hasAcceptedCT = isAcceptedContentType(contentType);

  if (!hasAcceptedExt && !hasAcceptedCT) {
    throw new UrlDownloadError(
      `Unsupported media type. The URL must point to a direct audio or video file (${UPLOAD_EXTENSIONS.join(', ')}).`,
    );
  }

  const contentLength = Number(response.headers.get('content-length')) || 0;
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    const sizeGB = (contentLength / (1024 * 1024 * 1024)).toFixed(1);
    throw new UrlDownloadError(`File is too large (${sizeGB} GB). Maximum is 2 GB.`);
  }

  const ext = hasAcceptedExt ? urlExt! : (guessExtensionFromContentType(contentType) || '.bin');
  const headerName = filenameFromHeaders(response.headers.get('content-disposition'));
  const urlName = filenameFromUrl(currentUrl);
  const fileName = headerName || urlName;
  const destPath = path.join(opts.destDir, `audio${ext}`);

  await fs.mkdir(opts.destDir, { recursive: true });

  let bytes = 0;
  let lastEmit = 0;
  const streamAbort = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const resetStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => streamAbort.abort(), STALL_TIMEOUT_MS);
  };

  const onExternalAbort = () => streamAbort.abort();
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    if (opts.signal?.aborted) throw new UrlDownloadError('Download cancelled');

    resetStall();
    await pipeline(
      Readable.fromWeb(response.body as never),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > MAX_DOWNLOAD_BYTES) {
            cb(new UrlDownloadError('Download exceeded the 2 GB limit'));
            return;
          }

          resetStall();

          const now = Date.now();
          if (now - lastEmit >= 500) {
            lastEmit = now;
            const percent = contentLength > 0
              ? Math.min(99, Math.floor((bytes * 100) / contentLength))
              : 0;
            opts.onProgress?.(percent, bytes, contentLength);
          }

          if (streamAbort.signal.aborted) {
            cb(new UrlDownloadError(opts.signal?.aborted ? 'Download cancelled' : 'Download timed out'));
            return;
          }

          cb(null, chunk);
        },
      }),
      createWriteStream(destPath),
    );

    if (stallTimer) clearTimeout(stallTimer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
    opts.onProgress?.(100, bytes, contentLength || bytes);

    return { filePath: destPath, fileName, bytes, extension: ext };
  } catch (err) {
    if (stallTimer) clearTimeout(stallTimer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
    await fs.unlink(destPath).catch(() => {});
    if (opts.signal?.aborted) throw new UrlDownloadError('Download cancelled');
    if (err instanceof UrlDownloadError) throw err;
    throw new UrlDownloadError(`Download failed: ${(err as Error).message}`);
  }
}
