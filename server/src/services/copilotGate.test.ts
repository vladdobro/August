import { describe, expect, test } from 'vitest';

import {
  CopilotLimiter,
  buildExplainMessage,
  buildKeywords,
  gateFire,
  parseCopilotAnswer,
  parseSearchResult,
  parseTaskResult,
  routeFromPath,
} from './copilotGate.js';

// Support Weekly ac0169f7 (names anonymised), findings AUG-196 §1.
// The card says "15 true references"; the findings list 17 fires of which 3 are false -> 14 true. The 14 are tested.
const TRUE_REFERENCES = [
  'Потому что когда мы говорили, что ты искал историю, когда ты нашел трюку в агенте,',
  'И договорились, что надо все подсобрать и как раз таки сделать уже нормальную систему.',
  'И более того, мы в прошлый раз обсуждали, что у CSM из их live-чатов, у них тоже должна быть кнопка "Эскалировать тикет вол2".',
  'Если кто-то идет на конфликт то мы создаем для него отдельного чат-бота по прецеденту то есть сразу это не делаем но если кто-то прям очень хочет тогда сделаем кстати у нас с тобой был не закрытый вопросик, мы обсуждали',
  'Мы с тобой обсуждали, что',
  'Мы с тобой обсуждали, как эти вещи друг с другом взаимодействуют.',
  'Либо, как мы обсуждали, он может пойти немножко хитрым путем, сказать, а вы уже создали через виджет тикет.',
  'И мы там внутри с тобой обсуждали, что может быть где-то здесь еще нужен Telegram-бот.',
  'А, еще мы с вами договорились, что мы соберем в кучу вот эти все тарифы по мосте с лимитами, но это уже, наверное, не я буду делать.',
  'ты немножко путаешься, потому что мы с тобой говорили, что L1 туда засовывать нельзя пока.',
  'Вот, у нас мы обсуждали ряд отж-кейсов, что может быть какие-то группы в телеграмке, но мы решили, что по умолчанию мы говорим так.',
  'У нас отделяет то, чтобы у нас заработал в чатах с Ноном тот самый ботик, про который мы обсуждали, который Анна запустит.',
  'Мы на прошлой встрече смотрели на цифры.',
  'Верить им, как мы в тот раз решили, особо нельзя.',
];

const FALSE_REFERENCES = [
  'Я вот это договорил, а потом спросил.',
  'Я не договорила, у меня нет готового решения, то есть мне кажется, важно, чтобы возвращался сам техсаб.',
  'Ну да, если договорились, но это действительно тогда,',
];

const GAME_VIDEO = [
  'Привет, котовчане!',
  'Точно.',
  'Зандалары, драктиры, наги.',
  'Или же есть Сирус.',
  'И обязательно загляните в дискорд проекта, туда падает вся актуальная информация по мирам.',
  'Какао из этой истории просто выходит.',
  'Собственно, давайте поговорим про вот эту самую вторую.',
  'И я не знаю, но это просто минус половина баллов вот просто сходу.',
  'Отдельный разговор.',
  'Понятно, откуда Близзы подсмотрели расу для Вафарева.',
  'Скверна, трупы, брошенные доспехи, которые вроде как полуожили.',
  'Можно вот бочечки попинать, физика у них веселая.',
  'Опять же вот эта тема, что вот в Геншине за похожие собирашки растет выносливость.',
  'И что интересно, по крайней мере по первому тому же пиратскому данжу, видно, что разработчики пытались сделать что-то в духе, ну, наверное, Элден Ринга.',
  'Крафт примитивный, и при этом без фарма мобов в нем ты ничего не сделаешь.',
  'Опять же, если бы не глайдер, от аркейджа в этой игре было бы еще меньше.',
  'В PvP это реально решало, то есть глайдер был частью боя.',
  'Базовая атака, сильная атака, вот это вот знаете, ЛКМ, ЛКМ, ПКМ, потом зажал право еще раз ПКМ.',
  'Надо ли менять эти оружия прямо в бою или минмаксить какое-то одно, на 10 уровне пока непонятно.',
  'Возможно, дело привычки, но я, в принципе, небольшой фанат прям кастеров.',
  'Потом я пошел в ПВП.',
  'Но тем не менее, мне даже было весело.',
  'Из приятного есть еще простой стелс.',
  'Ни домов, ни торговли, ни поковозки, ничего не было, был один регион, и то явно урезанный частично.',
  'А это, как правило, ускорители, там слоты, всякий премиум, без которого всё копится заметно медленнее.',
  'Archeage Chronicles это объективно не самое плохое, во что я играл.',
  'Бой приятный, но веет какой-то стариной, что ли, вот с этими вот комбинациями ЛКМ, ПКМ.',
  'Таким людям, скорее всего, надо ждать именно ArcheAge S.',
];

