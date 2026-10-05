// Reads the YAML config, substitutes ${VAR} from the environment and validates it.
// Every failure here is a UserError with exit code 2 and a message that names the problem.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { configSchema, resolveJobs, type Job } from './schema.js';
import { ExitCode, UserError } from '../util/errors.js';

/** Replace ${VAR} with process.env.VAR. Unset variables are an error, never an empty string. */
export function interpolateEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined || v === '') {
      throw new UserError(
        `environment variable ${name} is referenced in the config but not set`,
        ExitCode.ConfigInvalid,
      );
    }
    return v;
  });
}

/** Interpolate ${VAR} in every string value (never in comments or keys). */
function interpolateValues(v: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof v === 'string') return interpolateEnv(v, env);
  if (Array.isArray(v)) return v.map((x) => interpolateValues(x, env));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolateValues(x, env)]));
  }
  return v;
}

export function parseConfig(text: string, env: NodeJS.ProcessEnv = process.env): Job[] {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (e) {
    throw new UserError(`config is not valid YAML: ${(e as Error).message}`, ExitCode.ConfigInvalid);
  }
  // After parsing, so a commented-out ${VAR} is ignored instead of failing the run.
  const raw = interpolateValues(parsed, env);
  const res = configSchema.safeParse(raw);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new UserError(`config is invalid:\n${msg}`, ExitCode.ConfigInvalid);
  }
  return resolveJobs(res.data);
}

export async function loadConfig(path: string): Promise<Job[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new UserError(`cannot read config file ${path}`, ExitCode.ConfigInvalid);
  }
  return parseConfig(text);
}
