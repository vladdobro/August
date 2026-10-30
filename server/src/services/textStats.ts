import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import type { SemanticFlag, TranscriptSegment, TranscriptionLanguage } from '../types.js';

/// AUG-163 layer 1 (research L1+L2, @project-context/transcription/semantic-confidence-research): cheap, model-free text
/// statistics per whisper segment — loops, out-of-vocabulary share, stop-word share, wrong alphabet, speech rate and
/// token-probability dips. Pure functions; the only I/O is the lazily loaded word lists in server/assets/wordlists.

// Do not retune without re-validating on reference sessions (AUG-163).
export const TEXT_STATS = Object.freeze({
  loopCompressionRatio: 2.4, // whisper's own compression_ratio_threshold
  loopNeighbourJaccard: 0.6, // + window(prev+this) ratio > loopCompressionRatio counts as a cross-segment loop
  minWordsForRatios: 5, // oov / stop-word ratios need at least this many words
  oovMax: 0.45,
  stopWordMin: 0.08,
  stopWordMax: 0.8,
  minWordsForStopWords: 8,
  scriptMismatchMin: 0.6, // share of letters in the other alphabet when the session language is ru or en
  maxWordsPerSec: 6.5, // with >= 4 words and >= 1 s
  minWordsPerSec: 0.4, // only for segments >= 10 s
  dipProb: 0.05, // token p below this ...
  dipContrast: -2.5, // ... and ln p this far below the mean ln p of its +-3 neighbours
  dipMinCount: 2,
  dipMinShare: 0.1,
} as const);

export interface SegmentTextStats {
  flags: SemanticFlag[];
  compressionRatio: number;
  oovRatio: number | null;
  stopWordRatio: number | null;
  wordsPerSec: number | null;
  tokenDips: number;
}

type WordScript = 'cyrillic' | 'latin' | 'other';
type WordListLang = 'en' | 'ru';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/// src/services/*.ts (tsx) and dist/services/*.js both sit two levels below the server root.
const serverRoot = path.resolve(__dirname, '..', '..');

let wordLists: Partial<Record<WordListLang, Set<string>>> = {};

export function loadWordList(lang: WordListLang): Set<string> {
  const cached = wordLists[lang];
  if (cached) return cached;
  let set: Set<string>;
  try {
    const raw = fs.readFileSync(path.join(serverRoot, 'assets', 'wordlists', `${lang}.txt`), 'utf8');
    set = new Set(raw.split(/\r?\n/).map((w) => w.trim()).filter(Boolean));
  } catch {
    console.warn(`[textStats] word list ${lang}.txt missing; out-of-vocabulary check disabled for ${lang}`);
    set = new Set();
  }
  wordLists[lang] = set;
  return set;
}

/// Tests inject small lists here; null resets to lazy loading from disk.
export function setWordListsForTest(lists: { en: Set<string>; ru: Set<string> } | null): void {
  wordLists = lists ? { en: lists.en, ru: lists.ru } : {};
}

