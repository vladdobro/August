// Imperative client for the live-transcription WebSocket. This is a plain
// class rather than a hook because it owns Web Audio nodes and a WebSocket
// whose lifecycle is driven by the *existing* recording lifecycle
// (startRecording/stopRecording in FileUpload.tsx) — not by React's render
// cycle. FileUpload creates one instance when Live Transcription mode is
// selected and feeds it the same MediaStreams the (unmodified) MediaRecorder
// pipeline already captured; this class only taps them, it never touches
// the tracks used for the normal recording/upload path.
// AUG-113: when the system track is a server capture, start() receives its captureId; the client then sends an attach-capture control frame instead of tapping a system MediaStream, so only mic chunks travel over the socket.

export type Speaker = 'Me' | 'Them';
export type LiveStatus = 'connecting' | 'listening' | 'paused' | 'interrupted' | 'stopped';
export type LiveEngine = 'local' | 'groq';

const CHUNK_DURATION_SEC = 4.0;
const OVERLAP_DURATION_SEC = 1.0;
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = CHUNK_DURATION_SEC * SAMPLE_RATE; // 64000
const OVERLAP_SAMPLES = OVERLAP_DURATION_SEC * SAMPLE_RATE; // 16000
const SILENCE_RMS_THRESHOLD = 0.006;
const PROCESSOR_BUFFER_SIZE = 4096;

interface LiveTranscriptionCallbacks {
  onTranscript: (speaker: Speaker, text: string) => void;
  onStatusChange: (status: LiveStatus) => void;
  onError: (message: string) => void;
  onWarning: (message: string) => void;
  onMicUnavailable: () => void;
}

function computeRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/// Linear-interpolation resample from the AudioContext's native rate (48kHz
/// or 44.1kHz on most hardware) down to the 16kHz whisper expects. Browsers
/// do not reliably honor `new AudioContext({ sampleRate })` for graphs fed by
/// an existing MediaStreamTrack, so resampling is done explicitly here
/// rather than relied on implicitly.
function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === SAMPLE_RATE) return input;
  const ratio = inputRate / SAMPLE_RATE;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, input.length - 1);
    const frac = srcPos - idx0;
    output[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
  }
  return output;
}

/// Accumulates resampled 16kHz samples into fixed CHUNK_SAMPLES windows with
/// OVERLAP_SAMPLES of trailing overlap carried into the next window, so a
/// word split across a chunk boundary still has a full attempt on one side.
class ChunkAccumulator {
  private buffer = new Float32Array(CHUNK_SAMPLES);
  private writePos = 0;

  feed(input: Float32Array, onChunk: (samples: Float32Array) => void): void {
    let offset = 0;
    while (offset < input.length) {
      const spaceLeft = CHUNK_SAMPLES - this.writePos;
      const toCopy = Math.min(spaceLeft, input.length - offset);
      this.buffer.set(input.subarray(offset, offset + toCopy), this.writePos);
      this.writePos += toCopy;
      offset += toCopy;

      if (this.writePos >= CHUNK_SAMPLES) {
        const chunk = this.buffer.slice(0, CHUNK_SAMPLES);
        if (computeRMS(chunk) > SILENCE_RMS_THRESHOLD) {
          onChunk(chunk);
        }
        const overlapStart = CHUNK_SAMPLES - OVERLAP_SAMPLES;
        const carried = this.buffer.slice(overlapStart, CHUNK_SAMPLES);
        this.buffer.set(carried, 0);
        this.writePos = OVERLAP_SAMPLES;
      }
    }
  }
}

/// Encodes one chunk as a binary WebSocket frame:
///   byte 0      speaker: 0 = Them, 1 = Me
///   byte 1      language string length (L)
///   bytes 2..2+L UTF-8 language code
///   remaining   Float32 PCM samples, little-endian
/// Written sample-by-sample through a DataView rather than as a Float32Array
/// view over the shared buffer, so the header length never has to satisfy
/// TypedArray's 4-byte alignment requirement.
function encodeChunkMessage(speaker: Speaker, language: string, samples: Float32Array): ArrayBuffer {
  const langBytes = new TextEncoder().encode(language || 'auto');
  const headerLen = 2 + langBytes.length;
  const buf = new ArrayBuffer(headerLen + samples.length * 4);
  const view = new DataView(buf);
  view.setUint8(0, speaker === 'Me' ? 1 : 0);
  view.setUint8(1, langBytes.length);
  new Uint8Array(buf, 2, langBytes.length).set(langBytes);
  for (let i = 0; i < samples.length; i++) {
    view.setFloat32(headerLen + i * 4, samples[i], true);
  }
  return buf;
}

export class LiveTranscriptionClient {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private micProcessor: ScriptProcessorNode | null = null;
  private systemProcessor: ScriptProcessorNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private systemSource: MediaStreamAudioSourceNode | null = null;
  private micSilencer: GainNode | null = null;
  private systemSilencer: GainNode | null = null;
  private micChunker = new ChunkAccumulator();
  private systemChunker = new ChunkAccumulator();
  private paused = false;
  private stopped = false;
  private language = 'auto';
  private engine: LiveEngine = 'local';
  private captureId: string | null = null;
  private callbacks: LiveTranscriptionCallbacks;

