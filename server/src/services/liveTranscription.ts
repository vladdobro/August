// WebSocket endpoint for live (in-progress) transcription. This is an
// additive layer on top of the existing record-then-upload-then-transcribe
// pipeline (routes/sessions.ts + services/whisper.ts) — it does not touch
// that pipeline. The client streams short raw-PCM windows (captured
// alongside, not instead of, the existing MediaRecorder capture) over this
// socket; each window is decoded independently with whisper-cli and the
// resulting text is pushed straight back to the client for a live transcript
// panel. Nothing here is persisted to disk beyond the lifetime of a chunk.
//
// AUG-113: when the system track is captured server-side (systemCapture.ts,
// started with { live: true }), the client sends a text control frame
// { type: 'attach-capture', captureId, language } right after connect. The
// server binds that capture's PCM tee to this connection: raw s16le bytes go
// through LivePcmFeeder → ChunkAccumulator (same 4 s / 1 s / RMS 0.006 rules as
// the browser tap) and are queued as speaker Them. Detach never stops the
// capture; stopCapture() ends the tee, whose onEnd flushes the last partial
// window here before the WAV is finalized.
//
// AUG-164: when the user opted into online text correction (Settings, consent
// stored in preferences), each transcript frame carries an id and a
// LiveTextCorrector pushes { type: 'correction', id, text } frames for settled
// chunks; still nothing is persisted.
//
// AUG-165: with an action-items-init frame (liveKey per recording) the connection joins that recording's action-items store; when online text correction is active a LiveActionItemsExtractor collects items. Items and participants are persisted (pending file -> session folder on upload); live text still is not. AUG-168: the extractor knows the live engine to space local fallback calls (120 s on local whisper).

import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

import { config } from '../config.js';
import { runWhisper } from './whisper.js';
import { FILLER_ONLY_TEXTS, isHallucination, normalize, stripCreditHallucination } from './transcriptMerger.js';
import { transcribeWithGroq, GroqRateLimitError, GroqApiError } from './groqTranscription.js';
import { attachLiveSink, CaptureError, type LiveSinkHandle } from './systemCapture.js';
import { LivePcmFeeder, parseLiveControlFrame, SAMPLE_RATE } from './liveChunking.js';
import { isGroqTextActive } from './groqText.js';
import { LiveTextCorrector } from './liveTextCorrection.js';
import { openLiveActionItems, releaseLiveActionItems, LiveActionItemsExtractor, type LiveActionItemsStore } from './liveActionItems.js';
import type { ActionItemsFile } from '../types.js';

type Speaker = 'Me' | 'Them';

interface DecodedChunk {
  speaker: Speaker;
  language: string;
  samples: Float32Array;
}

