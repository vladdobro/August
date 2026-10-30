import { describe, expect, test, vi } from 'vitest';

import { buildChatCompletionBody, createLlmClient, LlmClientError, parseChatCompletionResponse } from './llmClient.js';

const messages = [{ role: 'user' as const, content: 'hi' }];

describe('buildChatCompletionBody (AUG-162)', () => {
  test('omits logprobs and undefined keys by default', () => {
    const body = buildChatCompletionBody({ messages }, 'm');
    expect(body).toEqual({ model: 'm', messages, stream: false });
    expect('top_logprobs' in body).toBe(false);
  });

  test('adds logprobs and top_logprobs only when requested', () => {
    const body = buildChatCompletionBody({ messages, logprobs: true, topLogprobs: 5, maxTokens: 8, temperature: 0, stop: ['\n'] }, 'm');
    expect(body).toMatchObject({ logprobs: true, top_logprobs: 5, max_tokens: 8, temperature: 0, stop: ['\n'] });
  });
});

describe('parseChatCompletionResponse (AUG-162)', () => {
  test('parses a llama-server style payload with logprobs', () => {
    const parsed = parseChatCompletionResponse({
      choices: [{
        message: { content: 'yes' },
        finish_reason: 'stop',
        logprobs: { content: [{ token: 'yes', logprob: -0.1, top_logprobs: [{ token: 'yes', logprob: -0.1 }, { token: 'no', logprob: -2.3 }] }] },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 1 },
    });
    expect(parsed.content).toBe('yes');
    expect(parsed.finishReason).toBe('stop');
    expect(parsed.usage).toEqual({ promptTokens: 12, completionTokens: 1 });
    expect(parsed.logprobs).toEqual([
      { token: 'yes', logprob: -0.1, topLogprobs: [{ token: 'yes', logprob: -0.1 }, { token: 'no', logprob: -2.3 }] },
    ]);
  });

  test('missing logprobs and usage become null; empty choices throw', () => {
    const parsed = parseChatCompletionResponse({ choices: [{ message: {} }] });
    expect(parsed).toEqual({ content: '', finishReason: null, logprobs: null, usage: null });
    expect(() => parseChatCompletionResponse({ choices: [] })).toThrow(LlmClientError);
  });
});

describe('createLlmClient (AUG-162)', () => {
  const okResponse = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });

  test('posts to /chat/completions without Authorization when no apiKey', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const client = createLlmClient({ baseURL: 'http://127.0.0.1:1234/v1/', fetchImpl: fetchImpl as unknown as typeof fetch, defaultModel: 'm' });
    const result = await client.chat({ messages });
    expect(result.content).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test('sends a Bearer token when apiKey is set', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const client = createLlmClient({ baseURL: 'http://x/v1', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.chat({ messages });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  test('non-2xx rejects with LlmClientError carrying the status', async () => {
    const fetchImpl = vi.fn(async () => new Response('loading', { status: 503 }));
    const client = createLlmClient({ baseURL: 'http://x/v1', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.chat({ messages })).rejects.toMatchObject({ name: 'LlmClientError', status: 503 });
  });
});