  constructor(callbacks: LiveTranscriptionCallbacks) {
    this.callbacks = callbacks;
  }

  start(micStream: MediaStream | null, systemStream: MediaStream | null, language: string, engine: LiveEngine = 'local', captureId: string | null = null): void {
    this.language = language;
    this.engine = engine;
    this.captureId = captureId;
    this.stopped = false;
    this.paused = false;
    this.callbacks.onStatusChange('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/live-transcribe`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.stopped) { ws.close(); return; }
      if (this.engine !== 'local') {
        ws.send(JSON.stringify({ type: 'config', engine: this.engine }));
      }
      if (this.captureId) {
        ws.send(JSON.stringify({ type: 'attach-capture', captureId: this.captureId, language: this.language }));
      }
      this.callbacks.onStatusChange('listening');
      this.attachAudio(micStream, systemStream);
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'transcript' && typeof msg.text === 'string') {
          this.callbacks.onTranscript(msg.speaker === 'Me' ? 'Me' : 'Them', msg.text);
        } else if (msg.type === 'error') {
          this.callbacks.onError(msg.message || 'Live transcription error');
          this.callbacks.onStatusChange('interrupted');
        } else if (msg.type === 'warning') {
          this.callbacks.onWarning(msg.message || 'Warning');
        }
      } catch {
        // ignore malformed message
      }
    };

    ws.onerror = () => {
      if (!this.stopped) {
        this.callbacks.onError('Live transcription connection failed');
        this.callbacks.onStatusChange('interrupted');
      }
    };

    if (!micStream || micStream.getAudioTracks().length === 0) {
      this.callbacks.onMicUnavailable();
    }
  }

  private attachAudio(micStream: MediaStream | null, systemStream: MediaStream | null): void {
    const audioCtx = new AudioContext();
    this.audioCtx = audioCtx;

    // AUG-113: with a server capture the Them side is fed server-side — no browser tap.
    if (!this.captureId && systemStream && systemStream.getAudioTracks().length > 0) {
      try {
        const source = audioCtx.createMediaStreamSource(systemStream);
        const processor = audioCtx.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
        processor.onaudioprocess = (e) => {
          if (this.paused || this.stopped) return;
          const input = resampleTo16k(e.inputBuffer.getChannelData(0), audioCtx.sampleRate);
          this.systemChunker.feed(input, (chunk) => this.sendChunk('Them', chunk));
        };
        // ScriptProcessorNode only fires reliably once it's part of a graph
        // that reaches the destination; route through a silent gain node so
        // nothing is actually played back (avoids echo/feedback).
        const silencer = audioCtx.createGain();
        silencer.gain.value = 0;
        source.connect(processor);
        processor.connect(silencer);
        silencer.connect(audioCtx.destination);
        this.systemSource = source;
        this.systemProcessor = processor;
        this.systemSilencer = silencer;
      } catch {
        // System audio tap failed — Them side simply produces no lines.
      }
    }

    if (micStream && micStream.getAudioTracks().length > 0) {
      try {
        const source = audioCtx.createMediaStreamSource(micStream);
        const processor = audioCtx.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
        processor.onaudioprocess = (e) => {
          if (this.paused || this.stopped) return;
          const input = resampleTo16k(e.inputBuffer.getChannelData(0), audioCtx.sampleRate);
          this.micChunker.feed(input, (chunk) => this.sendChunk('Me', chunk));
        };
        const silencer = audioCtx.createGain();
        silencer.gain.value = 0;
        source.connect(processor);
        processor.connect(silencer);
        silencer.connect(audioCtx.destination);
        this.micSource = source;
        this.micProcessor = processor;
        this.micSilencer = silencer;
      } catch {
        this.callbacks.onMicUnavailable();
      }
    }
  }

  private sendChunk(speaker: Speaker, samples: Float32Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.paused || this.stopped) return;
    this.ws.send(encodeChunkMessage(speaker, this.language, samples));
  }

  pause(): void {
    this.paused = true;
    this.callbacks.onStatusChange('paused');
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'pause' }));
    }
  }

  resume(): void {
    this.paused = false;
    this.callbacks.onStatusChange('listening');
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resume' }));
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'stop' }));
      }
      this.ws.close();
      this.ws = null;
    }

    this.micProcessor?.disconnect();
    this.systemProcessor?.disconnect();
    this.micSilencer?.disconnect();
    this.systemSilencer?.disconnect();
    this.micSource?.disconnect();
    this.systemSource?.disconnect();
    this.micProcessor = null;
    this.systemProcessor = null;
    this.micSilencer = null;
    this.systemSilencer = null;
    this.micSource = null;
    this.systemSource = null;

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
    }
    this.audioCtx = null;

    this.callbacks.onStatusChange('stopped');
  }
}
