/// AUG-197: minimal MCP client (Streamable HTTP, JSON-RPC) for the local PraxisOS server, used by the copilot's local search.
/// Only fetch, no dependency. Never logs tool arguments or results.

export const PRAXIS_MCP_URL = 'http://127.0.0.1:7865/stream';

export class PraxisDownError extends Error {
  constructor() {
    super('PraxisOS is not reachable');
    this.name = 'PraxisDownError';
  }
}

class StaleSessionError extends Error {}

interface RpcMessage {
  id?: number | string;
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: unknown;
}

function pickMessage(body: string, id: number): RpcMessage | null {
  const candidates: RpcMessage[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      candidates.push(JSON.parse(line.slice(5).trim()) as RpcMessage);
    } catch {
      // not a JSON event
    }
  }
  const hit = candidates.find((m) => m && m.id === id);
  if (hit) return hit;
  try {
    return JSON.parse(body) as RpcMessage;
  } catch {
    return null;
  }
}

export class PraxisMcpClient {
  private sessionId: string | null = null;
  private initPromise: Promise<void> | null = null;
  private nextId = 2;

  constructor(private readonly url: string = PRAXIS_MCP_URL) {}

  reset(): void {
    this.sessionId = null;
    this.initPromise = null;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
  }

  private async post(body: unknown, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new PraxisDownError();
    }
  }

  private ensureInit(timeoutMs: number): Promise<void> {
    if (this.sessionId) return Promise.resolve();
    if (!this.initPromise) {
      const p = this.initialize(timeoutMs).catch((err) => {
        if (this.initPromise === p) this.initPromise = null;
        throw err;
      });
      this.initPromise = p;
    }
    return this.initPromise;
  }

  private async initialize(timeoutMs: number): Promise<void> {
    const res = await this.post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'august-copilot', version: '1' } },
      },
      timeoutMs,
    );
    if (!res.ok) throw new Error(`Praxis MCP initialize failed: ${res.status}`);
    this.sessionId = res.headers.get('mcp-session-id');
    await res.text().catch(() => '');
    const note = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs);
    await note.text().catch(() => '');
  }

  private async callOnce(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    await this.ensureInit(timeoutMs);
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, timeoutMs);
    if (res.status === 400 || res.status === 404) {
      await res.text().catch(() => '');
      throw new StaleSessionError();
    }
    if (!res.ok) {
      await res.text().catch(() => '');
      throw new Error(`Praxis MCP call failed: ${res.status}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new PraxisDownError();
    }
    const msg = pickMessage(text, id);
    if (!msg) throw new Error('Praxis MCP returned an unreadable response');
    if (msg.error) throw new Error('Praxis MCP returned an error');
    return (msg.result?.content ?? [])
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    try {
      return await this.callOnce(name, args, timeoutMs);
    } catch (err) {
      if (!(err instanceof StaleSessionError)) throw err;
      this.reset();
      try {
        return await this.callOnce(name, args, timeoutMs);
      } catch (err2) {
        if (err2 instanceof StaleSessionError) throw new Error('Praxis MCP session could not be re-established');
        throw err2;
      }
    }
  }
}

export const praxisMcp = new PraxisMcpClient();
