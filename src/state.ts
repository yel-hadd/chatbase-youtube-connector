// A small local file that remembers videos we transcribed but could not use (no
// captions, too short, filtered out). Without it, every daily run would pay to
// re-check them. It is an optimisation, not a source of truth: losing it only
// costs one re-check.
//
// Every entry records a fingerprint of the settings that decided the skip
// (filters, languages, AI fallback). Change those settings and the old entries
// stop counting, so a config change takes effect on the next run.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Job } from './config/schema.js';
import { log } from './util/log.js';

interface Entry {
  reason: string;
  /** ISO time the video was last checked. */
  at: string;
  /** Fingerprint of the settings in force when it was skipped. */
  fp: string;
}

interface StateFile {
  version: 2;
  skipped: Record<string, Entry>;
}

/** The settings that decide whether a video is usable. */
export function skipFingerprint(job: Job): string {
  const relevant = {
    languages: job.languages,
    machineTranslate: job.machineTranslate,
    ai: job.aiFallback.enabled,
    aiMaxLen: job.aiFallback.skipLongerThanMin,
    shorts: job.includeShorts,
    minDuration: job.minDurationSec,
    filters: job.filters,
  };
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 12);
}

export class SkipCache {
  private skipped = new Map<string, Entry>();
  private dirty = false;

  constructor(
    private readonly path: string | undefined,
    private readonly recheckAfterDays: number,
    private readonly fingerprint = '',
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StateFile>;
      if (parsed.version === 2 && parsed.skipped) this.skipped = new Map(Object.entries(parsed.skipped));
    } catch {
      /* first run or unreadable: start empty */
    }
  }

  private expired(e: Entry): boolean {
    return (this.now().getTime() - new Date(e.at).getTime()) / 86_400_000 >= this.recheckAfterDays;
  }

  /** The cached skip, when it is recent and was decided under the current settings. */
  isFresh(videoId: string): Entry | undefined {
    const e = this.skipped.get(videoId);
    return e?.fp === this.fingerprint && !this.expired(e) ? e : undefined;
  }

  remember(videoId: string, reason: string): void {
    this.skipped.set(videoId, { reason, at: this.now().toISOString(), fp: this.fingerprint });
    this.dirty = true;
  }

  forget(videoId: string): void {
    if (this.skipped.delete(videoId)) this.dirty = true;
  }

  async save(): Promise<void> {
    if (!this.path) return;
    // Drop entries that can never count again, so the file does not grow without bound.
    for (const [id, e] of this.skipped) {
      if (this.expired(e) || e.fp !== this.fingerprint) {
        this.skipped.delete(id);
        this.dirty = true;
      }
    }
    if (!this.dirty) return;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const data: StateFile = { version: 2, skipped: Object.fromEntries(this.skipped) };
      await writeFile(this.path, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (e) {
      log.warn('could not save the skip cache; skipped videos will be re-checked next run', {
        path: this.path,
        error: (e as Error).message,
      });
    }
  }
}
