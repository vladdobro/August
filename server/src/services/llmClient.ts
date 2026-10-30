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
}

export function buildChatCompletionBody(req: ChatCompletionRequest, defaultModel?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model ?? defaultModel,
    messages: req.messages,
    stream: false,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    stop: req.stop,
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

  const rawLogprobs = choice.logprobs?.content;
  const logprobs: TokenLogprob[] | null = Array.isArray(rawLogprobs)
    ? rawLogprobs.map((entry) => ({
      token: String(entry.token ?? ''),
      logprob: Number(entry.logprob ?? 0),
      topLogprobs: (entry.top_logprobs ?? []).map((t) => ({ token: String(t.token ?? ''), logprob: Number(t.logprob ?? 0) })),
    }))
    : null;

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
  const url = `${opts.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;

  return {
    async chat(req) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? defaultTimeoutMs);
      const onExternalAbort = () => controller.abort();
      if (req.signal) {
        if (req.signal.aborted) controller.abort();
        else req.signal.addEventListener('abort', onExternalAbort, { once: true });
      }

      const startedAt = performance.now();
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(buildChatCompletionBody(req, opts.defaultModel)),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new LlmClientError(`LLM request failed: HTTP ${res.status} ${text.slice(0, 200)}`.trim(), res.status);
        }
        const parsed = parseChatCompletionResponse(await res.json());
        return { ...parsed, latencyMs: Math.round(performance.now() - startedAt) };
      } catch (err) {
        if (err instanceof LlmClientError) throw err;
        if (controller.signal.aborted) throw new LlmClientError('LLM request timed out or was cancelled', null);
        throw new LlmClientError(`LLM request failed: ${(err as Error)?.message ?? err}`, null);
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}
