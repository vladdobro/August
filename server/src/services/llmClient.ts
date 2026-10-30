/// Provider-agnostic client for OpenAI-compatible chat completions (AUG-162). Knows nothing about llama.cpp: the same
/// client is reused for Groq (`https://api.groq.com/openai/v1` + GROQ_API_KEY) in a later task.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  logprobs?: boolean;
  topLogprobs?: number;
  stop?: string[];
  /// Reasoning models only (Groq gpt-oss, AUG-164); omitted for llama-server.
  reasoningEffort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TokenLogprob {
  token: string;
  logprob: number;
  topLogprobs: Array<{ token: string; logprob: number }>;
}

export interface ChatCompletionResult {
  content: string;
  finishReason: string | null;
  logprobs: TokenLogprob[] | null;
  usage: { promptTokens: number; completionTokens: number } | null;
  latencyMs: number;
}

/// Raw (non-chat) completion, used to score forced continuations (AUG-163).
export interface CompletionRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  logprobs?: number;
  /// llama.cpp extension: GBNF grammar constraining the output (ignored by other providers).
  grammar?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  finishReason: string | null;
  logprobs: TokenLogprob[] | null;
  latencyMs: number;
}

export interface LlmClientOptions {
  baseURL: string;
  apiKey?: string | null;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
}

export class LlmClientError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'LlmClientError';
    this.status = status;
  }
}

export interface LlmClient {
  chat(req: ChatCompletionRequest): Promise<ChatCompletionResult>;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export function buildChatCompletionBody(req: ChatCompletionRequest, defaultModel?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model ?? defaultModel,
    messages: req.messages,
    stream: false,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    stop: req.stop,
    reasoning_effort: req.reasoningEffort,
  };
  if (req.logprobs) {
    body.logprobs = true;
    body.top_logprobs = req.topLogprobs;
  }
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return body;
}

interface RawLogprobEntry {
  token?: unknown;
  logprob?: unknown;
  top_logprobs?: Array<{ token?: unknown; logprob?: unknown }>;
}

function mapLogprobEntries(rawLogprobs: RawLogprobEntry[] | undefined): TokenLogprob[] | null {
  return Array.isArray(rawLogprobs)
    ? rawLogprobs.map((entry) => ({
      token: String(entry.token ?? ''),
      logprob: Number(entry.logprob ?? 0),
      topLogprobs: (entry.top_logprobs ?? []).map((t) => ({ token: String(t.token ?? ''), logprob: Number(t.logprob ?? 0) })),
    }))
    : null;
}

export function buildCompletionBody(req: CompletionRequest, defaultModel?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model ?? defaultModel,
    prompt: req.prompt,
    stream: false,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    logprobs: req.logprobs,
    grammar: req.grammar,
  };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return body;
}

export function parseCompletionResponse(json: unknown): Omit<CompletionResult, 'latencyMs'> {
  const root = (json ?? {}) as {
    choices?: Array<{ text?: unknown; finish_reason?: unknown; logprobs?: { content?: RawLogprobEntry[] } | null }>;
  };
  const choice = Array.isArray(root.choices) ? root.choices[0] : undefined;
  if (!choice) throw new LlmClientError('LLM response has no choices', null);
  return {
    text: typeof choice.text === 'string' ? choice.text : '',
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    logprobs: mapLogprobEntries(choice.logprobs?.content),
  };
}

export function parseChatCompletionResponse(json: unknown): Omit<ChatCompletionResult, 'latencyMs'> {
  const root = (json ?? {}) as {
    choices?: Array<{
      message?: { content?: unknown };
      finish_reason?: unknown;
      logprobs?: { content?: RawLogprobEntry[] } | null;
    }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const choice = Array.isArray(root.choices) ? root.choices[0] : undefined;
  if (!choice) throw new LlmClientError('LLM response has no choices', null);

  const logprobs = mapLogprobEntries(choice.logprobs?.content);

  const usage = root.usage
    ? { promptTokens: Number(root.usage.prompt_tokens ?? 0), completionTokens: Number(root.usage.completion_tokens ?? 0) }
    : null;

  return {
    content: typeof choice.message?.content === 'string' ? choice.message.content : '',
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    logprobs,
    usage,
  };
}

export function createLlmClient(opts: LlmClientOptions): LlmClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseURL = opts.baseURL.replace(/\/+$/, '');
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;

  /// Shared POST + timeout + abort handling for every endpoint; returns the parsed JSON body.
  async function post(path: string, body: Record<string, unknown>, timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? defaultTimeoutMs);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const res = await fetchImpl(`${baseURL}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LlmClientError(`LLM request failed: HTTP ${res.status} ${text.slice(0, 200)}`.trim(), res.status);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof LlmClientError) throw err;
      if (controller.signal.aborted) throw new LlmClientError('LLM request timed out or was cancelled', null);
      throw new LlmClientError(`LLM request failed: ${(err as Error)?.message ?? err}`, null);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return {
    async chat(req) {
      const startedAt = performance.now();
      const json = await post('/chat/completions', buildChatCompletionBody(req, opts.defaultModel), req.timeoutMs, req.signal);
      return { ...parseChatCompletionResponse(json), latencyMs: Math.round(performance.now() - startedAt) };
    },
    async complete(req) {
      const startedAt = performance.now();
      const json = await post('/completions', buildCompletionBody(req, opts.defaultModel), req.timeoutMs, req.signal);
      return { ...parseCompletionResponse(json), latencyMs: Math.round(performance.now() - startedAt) };
    },
  };
}