describe('gateFire', () => {
  test.each(TRUE_REFERENCES)('fires on a true reference: %s', (line) => {
    expect(gateFire(line)).toEqual({ rule: 'trigger' });
  });

  test.each(FALSE_REFERENCES)('stays silent on: %s', (line) => {
    expect(gateFire(line)).toBeNull();
  });

  test('0 fires on the game-video sample', () => {
    for (const line of GAME_VIDEO) expect(gateFire(line), line).toBeNull();
  });

  test('English triggers', () => {
    for (const line of ['As discussed, the export stays', 'We agreed to ship it Friday', 'last time we said', 'remember when we picked Groq']) {
      expect(gateFire(line), line).toEqual({ rule: 'trigger' });
    }
  });

  test('task id fires with rule taskid', () => {
    expect(gateFire('Check CRM-207 please')).toEqual({ rule: 'taskid' });
  });

  test('no Latin-capitalised or quoted rule', () => {
    expect(gateFire('Slack is down')).toBeNull();
    expect(gateFire('The «Ticket» button')).toBeNull();
  });

  test('conditional exclusion only applies to the договор- rule', () => {
    expect(gateFire('если договорились')).toBeNull();
    expect(gateFire('если договорились, помнишь что было')).toEqual({ rule: 'trigger' });
    expect(gateFire('мы договорились')).toEqual({ rule: 'trigger' });
  });
});

describe('buildKeywords', () => {
  test('task id first, then lexicon, then content words, at most 4', () => {
    const kws = buildKeywords(['Помнишь, мы обсуждали livefeed', 'это было в AUG-197 про copilot'], ['livefeed', 'copilot', 'praxis']);
    expect(kws[0]).toBe('AUG-197');
    expect(kws).toContain('livefeed');
    expect(kws).toContain('copilot');
    expect(kws.length).toBeLessThanOrEqual(4);
  });

  test('lexicon fuzzy match: livefeeed ~ livefeed (edit distance 1)', () => {
    expect(buildKeywords(['we looked at livefeeed yesterday'], ['livefeed'])).toContain('livefeed');
  });

  test('short tokens need an exact lexicon match', () => {
    expect(buildKeywords(['слушай bot'], ['bots'])).not.toContain('bots');
  });

  test('multi-word lexicon terms match by substring', () => {
    expect(buildKeywords(['обсуждали action items вчера'], ['action items'])).toContain('action items');
  });

  test('stopwords and trigger words are dropped, longer recent words win', () => {
    const kws = buildKeywords(['мы договорились про эскалацию тикетов'], []);
    expect(kws).not.toContain('договорились');
    expect(kws).not.toContain('про');
    expect(kws.length).toBeLessThanOrEqual(2);
    expect(kws).toContain('эскалацию');
  });

  test('empty when nothing useful', () => {
    expect(buildKeywords(['мы договорились'], [])).toEqual([]);
  });
});

describe('parseSearchResult', () => {
  const sample = [
    'project-context/ai-assistants/README.md [exact]',
    'L3: The copilot shows hints from project notes.',
    'L9: Always-on mode is limited by a budget.',
    '',
    'project-context/transcription/live-transcription/README.md [partial, missing: copilot]',
    'L12: Live feed is shared.',
  ].join('\n');

  test('parses headers, kinds and lines', () => {
    const blocks = parseSearchResult(sample);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      path: 'project-context/ai-assistants/README.md',
      route: 'ai-assistants',
      kind: 'exact',
      lines: [
        { n: 3, text: 'The copilot shows hints from project notes.' },
        { n: 9, text: 'Always-on mode is limited by a budget.' },
      ],
    });
    expect(blocks[1].kind).toBe('partial');
    expect(blocks[1].route).toBe('transcription/live-transcription');
  });

  test('cuts line text to 160 chars and ignores noise', () => {
    const blocks = parseSearchResult(`x/README.md [exact]\nL1: ${'a'.repeat(300)}\nNo results`);
    expect(blocks[0].lines[0].text).toHaveLength(160);
    expect(parseSearchResult('Nothing found.')).toEqual([]);
  });

  test('routeFromPath', () => {
    expect(routeFromPath('project-context/support/inbox/README.md')).toBe('support/inbox');
    expect(routeFromPath('project-context\\support\\README.md')).toBe('support');
  });
});

