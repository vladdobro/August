import fs from 'node:fs/promises';
import { config } from '../config.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3';
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

class RateLimiter {
  private timestamps: number[] = [];

  canProceed(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    return this.timestamps.length < RATE_LIMIT_MAX;
  }

  record(): void {
    this.timestamps.push(Date.now());
  }
}

const rateLimiter = new RateLimiter();

export class GroqRateLimitError extends Error {
  constructor() {
    super('Groq rate limit reached (20 req/min)');
    this.name = 'GroqRateLimitError';
  }
}

export class GroqApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroqApiError';
  }
}

export async function transcribeWithGroq(wavPath: string, language: string): Promise<string> {
  if (!config.groqApiKey) {
    throw new GroqApiError('GROQ_API_KEY not configured');
  }

  if (!rateLimiter.canProceed()) {
    throw new GroqRateLimitError();
  }

  const wavBuffer = await fs.readFile(wavPath);

  const formData = new FormData();
  formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'chunk.wav');
  formData.append('model', GROQ_MODEL);
  if (language && language !== 'auto') {
    formData.append('language', language);
  }
  formData.append('response_format', 'text');

  rateLimiter.record();

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.groqApiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new GroqRateLimitError();
    }
    const body = await response.text().catch(() => '');
    throw new GroqApiError(`Groq API error ${response.status}: ${body}`);
  }

  const text = await response.text();
  return text.trim();
}