const MAX_QUEUE_LENGTH = 6;
const MAX_CONSECUTIVE_FAILURES = 3;
const CHUNK_TIMEOUT_MS = 20_000;

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
  // Silero VAD (AUG-127): a chunk with no detected speech decodes to no segments, so it emits no line. Missing model → runWhisper warns once and decodes without VAD.
  const parsed = await runWhisper({
    audioPath: wavPath,
    language,
    vad: true,
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
    let engine: 'local' | 'groq' = 'local';
    let groqFallbackWarned = false;
    let captureSink: LiveSinkHandle | null = null;

    const detachCapture = () => {
      captureSink?.detach();
      captureSink = null;
    };

    const send = (payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    // AUG-165: action items of this recording (shared store per liveKey) and their extractor.
    let groqTextActive: boolean | null = null;
    let actionKey: string | null = null;
    let actionStore: LiveActionItemsStore | null = null;
    let actionExtractor: LiveActionItemsExtractor | null = null;
    let unsubscribeActions: (() => void) | null = null;
    const sendActionItems = (file: ActionItemsFile) => send({ type: 'action-items', enabled: groqTextActive === true, participants: file.participants, items: file.items });
    const maybeStartExtractor = () => {
      if (stopped || !actionStore || groqTextActive !== true || actionExtractor) return;
      actionExtractor = new LiveActionItemsExtractor(actionStore, undefined, { liveEngine: () => engine });
      actionExtractor.start();
    };
    const stopActionItems = () => {
      actionExtractor?.stop(); actionExtractor = null;
      unsubscribeActions?.(); unsubscribeActions = null;
      if (actionStore) { releaseLiveActionItems(actionStore.liveKey); actionStore = null; }
    };

    let corrector: LiveTextCorrector | null = null;
    void isGroqTextActive().then((active) => {
      groqTextActive = active;
      if (active && !stopped) {
        corrector = new LiveTextCorrector((id, text) => { send({ type: 'correction', id, text }); actionExtractor?.noteCorrection(id, text); }, undefined, undefined, () => actionExtractor?.cloudCallPending === true);
        corrector.start();
      }
      maybeStartExtractor();
      if (actionStore) sendActionItems(actionStore.file);
    }).catch(() => {
      groqTextActive = false;
      if (actionStore) sendActionItems(actionStore.file);
    });
    const stopCorrector = () => {
      corrector?.stop();
      corrector = null;
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
          let text: string;

          if (engine === 'groq') {
            try {
              text = await transcribeWithGroq(wavPath, chunk.language);
            } catch (groqErr) {
              if (groqErr instanceof GroqRateLimitError) {
                if (!groqFallbackWarned) {
                  send({ type: 'warning', message: 'Groq rate limit — falling back to local whisper' });
                  groqFallbackWarned = true;
                }
              } else if (groqErr instanceof GroqApiError && groqErr.fatal) {
                // No key or the key is rejected: retrying cannot help, stay local for this connection.
                send({ type: 'warning', message: 'Groq unavailable — switching to local whisper' });
                engine = 'local';
              } else {
                // AUG-164: a flaky network/VPN (403, 5xx, connection error) only costs this chunk; the next one tries Groq again.
                if (!groqFallbackWarned) {
                  send({ type: 'warning', message: 'Groq did not respond — this part was transcribed locally' });
                  groqFallbackWarned = true;
                }
              }
              text = await transcribeChunk(wavPath, chunk.language);
            }
          } else {
            text = await transcribeChunk(wavPath, chunk.language);
          }

          consecutiveFailures = 0;

          if (!isLikelyFiller(text)) {
            const cleaned = stripCreditHallucination(text);
            if (cleaned.length > 0 && !isLikelyFiller(cleaned)) {
              const id = randomUUID();
              send({ type: 'transcript', id, speaker: chunk.speaker, text: cleaned });
              corrector?.add(id, cleaned);
              actionExtractor?.addTranscript(id, chunk.speaker, cleaned);
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
            stopCorrector();
            stopActionItems();
          }
        } finally {
          fs.unlink(wavPath).catch(() => {});
        }
      }

      processing = false;
    };

    /// AUG-113: bind a server-side capture's PCM tee to this connection as Them.
    const attachCapture = (captureId: string, language: string) => {
      if (captureSink) {
        send({ type: 'warning', message: 'System audio is already attached to this live session' });
        return;
      }
      const feeder = new LivePcmFeeder((samples) => {
        if (stopped) return;
        queue.push({ speaker: 'Them', language, samples });
        void processQueue();
      });
      try {
        captureSink = attachLiveSink(captureId, {
          onPcm: (pcm) => { if (!paused && !stopped) feeder.feed(pcm); },
          onEnd: () => {
            // Capture stopped (or ffmpeg exited): push the last partial window
            // through transcription; the queue drains on its own.
            captureSink = null;
            if (!stopped) feeder.flush();
          },
        });
        send({ type: 'capture-attached', captureId });
      } catch (err) {
        const reason = err instanceof CaptureError ? err.message : 'unknown error';
        send({ type: 'warning', message: `System audio not attached (${reason}) — live transcript continues with the microphone only` });
      }
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

      const frame = parseLiveControlFrame(data.toString());
      if (!frame) return; // malformed control message; ignore
      switch (frame.type) {
        case 'stop':
          stopped = true;
          queue.length = 0;
          detachCapture();
          stopCorrector();
          stopActionItems();
          break;
        case 'pause':
          paused = true;
          break;
        case 'resume':
          paused = false;
          if (queue.length > 0) void processQueue();
          break;
        case 'config':
          engine = frame.engine;
          break;
        case 'attach-capture':
          attachCapture(frame.captureId, frame.language);
          break;
        case 'action-items-init':
          if (actionKey) break; // one store per connection
          actionKey = frame.liveKey;
          void openLiveActionItems(frame.liveKey).then((store) => {
            if (stopped) { releaseLiveActionItems(frame.liveKey); return; }
            actionStore = store;
            if (frame.participants) store.setParticipants(frame.participants);
            unsubscribeActions = store.subscribe(sendActionItems);
            maybeStartExtractor();
          }).catch((err) => console.warn(`[actionItems] could not open store: ${(err as Error).message}`));
          break;
        case 'participants':
          actionStore?.setParticipants({ me: frame.me, them: frame.them });
          break;
        case 'action-item-edit':
          actionStore?.editItem(frame.id, { text: frame.text, owner: frame.owner });
          break;
        case 'action-item-delete':
          actionStore?.removeItem(frame.id);
          break;
        case 'action-item-add':
          actionStore?.addManualItem({ text: frame.text, owner: frame.owner });
          break;
      }
    });

    ws.on('close', () => {
      stopped = true;
      queue.length = 0;
      detachCapture();
      stopCorrector();
      stopActionItems();
    });
  });
}
