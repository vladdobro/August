import { describe, expect, it } from 'vitest';

import { acceptSuggestion, flagPerplexityOutliers, gbnfLiteral, mapFlagsToUtterances } from './semanticCheck.js';

describe('semanticCheck (AUG-163)', () => {
  it('flags perplexity outliers above k x median', () => {
    const { flagged, median } = flagPerplexityOutliers([[50, 60, 55, 800, null], [52, 58]], 4, 5);
    expect(median).toBe(56.5);
    expect(flagged).toEqual([[false, false, false, true, false], [false, false]]);
  });

  it('flags nothing when too few segments were scored', () => {
    const { flagged, median } = flagPerplexityOutliers([[50, 5000]], 4, 5);
    expect(median).toBeNull();
    expect(flagged).toEqual([[false, false]]);
  });

  it('accepts a small fix and strips wrapping quotes and labels', () => {
    expect(acceptSuggestion('we went to the see yesterday', 'we went to the sea yesterday')).toBe('we went to the sea yesterday');
    expect(acceptSuggestion('we went to the see yesterday', '"we went to the sea yesterday"')).toBe('we went to the sea yesterday');
    expect(acceptSuggestion('we went to the see yesterday', 'Corrected: «we went to the sea yesterday»')).toBe('we went to the sea yesterday');
  });

  it('rejects added words, identical text and big rewrites', () => {
    expect(acceptSuggestion('от XL Games', 'от компании XL Games')).toBeNull();
    expect(acceptSuggestion('hello  there friend', 'hello there friend')).toBeNull();
    expect(acceptSuggestion('hello there friend', '')).toBeNull();
    expect(acceptSuggestion('the quick brown fox', 'a lazy dog')).toBeNull();
  });

  it('maps flagged segments to utterances of the same role', () => {
    const utterances = [
      { start: 0, end: 5, text: 'a', role: 'Me' },
      { start: 4, end: 9, text: 'b', role: 'Them' },
      { start: 10, end: 15, text: 'c', role: 'Me' },
    ];
    expect(mapFlagsToUtterances(utterances, [{ start: 4.5, end: 8, role: 'Them' }])).toEqual([1]);
    expect(mapFlagsToUtterances(utterances, [{ start: 4.5, end: 8, role: 'Me' }])).toEqual([0]);
    expect(mapFlagsToUtterances(utterances, [{ start: 11, end: 12, role: 'Me' }, { start: 0, end: 1, role: 'Me' }])).toEqual([0, 2]);
  });

  it('maps single-track segments without a role', () => {
    const utterances = [{ start: 0, end: 5, text: 'a' }, { start: 6, end: 9, text: 'b' }];
    expect(mapFlagsToUtterances(utterances, [{ start: 6.5, end: 7 }])).toEqual([1]);
  });

  it('escapes quotes and newlines in GBNF literals', () => {
    expect(gbnfLiteral(' say "hi"\nnow')).toBe('" say \\"hi\\" now"');
  });
});
