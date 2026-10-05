// Structured JSON-lines logger. Anything that looks like a secret is redacted
// before it is written, so a token pasted into an error message never reaches CI logs.

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const secretValues = new Set<string>();

/** Register a secret value (API key, token) so it is masked wherever it appears. */
export function registerSecret(v: string | undefined): void {
  if (v && v.length >= 8) secretValues.add(v);
}

export function redact(s: string): string {
  let out = s;
  for (const v of secretValues) out = out.split(v).join('***');
  return out
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1***')
    .replace(/(apify_api_)[A-Za-z0-9]{8,}/g, '$1***')
    .replace(/([?&]token=)[^&\s]+/g, '$1***');
}

let minLevel: Level = (process.env.LOG_LEVEL as Level) in order ? (process.env.LOG_LEVEL as Level) : 'info';
let pretty = false;

export function configureLog(opts: { level?: Level; pretty?: boolean }): void {
  if (opts.level) minLevel = opts.level;
  if (opts.pretty !== undefined) pretty = opts.pretty;
}

function write(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < order[minLevel]) return;
  const line = pretty
    ? `${level.toUpperCase().padEnd(5)} ${msg}${Object.keys(fields).length ? ' ' + JSON.stringify(fields) : ''}`
    : JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  process.stderr.write(redact(line) + '\n');
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => {
    write('debug', m, f);
  },
  info: (m: string, f?: Record<string, unknown>) => {
    write('info', m, f);
  },
  warn: (m: string, f?: Record<string, unknown>) => {
    write('warn', m, f);
  },
  error: (m: string, f?: Record<string, unknown>) => {
    write('error', m, f);
  },
};
