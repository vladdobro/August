import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyzeSegments, compressionRatio, setWordListsForTest, tokenDips, TEXT_STATS } from './textStats.js';
import type { TranscriptSegment } from '../types.js';

const EN_WORDS = 'we talked about the budget for the next quarter and then agreed that this plan is good the report is ready please send it to me today'.split(' ');
const RU_WORDS = 'мы обсудили бюджет на третий квартал и решили что план хороший это очень важно для всех нас сегодня'.split(' ');

const seg = (text: string, start = 0, end = 6, extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({ start, end, text, ...extra });

beforeAll(() => setWordListsForTest({ en: new Set(EN_WORDS), ru: new Set(RU_WORDS) }));
afterAll(() => setWordListsForTest(null));

describe('textStats (AUG-163)', () => {
  it('flags a repeated-phrase loop', () => {
    const text = 'the report. the report. the report. the report. the report. the report.';
    expect(compressionRatio(text)).toBeGreaterThan(TEXT_STATS.loopCompressionRatio);
    const [[stats]] = analyzeSegments([[seg(text)]], 'en');
    expect(stats.flags).toContain('loop');
  });

  it('flags transliterated Russian as wrong alphabet and out-of-vocabulary', () => {
    const [[stats]] = analyzeSegments([[seg('Ny obsudili budzhet na tretiy kvartal shto takoe segodnya', 0, 6)]], 'ru');
    expect(stats.flags).toContain('script');
    expect(stats.flags).toContain('oov');
  });

  it('does not flag normal speech', () => {
    const ru = seg('мы обсудили бюджет на третий квартал и решили что план хороший', 0, 6);
    const en = seg('we talked about the budget for the next quarter and then agreed that this plan is good', 6, 12);
    const [ruStats] = analyzeSegments([[ru]], 'ru');
    const [enStats] = analyzeSegments([[en]], 'en');
    expect(ruStats[0].flags).toEqual([]);
    expect(enStats[0].flags).toEqual([]);
  });

  it('counts token dips', () => {
    expect(tokenDips([0.9, 0.9, 0.9, 0.01, 0.9, 0.9, 0.9, 0.02, 0.9, 0.9])).toBe(2);
    expect(tokenDips([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9])).toBe(0);
    expect(tokenDips(undefined)).toBe(0);
  });

  it('flags an impossible speech rate', () => {
    const words = Array.from({ length: 30 }, () => 'good').join(' ');
    const [[stats]] = analyzeSegments([[seg(words, 0, 2)]], 'en');
    expect(stats.flags).toContain('rate');
  });
});
