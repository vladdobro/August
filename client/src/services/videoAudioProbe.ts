/**
 * Local pre-check (AUG-146): does an MP4/MOV file contain an audio track?
 * Reads only box headers + the 'moov' box (never the whole file).
 *
 * Returns false ONLY when 'moov' was parsed completely and no track has a 'soun' handler.
 * Anything uncertain -> null, so the server-side ffprobe check
 * (assertVideoHasAudio in server/src/services/whisper.ts, AUG-144) stays the safety net.
 */

export const NO_AUDIO_MESSAGE = 'The video has no audio track — nothing to transcribe.';

const MAX_TOP_BOXES = 100;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

interface BoxHeader {
  type: string;
  size: number;
  headerSize: number;
}

export function isVideoFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.mp4') || name.endsWith('.mov');
}

function parseHeader(view: DataView, offset: number, end: number): BoxHeader | null {
  const avail = Math.min(view.byteLength, end - offset);
  if (avail < 8) return null;
  let size = view.getUint32(0);
  let type = '';
  for (let i = 4; i < 8; i++) {
    const c = view.getUint8(i);
    if (c < 0x20 || c > 0x7e) return null;
    type += String.fromCharCode(c);
  }
  let headerSize = 8;
  if (size === 1) {
    if (avail < 16) return null;
    size = view.getUint32(8) * 4294967296 + view.getUint32(12);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < headerSize || offset + size > end) return null;
  return { type, size, headerSize };
}

async function readBoxHeader(blob: Blob, offset: number, end: number): Promise<BoxHeader | null> {
  const buf = await blob.slice(offset, Math.min(offset + 16, end)).arrayBuffer();
  return parseHeader(new DataView(buf), offset, end);
}

/** Header of a box inside an in-memory buffer; offsets are relative to the buffer. */
function memBox(buf: ArrayBuffer, offset: number, end: number): BoxHeader | null {
  const len = Math.min(16, end - offset);
  if (len < 8) return null;
  return parseHeader(new DataView(buf, offset, len), offset, end);
}

/** Walks children of [start, end); returns null on any malformed box. */
function children(buf: ArrayBuffer, start: number, end: number): Array<BoxHeader & { offset: number }> | null {
  const out: Array<BoxHeader & { offset: number }> = [];
  let pos = start;
  while (pos < end) {
    const h = memBox(buf, pos, end);
    if (!h) return null;
    out.push({ ...h, offset: pos });
    pos += h.size;
  }
  return out;
}

function parseMoov(buf: ArrayBuffer, start: number, end: number): boolean | null {
  const kids = children(buf, start, end);
  if (!kids) return null;
  let traks = 0;
  let unknown = false;
  for (const trak of kids.filter((k) => k.type === 'trak')) {
    traks++;
    const tk = children(buf, trak.offset + trak.headerSize, trak.offset + trak.size);
    const mdia = tk?.find((k) => k.type === 'mdia');
    if (!tk) return null;
    const md = mdia ? children(buf, mdia.offset + mdia.headerSize, mdia.offset + mdia.size) : null;
    if (mdia && !md) return null;
    const hdlr = md?.find((k) => k.type === 'hdlr');
    if (!hdlr || hdlr.size - hdlr.headerSize < 12) {
      unknown = true;
      continue;
    }
    const p = hdlr.offset + hdlr.headerSize + 8;
    const handler = String.fromCharCode(...new Uint8Array(buf, p, 4));
    if (handler === 'soun') return true;
  }
  if (traks === 0 || unknown) return null;
  return false;
}

async function probe(blob: Blob): Promise<boolean | null> {
  let offset = 0;
  for (let i = 0; i < MAX_TOP_BOXES && offset < blob.size; i++) {
    const h = await readBoxHeader(blob, offset, blob.size);
    if (!h) return null;
    if (h.type === 'moov') {
      if (h.size > MAX_MOOV_BYTES) return null;
      const buf = await blob.slice(offset + h.headerSize, offset + h.size).arrayBuffer();
      return parseMoov(buf, 0, buf.byteLength);
    }
    offset += h.size;
  }
  return null;
}

export async function probeVideoHasAudio(file: Blob, timeoutMs = 2000): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([probe(file), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
