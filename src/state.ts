// A small local file that remembers videos we transcribed but could not use (no
// captions, too short). Without it, every daily run would pay to re-check them.
// It is an optimisation, not a source of truth: losing it only costs a re-check.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from './util/log.js';

interface Entry {
  reason: string;
  /** ISO date the video was last checked. */
  at: string;
}

interface StateFile {
  version: 1;
  skipped: Record<string, Entry>;
}

export class SkipCache {
  private data: StateFile = { version: 1, skipped: {} };
  private dirty = false;

  constructor(
    private readonly path: string | undefined,
    private readonly recheckAfterDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StateFile>;
      if (parsed.version === 1 && parsed.skipped) this.data = { version: 1, skipped: parsed.skipped };
    } catch {
      /* first run or unreadable: start empty */
    }
  }

  /** True when the video was skipped recently enough that re-checking would waste money. */
  isFresh(videoId: string): Entry | undefined {
    const e = this.data.skipped[videoId];
    if (!e) return undefined;
    const ageDays = (this.now().getTime() - new Date(e.at).getTime()) / 86_400_000;
    return ageDays < this.recheckAfterDays ? e : undefined;
  }

  remember(videoId: string, reason: string): void {
    this.data.skipped[videoId] = { reason, at: this.now().toISOString() };
    this.dirty = true;
  }

  forget(videoId: string): void {
    if (videoId in this.data.skipped) {
      this.data.skipped = Object.fromEntries(Object.entries(this.data.skipped).filter(([k]) => k !== videoId));
      this.dirty = true;
    }
  }

  async save(): Promise<void> {
    if (!this.path || !this.dirty) return;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
    } catch (e) {
      log.warn('could not save the skip cache; skipped videos will be re-checked next run', {
        path: this.path,
        error: (e as Error).message,
      });
    }
  }
}
