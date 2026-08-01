/**
 * Minimal structured console logger. Timestamps every line and keeps a
 * consistent, greppable shape. Not the audit log — that is JSONL on disk
 * (see audit-store.ts). This is just human-facing progress output.
 */

function ts(): string {
  // ISO without milliseconds for readability.
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

type Level = 'info' | 'warn' | 'error' | 'ok';

const TAG: Record<Level, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'FAIL',
  ok: ' OK ',
};

function emit(level: Level, msg: string, extra?: unknown): void {
  const line = `${ts()} [${TAG[level]}] ${msg}`;
  const stream = level === 'error' ? console.error : console.log;
  if (extra !== undefined) {
    stream(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
  } else {
    stream(line);
  }
}

export const log = {
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
  ok: (msg: string, extra?: unknown) => emit('ok', msg, extra),
  /** Visual section break in demo output. */
  section: (title: string) => {
    console.log('');
    console.log(`──── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  },
};