describe('parseTaskResult', () => {
  test('parses id, short id and title', () => {
    const hits = parseTaskResult('#AUG-197-5ousfp [AUG-197] Implement Meeting Copilot: engine [in_progress]\nNo tasks found');
    expect(hits).toEqual([{ id: 'AUG-197-5ousfp', shortId: 'AUG-197', title: 'Implement Meeting Copilot: engine' }]);
  });

  test('ignores non-matching lines', () => {
    expect(parseTaskResult('No tasks found')).toEqual([]);
  });
});

describe('parseCopilotAnswer', () => {
  test('match', () => {
    expect(parseCopilotAnswer('{"verdict":"match","text":"Agreed to ship Friday.","source":"support/inbox"}')).toEqual({
      verdict: 'match',
      text: 'Agreed to ship Friday.',
      source: 'support/inbox',
    });
  });

  test('none, with surrounding text', () => {
    expect(parseCopilotAnswer('Sure: {"verdict":"none"} done')).toEqual({ verdict: 'none' });
  });

  test('garbage is null', () => {
    expect(parseCopilotAnswer('no json here')).toBeNull();
    expect(parseCopilotAnswer('{"verdict":"maybe"}')).toBeNull();
    expect(parseCopilotAnswer('{"verdict":"match","text":"","source":"x"}')).toBeNull();
    expect(parseCopilotAnswer('{"verdict":"match","text":"t"}')).toBeNull();
  });

  test('text cut to 160, source to 120', () => {
    const a = parseCopilotAnswer(JSON.stringify({ verdict: 'match', text: 'x'.repeat(400), source: 's'.repeat(300) }));
    expect(a && a.verdict === 'match' && a.text.length).toBe(160);
    expect(a && a.verdict === 'match' && a.source.length).toBe(120);
  });
});

describe('CopilotLimiter', () => {
  test('20 s between searches', () => {
    const l = new CopilotLimiter();
    expect(l.canSearch(1000)).toBe(true);
    l.markSearch(1000);
    expect(l.canSearch(20_999)).toBe(false);
    expect(l.canSearch(21_000)).toBe(true);
  });

  test('one card per route per 5 minutes', () => {
    const l = new CopilotLimiter();
    expect(l.routeAllowed('r:a', 0)).toBe(true);
    l.markShown('r:a', 0);
    expect(l.routeAllowed('r:a', 299_999)).toBe(false);
    expect(l.routeAllowed('r:b', 1)).toBe(true);
    expect(l.routeAllowed('r:a', 300_000)).toBe(true);
  });

  test('12 Claude turns per rolling hour', () => {
    const l = new CopilotLimiter();
    for (let i = 0; i < 12; i++) {
      expect(l.canClaude(i * 1000)).toBe(true);
      l.markClaude(i * 1000);
    }
    expect(l.canClaude(13_000)).toBe(false);
    expect(l.canClaude(3_600_000)).toBe(true);
  });

  test('dedupe by route+line', () => {
    const l = new CopilotLimiter();
    expect(l.isDuplicate('a:3')).toBe(false);
    l.markLine('a:3');
    expect(l.isDuplicate('a:3')).toBe(true);
  });
});

describe('buildExplainMessage', () => {
  test('shape', () => {
    expect(buildExplainMessage(['[Me] hi'], ['x/README.md L1: t'])).toBe(
      '<trigger_lines>\n[Me] hi\n</trigger_lines>\n<candidates>\nx/README.md L1: t\n</candidates>',
    );
    expect(buildExplainMessage(['a'], [])).toContain('<candidates>\n(none)\n</candidates>');
  });
});
