import { describe, test, expect, vi } from 'vitest';
import { detectPcmSampleFormat, resolveAudioteeSampleFormat, SAMPLE_FORMAT_PROBE_BYTES } from './pcmSampleFormat.js';

const RATE = 16000;

// Deterministic pseudo-random noise so the "speech-like" fixtures are reproducible.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;

function sine(freq: number, amplitude: number, samples: number): number[] {
  return Array.from({ length: samples }, (_, i) => amplitude * Math.sin((2 * Math.PI * freq * i) / RATE));
}

/// Three harmonics plus a little noise — closer to speech than a pure tone.
function speechLike(amplitude: number, samples: number, noise = 0.01): number[] {
  return Array.from({ length: samples }, (_, i) => {
    const t = i / RATE;
    return amplitude * (0.6 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 640 * t) + 0.1 * Math.sin(2 * Math.PI * 2400 * t)) + noise * rnd();
  });
}

function toS16le(x: number[]): Buffer {
  const buf = Buffer.alloc(x.length * 2);
  x.forEach((v, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  return buf;
}

function toF32le(x: number[]): Buffer {
  const buf = Buffer.alloc(x.length * 4);
  x.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

describe('detectPcmSampleFormat', () => {
  test('s16le 440 Hz sine → s16le', () => {
    const guess = detectPcmSampleFormat(toS16le(sine(440, 0.5, 3200)));
    expect(guess.format).toBe('s16le');
    expect(guess.confident).toBe(true);
  });

  test('f32le 440 Hz sine → f32le', () => {
    const guess = detectPcmSampleFormat(toF32le(sine(440, 0.5, 1600)));
    expect(guess.format).toBe('f32le');
    expect(guess.confident).toBe(true);
    expect(guess.zeroCrossingRate.f32le).toBeLessThan(guess.zeroCrossingRate.s16le);
  });

  test.each([0.9, 0.5, 0.1, 0.03, 0.005])('speech-like s16le at amplitude %s → s16le', (amp) => {
    expect(detectPcmSampleFormat(toS16le(speechLike(amp, 3200))).format).toBe('s16le');
  });

  test.each([0.9, 0.5, 0.1, 0.03, 0.005])('speech-like f32le at amplitude %s → f32le', (amp) => {
    expect(detectPcmSampleFormat(toF32le(speechLike(amp, 1600))).format).toBe('f32le');
  });

  test('silent buffer falls back to s16le without throwing and is not confident', () => {
    const guess = detectPcmSampleFormat(Buffer.alloc(SAMPLE_FORMAT_PROBE_BYTES));
    expect(guess.format).toBe('s16le');
    expect(guess.confident).toBe(false);
    expect(guess.reason).toMatch(/silent/);
  });

  test('empty and tiny buffers → s16le, not confident, no throw', () => {
    for (const buf of [Buffer.alloc(0), Buffer.alloc(7), Buffer.alloc(200)]) {
      const guess = detectPcmSampleFormat(buf);
      expect(guess.format).toBe('s16le');
      expect(guess.confident).toBe(false);
    }
  });

  test('odd-length buffer is truncated to whole samples, not rejected', () => {
    const buf = Buffer.concat([toS16le(sine(440, 0.5, 3200)), Buffer.from([1, 2, 3])]);
    expect(detectPcmSampleFormat(buf).format).toBe('s16le');
    const fbuf = Buffer.concat([toF32le(sine(440, 0.5, 1600)), Buffer.from([1])]);
    expect(detectPcmSampleFormat(fbuf).format).toBe('f32le');
  });
});

describe('resolveAudioteeSampleFormat', () => {
  test('override skips the probe and is echoed back', async () => {
    const readSample = vi.fn(async () => toF32le(sine(440, 0.5, 1600)));
    const resolved = await resolveAudioteeSampleFormat('f32le', readSample);
    expect(readSample).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({ sampleFormat: 'f32le', sampleFormatSource: 'override' });
  });

  test('detects f32le from a probed sample', async () => {
    const resolved = await resolveAudioteeSampleFormat(null, async () => toF32le(sine(440, 0.5, 1600)));
    expect(resolved).toMatchObject({ sampleFormat: 'f32le', sampleFormatSource: 'detected' });
  });

  test('detects s16le from a probed sample', async () => {
    const resolved = await resolveAudioteeSampleFormat(null, async () => toS16le(sine(440, 0.5, 3200)));
    expect(resolved).toMatchObject({ sampleFormat: 's16le', sampleFormatSource: 'detected' });
  });

  test('silent probe → s16le fallback', async () => {
    const resolved = await resolveAudioteeSampleFormat(null, async () => Buffer.alloc(SAMPLE_FORMAT_PROBE_BYTES));
    expect(resolved).toMatchObject({ sampleFormat: 's16le', sampleFormatSource: 'fallback' });
  });

  test('throwing probe → s16le fallback with the error in detail', async () => {
    const resolved = await resolveAudioteeSampleFormat(null, async () => { throw new Error('spawn ENOENT'); });
    expect(resolved).toMatchObject({ sampleFormat: 's16le', sampleFormatSource: 'fallback' });
    expect(resolved.detail).toContain('spawn ENOENT');
  });
});
