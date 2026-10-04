import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { configSchema, resolveJobs, type Job } from './schema.js';
import { ExitCode, UserError } from '../util/errors.js';

/** Replace ${VAR} with process.env.VAR. Unset variables are an error, never an empty string. */
export function interpolateEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined || v === '') {
      throw new UserError(`environment variable ${name} is referenced in the config but not set`, ExitCode.ConfigInvalid);
    }
    return v;
  });
}

export function parseConfig(text: string, env: NodeJS.ProcessEnv = process.env): Job[] {
  let raw: unknown;
  try {
    raw = parse(interpolateEnv(text, env));
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(`config is not valid YAML: ${(e as Error).message}`, ExitCode.ConfigInvalid);
  }
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
