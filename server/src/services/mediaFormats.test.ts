import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import {
  UPLOAD_EXTENSIONS,
  isAcceptedUploadName,
  isVideoContainer,
  classifyVideoProbe,
} from './mediaFormats.js';

describe('isAcceptedUploadName', () => {
  test.each(['a.mp4', 'a.MOV', 'meeting.Mp4', 'x.wav', 'x.m4a'])('accepts %s', (name) => {
    expect(isAcceptedUploadName(name)).toBe(true);
  });
  test.each(['a.mkv', 'a.avi', 'a.webm', 'mp4', 'a.mp4.txt'])('rejects %s', (name) => {
    expect(isAcceptedUploadName(name)).toBe(false);
  });
});

describe('isVideoContainer', () => {
  test('true for mp4/mov in any case', () => {
    expect(isVideoContainer('/x/audio.mp4')).toBe(true);
    expect(isVideoContainer('/x/clip.MOV')).toBe(true);
  });
  test('false for audio containers', () => {
    expect(isVideoContainer('/x/a.m4a')).toBe(false);
    expect(isVideoContainer('/x/a.wav')).toBe(false);
  });
});

describe('classifyVideoProbe', () => {
  test('audio stream present', () => expect(classifyVideoProbe(null, '1\n')).toBe('ok'));
  test('empty output means no audio', () => {
    expect(classifyVideoProbe(null, '')).toBe('no-audio');
    expect(classifyVideoProbe(null, '  \r\n')).toBe('no-audio');
  });
  test('error exit means unreadable', () => expect(classifyVideoProbe({ code: 1 }, '')).toBe('unreadable'));
  test('ENOENT means ffprobe missing', () => expect(classifyVideoProbe({ code: 'ENOENT' }, '')).toBe('missing-ffprobe'));
});

describe('client mirror', () => {
  test('ACCEPTED_EXTENSIONS in FileUpload.tsx equals UPLOAD_EXTENSIONS', () => {
    const src = fs.readFileSync(new URL('../../../client/src/components/FileUpload.tsx', import.meta.url), 'utf8');
    const match = /ACCEPTED_EXTENSIONS = \[([^\]]*)\]/.exec(src);
    expect(match).not.toBeNull();
    const items = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(items).toEqual([...UPLOAD_EXTENSIONS]);
  });
});
