// Pure, dependency-free pieces of the live-transcription pipeline (AUG-113):
// the 16 kHz chunk accumulator (a server port of the one in
// client/src/services/liveTranscriptionClient.ts — same constants, so
// browser-tapped and server-fed system audio produce identical windows), the
// s16le → Float32 feeder that turns ffmpeg's raw PCM tee into accumulator
// input, and the JSON control-frame parser for the WebSocket. Kept apart from
// liveTranscription.ts so they are unit-testable without ws/whisper.

export const SAMPLE_RATE = 16000;
export const CHUNK_DURATION_SEC = 4.0;
export const OVERLAP_DURATION_SEC = 1.0;
export const CHUNK_SAMPLES = CHUNK_DURATION_SEC * SAMPLE_RATE; // 64000
export const OVERLAP_SAMPLES = OVERLAP_DURATION_SEC * SAMPLE_RATE; // 16000
/// flush() emits the partial window only when at least this much audio arrived
/// after the last emitted chunk — otherwise the buffer holds nothing but the
/// carried overlap and a flush would re-transcribe the previous tail.
export const MIN_FLUSH_FRESH_SAMPLES = SAMPLE_RATE / 2; // 8000 (0.5 s)

/// Speech gate (AUG-127): a window is sent only when it holds enough speech-like audio, not merely enough energy.
/// Whole-window RMS let one click/breath in an otherwise silent 4 s window through, and whisper then hallucinated
/// "Okay." on it. Frames are 20 ms; a frame is loud when its RMS exceeds SPEECH_FRAME_RMS_THRESHOLD (same level as
/// the old window gate, so quiet speech is not lost); only loud runs of at least MIN_SPEECH_RUN_MS count (shorter
/// runs are transients); the window needs MIN_SPEECH_MS of counted speech.
export const SPEECH_FRAME_MS = 20;
export const SPEECH_FRAME_SAMPLES = (SAMPLE_RATE * SPEECH_FRAME_MS) / 1000; // 320
export const SPEECH_FRAME_RMS_THRESHOLD = 0.006;
export const MIN_SPEECH_RUN_MS = 160;
export const MIN_SPEECH_MS = 200;

/// Milliseconds of speech in `samples`: the summed length of loud-frame runs that last at least MIN_SPEECH_RUN_MS.
export function speechDurationMs(samples: Float32Array): number {
  const minRunFrames = MIN_SPEECH_RUN_MS / SPEECH_FRAME_MS;
  const frameCount = Math.floor(samples.length / SPEECH_FRAME_SAMPLES);
  let speechFrames = 0;
  let run = 0;
  for (let f = 0; f < frameCount; f++) {
    const start = f * SPEECH_FRAME_SAMPLES;
    let sum = 0;
    for (let i = start; i < start + SPEECH_FRAME_SAMPLES; i++) sum += samples[i] * samples[i];
    if (Math.sqrt(sum / SPEECH_FRAME_SAMPLES) > SPEECH_FRAME_RMS_THRESHOLD) {
      run++;
    } else {
      if (run >= minRunFrames) speechFrames += run;
      run = 0;
    }
  }
  if (run >= minRunFrames) speechFrames += run;
  return speechFrames * SPEECH_FRAME_MS;
}

export function hasEnoughSpeech(samples: Float32Array): boolean {
  return speechDurationMs(samples) >= MIN_SPEECH_MS;
}

/// Accumulates 16 kHz samples into fixed CHUNK_SAMPLES windows with
/// OVERLAP_SAMPLES of trailing overlap carried into the next window, so a word
/// split across a chunk boundary still has a full attempt on one side. Windows
/// that fail hasEnoughSpeech are dropped (speech gate).
export class ChunkAccumulator {
  private buffer = new Float32Array(CHUNK_SAMPLES);
  private writePos = 0;
  private freshSamples = 0;

  feed(input: Float32Array, onChunk: (samples: Float32Array) => void): void {
    let offset = 0;
    while (offset < input.length) {
      const spaceLeft = CHUNK_SAMPLES - this.writePos;
      const toCopy = Math.min(spaceLeft, input.length - offset);
      this.buffer.set(input.subarray(offset, offset + toCopy), this.writePos);
      this.writePos += toCopy;
      this.freshSamples += toCopy;
      offset += toCopy;

      if (this.writePos >= CHUNK_SAMPLES) {
        const chunk = this.buffer.slice(0, CHUNK_SAMPLES);
        if (hasEnoughSpeech(chunk)) onChunk(chunk);
        const carried = this.buffer.slice(CHUNK_SAMPLES - OVERLAP_SAMPLES, CHUNK_SAMPLES);
        this.buffer.set(carried, 0);
        this.writePos = OVERLAP_SAMPLES;
        this.freshSamples = 0;
      }
    }
  }

  /// Emits whatever accumulated since the last full window (used when the
  /// source ends), then resets. Returns true when a chunk was emitted.
  flush(onChunk: (samples: Float32Array) => void): boolean {
    let emitted = false;
    if (this.freshSamples >= MIN_FLUSH_FRESH_SAMPLES) {
      const chunk = this.buffer.slice(0, this.writePos);
      if (hasEnoughSpeech(chunk)) {
        onChunk(chunk);
        emitted = true;
      }
    }
    this.writePos = 0;
    this.freshSamples = 0;
    return emitted;
  }
}

/// Converts ffmpeg's raw `-f s16le -ac 1 -ar 16000` byte stream into Float32
/// samples for a ChunkAccumulator. stdout chunks split anywhere, including
/// mid-sample, so a trailing odd byte is carried into the next call.
export class LivePcmFeeder {
  private readonly accumulator = new ChunkAccumulator();
  private carry: number | null = null;

  constructor(private readonly onChunk: (samples: Float32Array) => void) {}

  feed(pcm: Buffer): void {
    if (pcm.length === 0) return;
    let bytes = pcm;
    if (this.carry !== null) {
      bytes = Buffer.concat([Buffer.from([this.carry]), pcm]);
      this.carry = null;
    }
    const sampleCount = Math.floor(bytes.length / 2);
    if (bytes.length % 2 === 1) this.carry = bytes[bytes.length - 1];
    if (sampleCount === 0) return;
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
    this.accumulator.feed(samples, this.onChunk);
  }

  flush(): boolean {
    this.carry = null;
    return this.accumulator.flush(this.onChunk);
  }
}

export type LiveControlFrame =
  | { type: 'stop' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'config'; engine: 'local' | 'groq' }
  | { type: 'attach-capture'; captureId: string; language: string };

/// Parses one text WebSocket frame. Returns null for malformed JSON, unknown
/// types, a config frame with an unknown engine, or an attach-capture frame
/// without a non-empty string captureId. attach-capture's language defaults to 'auto'.
export function parseLiveControlFrame(text: string): LiveControlFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const o = msg as Record<string, unknown>;
  switch (o.type) {
    case 'stop':
    case 'pause':
    case 'resume':
      return { type: o.type };
    case 'config':
      return o.engine === 'groq' || o.engine === 'local' ? { type: 'config', engine: o.engine } : null;
    case 'attach-capture': {
      const captureId = typeof o.captureId === 'string' ? o.captureId.trim() : '';
      if (!captureId) return null;
      const language = typeof o.language === 'string' && o.language.trim() ? o.language.trim() : 'auto';
      return { type: 'attach-capture', captureId, language };
    }
    default:
      return null;
  }
}
