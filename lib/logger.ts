const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

const configuredLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
const threshold = LEVELS.indexOf(configuredLevel);

function log(level: LogLevel, meta: Record<string, unknown> | undefined, message: string) {
  if (LEVELS.indexOf(level) < threshold) return;
  const time = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  const line = `[${time}] ${level.toUpperCase()} ${message}${metaStr}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  trace: (meta: Record<string, unknown>, msg?: string) =>
    msg ? log('trace', meta, msg) : log('trace', undefined, meta as unknown as string),
  debug: (meta: Record<string, unknown>, msg?: string) =>
    msg ? log('debug', meta, msg) : log('debug', undefined, meta as unknown as string),
  info: (meta: Record<string, unknown>, msg?: string) =>
    msg ? log('info', meta, msg) : log('info', undefined, meta as unknown as string),
  warn: (meta: Record<string, unknown>, msg?: string) =>
    msg ? log('warn', meta, msg) : log('warn', undefined, meta as unknown as string),
  error: (meta: Record<string, unknown>, msg?: string) =>
    msg ? log('error', meta, msg) : log('error', undefined, meta as unknown as string),
};
