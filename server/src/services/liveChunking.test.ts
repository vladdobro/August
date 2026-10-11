import { describe, test, expect } from 'vitest';
import { ChunkAccumulator, LivePcmFeeder, parseLiveControlFrame, CHUNK_SAMPLES, OVERLAP_SAMPLES, SAMPLE_RATE, hasEnoughSpeech, speechDurationMs } from './liveChunking.js';

function sine(samples: number, amplitude = 0.5, freq = 440): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  return out;
}
/// Near-silent floor (like Chromium-noise-suppressed mic) with `bursts` of 220 Hz tone at [startSec, durSec].
function withBursts(totalSamples: number, bursts: Array<[number, number]>, amplitude = 0.1): Float32Array {
  const out = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) out[i] = 0.00005 * Math.sin(i * 0.37);
  for (const [startSec, durSec] of bursts) {
    const start = Math.round(startSec * SAMPLE_RATE);
    const end = Math.min(totalSamples, start + Math.round(durSec * SAMPLE_RATE));
    for (let i = start; i < end; i++) out[i] += amplitude * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
  }
  return out;
}
function emitted(samples: Float32Array): number {
  const acc = new ChunkAccumulator();
  let n = 0;
  acc.feed(samples, () => n++);
  return n;
}
function toS16le(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(samples[i] * 32767), i * 2);
  return buf;
}

describe('parseLiveControlFrame', () => {
  test('attach-capture with captureId and language', () => {
    expect(parseLiveControlFrame(JSON.stringify({ type: 'attach-capture', captureId: 'abc', language: 'ru' })))
      .toEqual({ type: 'attach-capture', captureId: 'abc', language: 'ru' });
  });

  test('attach-capture trims captureId and defaults language', () => {
    expect(parseLiveControlFrame(JSON.stringify({ type: 'attach-capture', captureId: '  abc  ' })))
      .toEqual({ type: 'attach-capture', captureId: 'abc', language: 'auto' });
  });

  test('attach-capture with invalid captureId returns null', () => {
    expect(parseLiveControlFrame(JSON.stringify({ type: 'attach-capture', captureId: '' }))).toBeNull();
    expect(parseLiveControlFrame(JSON.stringify({ type: 'attach-capture' }))).toBeNull();
    expect(parseLiveControlFrame(JSON.stringify({ type: 'attach-capture', captureId: 42 }))).toBeNull();
  });

  test('config frame', () => {
    expect(parseLiveControlFrame(JSON.stringify({ type: 'config', engine: 'groq' })))
      .toEqual({ type: 'config', engine: 'groq' });
    expect(parseLiveControlFrame(JSON.stringify({ type: 'config', engine: 'foo' }))).toBeNull();
  });

  test('simple control frames and invalid input', () => {
    expect(parseLiveControlFrame(JSON.stringify({ type: 'pause' }))).toEqual({ type: 'pause' });
    expect(parseLiveControlFrame(JSON.stringify({ type: 'resume' }))).toEqual({ type: 'resume' });
    expect(parseLiveControlFrame(JSON.stringify({ type: 'stop' }))).toEqual({ type: 'stop' });
    expect(parseLiveControlFrame(JSON.stringify({ type: 'nope' }))).toBeNull();
    expect(parseLiveControlFrame('not json')).toBeNull();
    expect(parseLiveControlFrame('42')).toBeNull();
  });
});

describe('ChunkAccumulator', () => {
  test('emits chunks with carried overlap', () => {
    const acc = new ChunkAccumulator();
    const chunks: Float32Array[] = [];
    const input = sine(CHUNK_SAMPLES + CHUNK_SAMPLES - OVERLAP_SAMPLES);
    acc.feed(input, (c) => chunks.push(c));
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(CHUNK_SAMPLES);
    expect(chunks[1].length).toBe(CHUNK_SAMPLES);
    expect(Array.from(chunks[1].subarray(0, OVERLAP_SAMPLES)))
      .toEqual(Array.from(chunks[0].subarray(CHUNK_SAMPLES - OVERLAP_SAMPLES)));
  });

  test('silence emits nothing', () => {
    const acc = new ChunkAccumulator();
    const chunks: Float32Array[] = [];
    acc.feed(new Float32Array(CHUNK_SAMPLES * 2), (c) => chunks.push(c));
    expect(chunks.length).toBe(0);
  });

  test('flush emits only after enough fresh audio', () => {
    const acc = new ChunkAccumulator();
    const chunks: Float32Array[] = [];
    acc.feed(sine(CHUNK_SAMPLES), (c) => chunks.push(c));
    expect(chunks.length).toBe(1);

    expect(acc.flush((c) => chunks.push(c))).toBe(false);
    expect(chunks.length).toBe(1);

    acc.feed(sine(SAMPLE_RATE), (c) => chunks.push(c));
    expect(acc.flush((c) => chunks.push(c))).toBe(true);
    expect(chunks.length).toBe(2);
    expect(chunks[1].length).toBe(SAMPLE_RATE);
  });
});

