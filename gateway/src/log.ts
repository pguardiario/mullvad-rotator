import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(config.logLevel as Level)] ?? LEVELS.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (LEVELS[level] >= LEVELS.warn) process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f),
};

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
