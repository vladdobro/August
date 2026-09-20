import { describe, test, expect } from 'vitest';
import { parseWasapiProbe } from './wasapiHelper.js';

const LINE = '{"sampleRate":44100,"channels":2,"format":"f32le","bitsPerSample":32,"device":"\\u041d\\u0430\\u0443\\u0448\\u043d\\u0438\\u043a\\u0438 (MONITOR III A.N.C. Stereo)"}';

describe('parseWasapiProbe', () => {
  test('parses the helper line and decodes \\u escapes in the device name', () => {
    expect(parseWasapiProbe(`${LINE}\n`)).toEqual({
      sampleRate: 44100,
      channels: 2,
      format: 'f32le',
      bitsPerSample: 32,
      device: 'Наушники (MONITOR III A.N.C. Stereo)',
    });
  });

  test('ignores leading non-JSON lines', () => {
    expect(parseWasapiProbe(`noise\n${LINE}`)?.sampleRate).toBe(44100);
  });

  test('rejects invalid JSON, unknown format, and missing fields', () => {
    expect(parseWasapiProbe('{not json')).toBeNull();
    expect(parseWasapiProbe('{"sampleRate":48000,"channels":2,"format":"mp3","bitsPerSample":16,"device":"x"}')).toBeNull();
    expect(parseWasapiProbe('{"sampleRate":48000,"channels":2,"format":"s16le"}')).toBeNull();
    expect(parseWasapiProbe('')).toBeNull();
  });
});
