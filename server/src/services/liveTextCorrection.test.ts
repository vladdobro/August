import { describe, expect, it, vi } from 'vitest';

import { GroqTextSkipError } from './groqText.js';
import { LiveActionItemsExtractor } from './liveActionItems.js';
import { LIVE_SETTLE_MS, LiveTextCorrector } from './liveTextCorrection.js';

const okCorrect = () => vi.fn(async () => ({ status: 'ok', corrections: new Map() }));

function makeCorrector(shouldYield: () => boolean) {
  let t = 0;
  const correct = okCorrect();
  const corrector = new LiveTextCorrector(() => {}, correct as never, () => t, shouldYield);
  corrector.add('a', 'one');
  corrector.add('b', 'two');
  corrector.add('c', 'three');
  t = LIVE_SETTLE_MS + 2_000;
  return { corrector, correct };
}

function makeExtractor(cloudChat: () => Promise<unknown>) {
  const store = { liveKey: 'k', file: { items: [], participants: { me: '', them: '' } }, addItems: () => 0, applyOps: () => 0 };
  const deps = {
    cloudChat,
    withLocal: async () => { throw new Error('x'); },
    localReady: async () => false,
    now: () => 100_000,
  };
  const extractor = new LiveActionItemsExtractor(store as never, deps as never);
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  extractor.addTranscript('1', 'Me', `I will send it by friday ${words}`);
  return extractor;
}

describe('LiveTextCorrector yielding (AUG-167)', () => {
  it('skips the cycle while shouldYield is true, runs after it clears', async () => {
    let yielding = true;
    const { corrector, correct } = makeCorrector(() => yielding);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await corrector.tick();
    expect(correct).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[correction] yielded to action-items');
    yielding = false;
    await corrector.tick();
    expect(correct).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('yields from gate-open until the action-items cloud call goes through', async () => {
    let resolve!: (v: unknown) => void;
    const deferred = new Promise((r) => { resolve = r; });
    const extractor = makeExtractor(() => deferred);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(extractor.cloudCallPending).toBe(false);
    const p = extractor.tick();
    expect(extractor.cloudCallPending).toBe(true);
    const { corrector, correct } = makeCorrector(() => extractor.cloudCallPending);
    await corrector.tick();
    expect(correct).not.toHaveBeenCalled();
    resolve({ content: '{"new":[],"ops":[]}' });
    await p;
    expect(extractor.cloudCallPending).toBe(false);
    await corrector.tick();
    expect(correct).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('a rate-budget skip keeps the flag set until stop()', async () => {
    const extractor = makeExtractor(async () => { throw new GroqTextSkipError('rate-budget'); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await extractor.tick();
    expect(extractor.cloudCallPending).toBe(true);
    extractor.stop();
    expect(extractor.cloudCallPending).toBe(false);
    log.mockRestore();
  });
});
