export interface WatchedSession {
  id: string;
  title: string;
  status: string;
}

export interface SessionWatcherHandlers {
  onTranscribingCount(count: number): void;
  onCompleted(session: WatchedSession): void;
  onFailed(session: WatchedSession): void;
}

const POLL_MS = 5000;

/// Polls GET /api/sessions and reports transitions into "completed"/"failed" plus the live count of
/// transcribing sessions (tray tooltip). The first poll only seeds state, so sessions that finished before
/// launch never notify; sessions first seen already completed are ignored too.
export function startSessionWatcher(apiBase: string, handlers: SessionWatcherHandlers): () => void {
  let known: Map<string, string> | null = null;
  let stopped = false;

  const tick = async () => {
    try {
      const res = await fetch(`${apiBase}/api/sessions`);
      if (!res.ok) return;
      const sessions = (await res.json()) as WatchedSession[];
      if (known) {
        for (const s of sessions) {
          const prev = known.get(s.id);
          if (prev === undefined || prev === s.status) continue;
          if (s.status === 'completed') handlers.onCompleted(s);
          else if (s.status === 'failed') handlers.onFailed(s);
        }
      }
      known = new Map(sessions.map((s) => [s.id, s.status]));
      handlers.onTranscribingCount(sessions.filter((s) => s.status === 'transcribing').length);
    } catch {
      // server not reachable yet — retry on the next tick
    }
  };

  void tick();
  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
