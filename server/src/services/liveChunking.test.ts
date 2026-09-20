import { describe, test, expect } from 'vitest';
import { ChunkAccumulator, LivePcmFeeder, parseLiveControlFrame, CHUNK_SAMPLES, OVERLAP_SAMPLES, SAMPLE_RATE } from './liveChunking.js';

function sine(samples: number, amplitude = 0.5, freq = 440): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  return out;
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
