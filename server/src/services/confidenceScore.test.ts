import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { computeConfidence } from './confidenceScore.js';
import { setWordListsForTest, tokenizeWords } from './textStats.js';
import type { TranscriptSegment } from '../types.js';

const CLEAN_TEXTS = [
  'we talked about the budget for the next quarter',
  'then we agreed that this plan is good for us',
  'the report is ready and I will send it to you',
  'please check the numbers before the meeting today',
];

const clean = (): TranscriptSegment[] => CLEAN_TEXTS.map((text, i) => ({ start: i * 6, end: i * 6 + 6, text, avgLogProb: -0.2 }));

beforeAll(() => {
  const words = new Set(CLEAN_TEXTS.flatMap((t) => tokenizeWords(t)));
  setWordListsForTest({ en: words, ru: new Set() });
});
afterAll(() => setWordListsForTest(null));

describe('computeConfidence (AUG-152 + AUG-163)', () => {
  it('keeps a clean, fully covered input at 100 with no semantic penalty', () => {
    const r = computeConfidence({ tracks: [clean()], dropped: 0, audioDurationSec: 24, language: 'en' });
    expect(r.score).toBe(100);
    expect(r.detail.acousticScore).toBe(100);
    expect(r.detail.semantic?.penalty).toBe(0);
    expect(r.detail.semantic?.segments).toEqual([]);
  });

  it('lowers the score for a loop segment and records it', () => {
    const tracks = clean();
    tracks[1] = { ...tracks[1], text: 'the report. the report. the report. the report. the report. the report.' };
    const r = computeConfidence({ tracks: [tracks], dropped: 0, audioDurationSec: 24, language: 'en' });
    expect(r.score).toBeLessThan(100);
    expect(r.detail.semantic?.segments.some((s) => s.flags.includes('loop') && s.index === 1)).toBe(true);
  });

  it('applies the fixed per-loop penalty even when the loop is short on the timeline', () => {
    const tracks = clean().map((s) => ({ ...s, start: s.start * 10, end: s.end * 10 }));
    tracks[1] = { ...tracks[1], end: tracks[1].start + 1, text: 'the report. the report. the report. the report. the report. the report.' };
    const r = computeConfidence({ tracks: [tracks], dropped: 0, audioDurationSec: 0, language: 'en' });
    expect(r.detail.semantic?.loops).toBe(1);
    expect(r.score).toBeLessThanOrEqual(85);
  });

  it('penalises a session whose median perplexity is above the ceiling', () => {
    const base = { tracks: [clean()], dropped: 0, audioDurationSec: 24, language: 'en' as const };
    const summary = { model: 'm', k: 4, scored: 30, skipped: 0, ms: 1 };
    const ok = computeConfidence({ ...base, perplexity: { perTrack: [], flagged: [], summary: { ...summary, medianPpl: 150 } } });
    const bad = computeConfidence({ ...base, perplexity: { perTrack: [], flagged: [], summary: { ...summary, medianPpl: 1027 } } });
    const few = computeConfidence({ ...base, perplexity: { perTrack: [], flagged: [], summary: { ...summary, medianPpl: 1027, scored: 3 } } });
    expect(ok.score).toBe(100);
    expect(bad.detail.semantic?.pplCeilingHit).toBe(true);
    expect(bad.score).toBe(75);
    expect(few.score).toBe(100);
  });

  it('lowers the score for perplexity-flagged segments', () => {
    const r = computeConfidence({
      tracks: [clean()],
      dropped: 0,
      audioDurationSec: 24,
      language: 'en',
      perplexity: { perTrack: [[10, 900, 10, 10]], flagged: [[false, true, false, false]] },
    });
    expect(r.score).toBeLessThan(100);
    expect(r.detail.semantic?.segments[0].flags).toEqual(['perplexity']);
    expect(r.detail.semantic?.segments[0].perplexity).toBe(900);
  });

  it('never exceeds the acoustic score', () => {
    const noisy = clean().map((s) => ({ ...s, avgLogProb: -1.5 }));
    const inputs = [
      { tracks: [clean()], dropped: 0, audioDurationSec: 24 },
      { tracks: [noisy], dropped: 2, audioDurationSec: 60 },
      {
        tracks: [clean(), noisy],
        dropped: 1,
        audioDurationSec: 24,
        perplexity: { perTrack: [[1, 1, 1, 1], [1, 1, 1, 1]], flagged: [[true, true, true, true], [false, true, false, true]] },
      },
    ];
    for (const input of inputs) {
      const r = computeConfidence({ ...input, language: 'en' });
      expect(r.score).toBeLessThanOrEqual(r.detail.acousticScore as number);
    }
  });

  it('scores an empty input 0', () => {
    const r = computeConfidence({ tracks: [[]], dropped: 0, audioDurationSec: 10 });
    expect(r.score).toBe(0);
    expect(r.detail.semantic).toBeUndefined();
  });
});
