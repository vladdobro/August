import { describe, test, expect } from 'vitest';
import {
  normalize,
  isHallucination,
  stripCreditHallucination,
  FILLER_ONLY_TEXTS,
  dedupHallucinations,
  mergeSingleStream,
} from './transcriptMerger.js';

describe('stripCreditHallucination', () => {
  test('full credit line (exact) → [OOPS]', () => {
    expect(stripCreditHallucination('Редактор субтитров А.Семкин Корректор А.Егорова'))
      .toBe('[OOPS]');
  });

  test('full credit line with spaced initials and trailing periods → [OOPS]', () => {
    expect(stripCreditHallucination('Редактор субтитров А. Семкин. Корректор А. Егорова.'))
      .toBe('[OOPS]');
  });

  test('full credit line with commas → [OOPS]', () => {
    expect(stripCreditHallucination('Редактор субтитров А.Семкин, Корректор А.Егорова'))
      .toBe('[OOPS]');
  });

  test('first half only → [OOPS]', () => {
    expect(stripCreditHallucination('Редактор субтитров А.Семкин'))
      .toBe('[OOPS]');
  });

  test('first half with spaced initial → [OOPS]', () => {
    expect(stripCreditHallucination('Редактор субтитров А. Семкин.'))
      .toBe('[OOPS]');
  });

  test('second half only → [OOPS]', () => {
    expect(stripCreditHallucination('Корректор А.Егорова'))
      .toBe('[OOPS]');
  });

  test('second half with spaced initial → [OOPS]', () => {
    expect(stripCreditHallucination('Корректор А. Егорова.'))
      .toBe('[OOPS]');
  });

  test('credit line embedded before real speech → keeps real speech', () => {
    expect(stripCreditHallucination('Редактор субтитров А.Семкин Корректор А.Егорова Давайте начнём'))
      .toBe('[OOPS] Давайте начнём');
  });

  test('credit line embedded after real speech → keeps real speech', () => {
    expect(stripCreditHallucination('Сегодня обсудим план. Редактор субтитров А.Семкин Корректор А.Егорова'))
      .toBe('Сегодня обсудим план. [OOPS]');
  });

  test('first half embedded in real speech → replaces only the fragment', () => {
    expect(stripCreditHallucination('Привет Редактор субтитров А.Семкин мир'))
      .toBe('Привет [OOPS] мир');
  });

  test('ordinary text with "субтитры" is NOT altered', () => {
    const text = 'Обсуждаем субтитры к фильму';
    expect(stripCreditHallucination(text)).toBe(text);
  });

  test('ordinary text with "корректор" is NOT altered', () => {
    const text = 'Корректор проверил документ';
    expect(stripCreditHallucination(text)).toBe(text);
  });

  test('case-insensitive matching', () => {
    expect(stripCreditHallucination('редактор субтитров а.семкин корректор а.егорова'))
      .toBe('[OOPS]');
  });
});

describe('isHallucination — existing checks unchanged', () => {
  test('dimatorzok credit detected', () => {
    expect(isHallucination(normalize('Субтитры от dimatorzok'))).toBe(true);
  });

  test('blacklisted "thank you" detected', () => {
    expect(isHallucination('thank you')).toBe(true);
  });

  test('blacklisted "thanks for watching" detected', () => {
    expect(isHallucination('thanks for watching')).toBe(true);
  });

  test('normal text not flagged', () => {
    expect(isHallucination(normalize('Good morning everyone'))).toBe(false);
  });
});

describe('mergeSingleStream — credit line integration', () => {
  test('full credit-line segment becomes [OOPS]', () => {
    const segments = [
      { start: 0, end: 3, text: 'Hello everyone', noSpeechProb: 0.1 },
      { start: 5, end: 8, text: 'Редактор субтитров А.Семкин Корректор А.Егорова', noSpeechProb: 0.1 },
      { start: 10, end: 13, text: 'Let us continue', noSpeechProb: 0.1 },
    ];
    const result = mergeSingleStream(segments);
    const texts = result.map(u => u.text);
    expect(texts).toContain('[OOPS]');
    expect(texts).toContain('Hello everyone');
    expect(texts).toContain('Let us continue');
    expect(texts).not.toContain('Редактор субтитров А.Семкин Корректор А.Егорова');
  });

  test('embedded credit line replaced with [OOPS], real speech kept', () => {
    const segments = [
      { start: 0, end: 5, text: 'Доброе утро. Редактор субтитров А.Семкин Корректор А.Егорова', noSpeechProb: 0.1 },
    ];
    const result = mergeSingleStream(segments);
    expect(result.length).toBe(1);
    expect(result[0].text).toBe('Доброе утро. [OOPS]');
  });

  test('consecutive credit-line hallucinations are deduplicated', () => {
    const segments = [
      { start: 0, end: 3, text: 'Редактор субтитров А.Семкин Корректор А.Егорова', noSpeechProb: 0.1 },
      { start: 4, end: 7, text: 'Редактор субтитров А. Семкин. Корректор А. Егорова.', noSpeechProb: 0.1 },
      { start: 8, end: 11, text: 'Редактор субтитров А.Семкин Корректор А.Егорова', noSpeechProb: 0.1 },
    ];
    const result = mergeSingleStream(segments);
    const oopsCount = result.filter(u => u.text === '[OOPS]').length;
    expect(oopsCount).toBe(1);
  });
});

describe('live transcription path simulation', () => {
  test('full credit line passes isLikelyFiller but gets stripped to [OOPS]', () => {
    const text = 'Редактор субтитров А.Семкин Корректор А.Егорова';
    const normalized = normalize(text);
    const isFiller = normalized.length === 0 || FILLER_ONLY_TEXTS.has(normalized) || isHallucination(normalized);
    expect(isFiller).toBe(false);
    const cleaned = stripCreditHallucination(text);
    expect(cleaned).toBe('[OOPS]');
  });

  test('embedded credit in live chunk leaves real speech with [OOPS]', () => {
    const text = 'Всем привет Редактор субтитров А.Семкин';
    const cleaned = stripCreditHallucination(text);
    expect(cleaned).toBe('Всем привет [OOPS]');
    const normalized = normalize(cleaned);
    expect(normalized.length).toBeGreaterThan(0);
    expect(FILLER_ONLY_TEXTS.has(normalized)).toBe(false);
    expect(isHallucination(normalized)).toBe(false);
  });
});