describe('speech gate', () => {
  test('silent window is dropped', () => {
    const w = new Float32Array(CHUNK_SAMPLES);
    expect(speechDurationMs(w)).toBe(0);
    expect(hasEnoughSpeech(w)).toBe(false);
    expect(emitted(w)).toBe(0);
  });

  test('transient-only window (clicks, thumps) is dropped', () => {
    const w = withBursts(CHUNK_SAMPLES, [[0.5, 0.06], [1.7, 0.06], [3.0, 0.06], [2.2, 0.12]], 0.2);
    expect(hasEnoughSpeech(w)).toBe(false);
    expect(emitted(w)).toBe(0);
  });

  test('short real utterance with a closure gap passes', () => {
    const w = withBursts(CHUNK_SAMPLES, [[1.5, 0.12], [1.68, 0.26]], 0.05);
    expect(hasEnoughSpeech(w)).toBe(true);
    expect(emitted(w)).toBe(1);
  });

  test('quiet speech below the old whole-window RMS gate passes', () => {
    const w = withBursts(CHUNK_SAMPLES, [[1.5, 1.5]], 0.012);
    expect(hasEnoughSpeech(w)).toBe(true);
    expect(emitted(w)).toBe(1);
  });

  test('normal speech passes with plenty of counted speech', () => {
    const durs = [0.3, 0.5, 0.4, 0.5, 0.3, 0.5, 0.4, 0.5];
    const bursts: Array<[number, number]> = [];
    let t = 0;
    for (const d of durs) {
      if (t + d > 4) break;
      bursts.push([t, d]);
      t += d + 0.15;
    }
    const w = withBursts(CHUNK_SAMPLES, bursts, 0.1);
    expect(hasEnoughSpeech(w)).toBe(true);
    expect(speechDurationMs(w)).toBeGreaterThanOrEqual(2000);
  });

  test('flush uses the same gate', () => {
    const acc = new ChunkAccumulator();
    let n = 0;
    // Speech only in the first 2 s, so the carried 1 s overlap is silent.
    acc.feed(withBursts(CHUNK_SAMPLES, [[0.5, 1.5]]), () => n++);
    expect(n).toBe(1);
    acc.feed(new Float32Array(SAMPLE_RATE), () => n++);
    expect(acc.flush(() => n++)).toBe(false);
    expect(n).toBe(1);
  });
});

describe('LivePcmFeeder', () => {
  test('reassembles chunks split at arbitrary byte boundaries', () => {
    const src = sine(CHUNK_SAMPLES);
    const bytes = toS16le(src);
    const chunks: Float32Array[] = [];
    const feeder = new LivePcmFeeder((c) => chunks.push(c));
    for (let off = 0; off < bytes.length; off += 4097) {
      feeder.feed(Buffer.from(bytes.subarray(off, Math.min(off + 4097, bytes.length))));
    }
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(CHUNK_SAMPLES);
    for (const i of [0, 1, 12345, CHUNK_SAMPLES - 1]) {
      expect(chunks[0][i]).toBeCloseTo(src[i], 3);
    }
  });

  test('flush behavior', () => {
    const chunks: Float32Array[] = [];
    const feeder = new LivePcmFeeder((c) => chunks.push(c));
    feeder.feed(toS16le(sine(SAMPLE_RATE)));
    expect(feeder.flush()).toBe(true);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(SAMPLE_RATE);

    const fresh = new LivePcmFeeder(() => {});
    expect(fresh.flush()).toBe(false);
  });
});
