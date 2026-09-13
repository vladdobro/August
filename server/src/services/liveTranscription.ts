// WebSocket endpoint for live (in-progress) transcription. This is an
// additive layer on top of the existing record-then-upload-then-transcribe
// pipeline (routes/sessions.ts + services/whisper.ts) — it does not touch
// that pipeline. The client streams short raw-PCM windows (captured
// alongside, not instead of, the existing MediaRecorder capture) over this
// socket; each window is decoded independently with whisper-cli and the
// resulting text is pushed straight back to the client for a live transcript
// panel. Nothing here is persisted to disk beyond the lifetime of a chunk.

import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

import { config } from '../config.js';
import { runWhisper } from './whisper.js';
import { FILLER_ONLY_TEXTS, isHallucination, normalize, stripCreditHallucination } from './transcriptMerger.js';

type Speaker = 'Me' | 'Them';

interface DecodedChunk {
  speaker: Speaker;
  language: string;
  samples: Float32Array;
}

const MAX_QUEUE_LENGTH = 6;
const MAX_CONSECUTIVE_FAILURES = 3;
const CHUNK_TIMEOUT_MS = 20_000;
const SAMPLE_RATE = 16000;

// Live chunks are written next to the sessions dir (server/data/live-tmp),
// never os.tmpdir() — on this machine the Windows account name is Cyrillic,
// so os.tmpdir() resolves to a non-ASCII path that crashes whisper-cli
// outright (same issue documented in whisper.ts's toSafePath).
const LIVE_TMP_DIR = path.resolve(config.sessionsDir, '..', 'live-tmp');

/// Decodes one binary chunk message. Wire format (all little-endian):
///   byte 0      speaker: 0 = Them, 1 = Me
///   byte 1      language string length in bytes (L)
///   bytes 2..2+L  UTF-8 language code (e.g. "auto", "en", "ru")
///   remaining   Float32 PCM samples at 16kHz mono
/// Read via Buffer's byte-at-a-time accessors (not a Float32Array view over
/// the raw bytes) so alignment of the incoming Buffer never matters.
function decodeChunkMessage(data: Buffer): DecodedChunk {
  const speakerByte = data.readUInt8(0);
  const langLen = data.readUInt8(1);
  const language = data.toString('utf-8', 2, 2 + langLen) || 'auto';
  const headerLen = 2 + langLen;
  const sampleCount = Math.floor((data.length - headerLen) / 4);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = data.readFloatLE(headerLen + i * 4);
  }
  return { speaker: speakerByte === 1 ? 'Me' : 'Them', language, samples };
}

/// Writes a Float32 PCM buffer as a 16kHz mono 16-bit WAV file.
function writeWav(filePath: string, pcmFloat32: Float32Array): Promise<void> {
  const numSamples = pcmFloat32.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcmFloat32[i]));
    const val = s < 0 ? s * 32768 : s * 32767;
    buffer.writeInt16LE(Math.round(val), 44 + i * 2);
  }

  return fs.writeFile(filePath, buffer);
}

/// True when whisper's output for a 4s chunk is empty or one of the known
/// silence/hallucination artifacts — reuses the exact same filler set and
/// hallucination blacklist the batch pipeline (transcriptMerger.ts) applies,
/// so live and post-hoc transcripts agree on what counts as "not speech".
function isLikelyFiller(text: string): boolean {
  const normalized = normalize(text);
  if (normalized.length === 0) return true;
  if (FILLER_ONLY_TEXTS.has(normalized)) return true;
  if (isHallucination(normalized)) return true;
  return false;
}

async function transcribeChunk(wavPath: string, language: string): Promise<string> {
  const outputBase = wavPath.slice(0, -path.extname(wavPath).length);
  const parsed = await runWhisper({
    audioPath: wavPath,
    language,
    outputBase,
    timeoutMs: CHUNK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 16,
  });
  return (parsed.transcription ?? [])
    .map((entry) => (entry.text ?? '').trim())
    .filter((t) => t.length > 0)
    .join(' ')
    .trim();
}

interface QueuedChunk {
  speaker: Speaker;
  language: string;
  samples: Float32Array;
}

export function setupLiveTranscription(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: '/api/live-transcribe' });

  wss.on('connection', (ws: WebSocket) => {
    const queue: QueuedChunk[] = [];
    let processing = false;
    let stopped = false;
    let paused = false;
    let consecutiveFailures = 0;

    const send = (payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    const processQueue = async () => {
      if (processing) return;
      processing = true;

      while (queue.length > 0 && !stopped) {
        while (queue.length > MAX_QUEUE_LENGTH) {
          queue.shift();
        }

        const chunk = queue.shift()!;
        if (paused) continue;

        await fs.mkdir(LIVE_TMP_DIR, { recursive: true });
        const wavPath = path.join(LIVE_TMP_DIR, `chunk-${randomUUID()}.wav`);

        try {
          await writeWav(wavPath, chunk.samples);
          const text = await transcribeChunk(wavPath, chunk.language);
          consecutiveFailures = 0;

          if (!isLikelyFiller(text)) {
            const cleaned = stripCreditHallucination(text);
            if (cleaned.length > 0 && !isLikelyFiller(cleaned)) {
              send({ type: 'transcript', speaker: chunk.speaker, text: cleaned });
            }
          }
        } catch (err) {
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            send({
              type: 'error',
              message: 'Live transcription interrupted — too many consecutive failures',
            });
            stopped = true;
          }
        } finally {
          fs.unlink(wavPath).catch(() => {});
        }
      }

      processing = false;
    };

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (stopped) return;

      if (isBinary && Buffer.isBuffer(data)) {
        try {
          const chunk = decodeChunkMessage(data);
          if (chunk.samples.length > 0) {
            queue.push(chunk);
            void processQueue();
          }
        } catch {
          // malformed binary frame; ignore
        }
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        switch (msg.type) {
          case 'stop':
            stopped = true;
            queue.length = 0;
            break;
          case 'pause':
            paused = true;
            break;
          case 'resume':
            paused = false;
            if (queue.length > 0) void processQueue();
            break;
        }
      } catch {
        // malformed control message; ignore
      }
    });

    ws.on('close', () => {
      stopped = true;
      queue.length = 0;
    });
  });
}
