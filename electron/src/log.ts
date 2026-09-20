import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/// Mirrors console output into <userData>/logs/main.log so packaged builds (no terminal) still leave a
/// trace of shell and embedded-server activity. Rotates once at 5 MB.
export function installFileLogger(logDir: string): void {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'main.log');
  try {
    if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    // no log file yet
  }
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  const format = (a: unknown): string => {
    if (a instanceof Error) return a.stack ?? a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      stream.write(`${new Date().toISOString()} [${level}] ${args.map(format).join(' ')}\n`);
    };
  }
}
