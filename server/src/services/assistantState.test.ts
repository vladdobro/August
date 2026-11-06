import { describe, expect, test } from 'vitest';

import {
  applyCopilotMode,
  applySessionDisable,
  applySessionEnable,
  buildAssistantStatus,
  probePraxisReachable,
} from './assistantState.js';
import type { ClaudeProbe } from './claudeCli.js';

const NOW = new Date('2026-11-06T10:00:00Z');
const claude: ClaudeProbe = { found: true, signedIn: true, version: '2.1.319', tooOld: false, checkedAt: NOW.toISOString() };

function must(r: ReturnType<typeof applyCopilotMode>) {
  if (!r.ok) throw new Error(`rule failed: ${r.status} ${r.error}`);
  return r.prefs;
}

describe('applyCopilotMode', () => {
  test('unknown mode -> 400', () => {
    expect(applyCopilotMode({}, { mode: 'x' }, true, NOW)).toEqual({ ok: false, status: 400, error: 'Unknown copilot mode.' });
  });
  test('claude without accept -> 400; unusable -> 409', () => {
    expect(applyCopilotMode({}, { mode: 'claude' }, true, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(applyCopilotMode({}, { mode: 'claude', accept: true }, false, NOW)).toMatchObject({ ok: false, status: 409 });
  });
  test('claude ok writes consent version 1', () => {
    const p = must(applyCopilotMode({}, { mode: 'claude', accept: true }, true, NOW));
    expect(p.aiCopilotMode).toBe('claude');
    expect(p.aiCopilotConsent).toEqual({ acceptedAt: NOW.toISOString(), version: 1 });
  });
  test('always needs ack; ok writes ack', () => {
    expect(applyCopilotMode({}, { mode: 'always', accept: true }, true, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(applyCopilotMode({}, { mode: 'always', accept: true, ack: true }, false, NOW)).toMatchObject({ ok: false, status: 409 });
    const p = must(applyCopilotMode({}, { mode: 'always', accept: true, ack: true }, true, NOW));
    expect(p.aiCopilotMode).toBe('always');
    expect(p.aiCopilotAlwaysAck).toEqual({ acceptedAt: NOW.toISOString() });
  });
  test('off keeps consents', () => {
    const consent = { acceptedAt: 'x', version: 1 };
    const p = must(applyCopilotMode({ aiCopilotConsent: consent, aiCopilotMode: 'claude' }, { mode: 'off' }, false, NOW));
    expect(p).toEqual({ aiCopilotConsent: consent, aiCopilotMode: 'off' });
  });
});

describe('session enable / disable', () => {
  test('enable rules', () => {
    expect(applySessionEnable({}, {}, true, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(applySessionEnable({}, { accept: true }, false, NOW)).toMatchObject({ ok: false, status: 409 });
    const p = must(applySessionEnable({}, { accept: true }, true, NOW));
    expect(p).toEqual({ aiSessionEnabled: true, aiConsent: { acceptedAt: NOW.toISOString(), version: 1 } });
  });
  test('disable drops aiConsent', () => {
    const p = applySessionDisable({ aiSessionEnabled: true, aiConsent: { acceptedAt: 'x', version: 1 }, other: 1 });
    expect(p).toEqual({ aiSessionEnabled: false, other: 1 });
  });
});

describe('buildAssistantStatus', () => {
  test('defaults on empty prefs', () => {
    const s = buildAssistantStatus({}, claude, true);
    expect(s.copilot).toEqual({ mode: 'off', consentStale: false, model: 'sonnet', alwaysBudgetUsd: 2 });
    expect(s.session).toEqual({ enabled: false, consentStale: false, consentAt: null, model: 'sonnet', budgetUsd: 2, transcriptWindowMin: 5 });
    expect(s.praxis.reachable).toBe(true);
  });
  test('stale copilot consent (version 0)', () => {
    const s = buildAssistantStatus({ aiCopilotMode: 'claude', aiCopilotConsent: { acceptedAt: 'x', version: 0 } }, claude, true);
    expect(s.copilot.consentStale).toBe(true);
  });
  test('stale session consent -> not enabled', () => {
    const s = buildAssistantStatus({ aiSessionEnabled: true, aiConsent: { acceptedAt: 'x', version: 0 } }, claude, true);
    expect(s.session.enabled).toBe(false);
    expect(s.session.consentStale).toBe(true);
  });
  test('valid session consent', () => {
    const s = buildAssistantStatus({ aiSessionEnabled: true, aiConsent: { acceptedAt: 'when', version: 1 } }, claude, true);
    expect(s.session).toMatchObject({ enabled: true, consentStale: false, consentAt: 'when' });
  });
});

describe('probePraxisReachable', () => {
  const fake = (res: () => Promise<unknown>) => (async () => res()) as unknown as typeof fetch;
  const resp = (status: number, body: unknown) => ({ status, json: async () => body });
  test('200 ok -> true', async () => {
    expect(await probePraxisReachable(fake(async () => resp(200, { status: 'ok' })))).toBe(true);
  });
  test('200 status down -> false', async () => {
    expect(await probePraxisReachable(fake(async () => resp(200, { status: 'down' })))).toBe(false);
  });
  test('500 -> false', async () => {
    expect(await probePraxisReachable(fake(async () => resp(500, { status: 'ok' })))).toBe(false);
  });
  test('throw -> false', async () => {
    expect(
      await probePraxisReachable(
        fake(async () => {
          throw new Error('refused');
        }),
      ),
    ).toBe(false);
  });
});
