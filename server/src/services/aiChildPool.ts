/// AUG-199 (shared with AUG-197): at most AI_MAX_SESSIONS Claude children app-wide (chat and copilot). A 4th request evicts the least recently used idle child; none idle -> refused.

export const AI_MAX_SESSIONS = 3;

export interface PooledChild {
  id: string;
  kind: 'chat' | 'copilot';
  busy(): boolean;
  lastUsedAt(): number;
  evict(): void;
}

const pool = new Map<string, PooledChild>();

export function acquireChildSlot(c: PooledChild): boolean {
  if (pool.has(c.id)) return true;
  if (pool.size < AI_MAX_SESSIONS) {
    pool.set(c.id, c);
    return true;
  }
  let victim: PooledChild | null = null;
  for (const p of pool.values()) {
    if (p.busy()) continue;
    if (!victim || p.lastUsedAt() < victim.lastUsedAt()) victim = p;
  }
  if (!victim) return false;
  pool.delete(victim.id);
  victim.evict();
  pool.set(c.id, c);
  return true;
}

export function releaseChildSlot(id: string): void {
  pool.delete(id);
}