export function tokenizeWords(text: string): string[] {
  return text.toLowerCase().replace(/ё/g, 'е').match(/\p{L}+(?:['’-]\p{L}+)*/gu) ?? [];
}

export function compressionRatio(text: string): number {
  if (!text) return 0;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length === 0) return 0;
  return bytes.length / zlib.deflateSync(bytes).length;
}

export function scriptOf(word: string): WordScript {
  if (/\p{Script=Cyrillic}/u.test(word)) return 'cyrillic';
  if (/\p{Script=Latin}/u.test(word)) return 'latin';
  return 'other';
}

/// Share of words (length >= 2, Cyrillic or Latin) missing from the matching language list; null when too few words
/// were countable or the lists are unavailable.
export function oovRatio(words: string[]): number | null {
  let counted = 0;
  let oov = 0;
  for (const word of words) {
    if (word.length < 2) continue;
    const script = scriptOf(word);
    if (script === 'other') continue;
    const list = loadWordList(script === 'cyrillic' ? 'ru' : 'en');
    if (list.size === 0) continue;
    counted += 1;
    if (!list.has(word)) oov += 1;
  }
  if (counted < TEXT_STATS.minWordsForRatios) return null;
  return oov / counted;
}

export const STOP_WORDS_RU: ReadonlySet<string> = new Set((
  'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это вообще просто очень'
).split(' '));

export const STOP_WORDS_EN: ReadonlySet<string> = new Set((
  'the a an and or but if then so of to in on at by for with from as is are was were be been being am do does did have has had i you he she it we they me him her us them my your his its our their this that these those there here what which who whom whose when where why how not no yes just very can could will would shall should may might must about into over under up down out off again also than too only own same such both each few more most other some any all nor s t don now oh okay ok yeah well like know think going get got'
).split(' '));

/// Share of stop words; the language is the majority script of the words. null when fewer than minWordsForStopWords words.
export function stopWordRatio(words: string[]): number | null {
  if (words.length < TEXT_STATS.minWordsForStopWords) return null;
  let cyr = 0;
  let lat = 0;
  for (const word of words) {
    const script = scriptOf(word);
    if (script === 'cyrillic') cyr += 1;
    else if (script === 'latin') lat += 1;
  }
  if (cyr === 0 && lat === 0) return null;
  const list = cyr >= lat ? STOP_WORDS_RU : STOP_WORDS_EN;
  let hits = 0;
  for (const word of words) if (list.has(word)) hits += 1;
  return hits / words.length;
}

/// Share of letters in the "other" alphabet (Latin for ru, Cyrillic for en) among Cyrillic+Latin letters. 0 for 'auto'
/// or fewer than 10 such letters. Russian speech legitimately contains Latin brand names, so only the share flags.
export function scriptMismatch(text: string, language: TranscriptionLanguage): number {
  if (language === 'auto') return 0;
  let cyr = 0;
  let lat = 0;
  for (const ch of text) {
    if (/\p{Script=Cyrillic}/u.test(ch)) cyr += 1;
    else if (/\p{Script=Latin}/u.test(ch)) lat += 1;
  }
  const total = cyr + lat;
  if (total < 10) return 0;
  return (language === 'ru' ? lat : cyr) / total;
}

/// Count of tokens whose p is below dipProb and far below the mean ln p of their +-3 neighbours.
export function tokenDips(tokenProbs?: number[]): number {
  if (!tokenProbs || tokenProbs.length === 0) return 0;
  const ln = tokenProbs.map((p) => Math.log(Math.min(1, Math.max(1e-9, p))));
  let dips = 0;
  for (let i = 0; i < tokenProbs.length; i++) {
    if (!(tokenProbs[i] < TEXT_STATS.dipProb)) continue;
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(tokenProbs.length - 1, i + 3); j++) {
      if (j === i) continue;
      sum += ln[j];
      count += 1;
    }
    if (count < 2) continue;
    if (ln[i] - sum / count < TEXT_STATS.dipContrast) dips += 1;
  }
  return dips;
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

export function analyzeSegments(tracks: TranscriptSegment[][], language: TranscriptionLanguage): SegmentTextStats[][] {
  return tracks.map((track) => track.map((seg, i) => {
    const text = (seg.text ?? '').trim();
    if (!text) {
      return { flags: [], compressionRatio: 0, oovRatio: null, stopWordRatio: null, wordsPerSec: null, tokenDips: 0 };
    }
    const words = tokenizeWords(text);
    const ratio = compressionRatio(text);
    const flags: SemanticFlag[] = [];

    let loop = ratio > TEXT_STATS.loopCompressionRatio;
    const prev = i > 0 ? track[i - 1] : undefined;
    if (!loop && prev && words.length >= 3) {
      const prevText = (prev.text ?? '').trim();
      if (prevText && jaccard(tokenizeWords(prevText), words) >= TEXT_STATS.loopNeighbourJaccard) {
        loop = compressionRatio(`${prevText} ${text}`) > TEXT_STATS.loopCompressionRatio;
      }
    }
    if (loop) flags.push('loop');

    const oov = oovRatio(words);
    if (oov !== null && oov > TEXT_STATS.oovMax) flags.push('oov');

    const stop = stopWordRatio(words);
    if (stop !== null && (stop < TEXT_STATS.stopWordMin || stop > TEXT_STATS.stopWordMax)) flags.push('stopwords');

    if (scriptMismatch(text, language) >= TEXT_STATS.scriptMismatchMin) flags.push('script');

    const dur = seg.end - seg.start;
    const wps = dur > 0 ? words.length / dur : null;
    if (
      (words.length >= 4 && dur >= 1 && wps !== null && wps > TEXT_STATS.maxWordsPerSec) ||
      (dur >= 10 && wps !== null && wps < TEXT_STATS.minWordsPerSec)
    ) flags.push('rate');

    const dips = tokenDips(seg.tokenProbs);
    const n = seg.tokenProbs?.length ?? 0;
    if (n > 0 && dips >= TEXT_STATS.dipMinCount && dips / n >= TEXT_STATS.dipMinShare) flags.push('token-dip');

    return { flags, compressionRatio: ratio, oovRatio: oov, stopWordRatio: stop, wordsPerSec: wps, tokenDips: dips };
  }));
}
