// Export sink for Chatbase plans without API access (Free, Hobby).
// Writes one .txt per video, a manifest (the sink's state) and CHANGES.txt (what to upload or delete). Upload the files with "Add files"
// in the Chatbase dashboard; re-runs only touch files whose content changed.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OwnedSource } from '../types.js';
import type { Sink, SourceMeta } from './types.js';

interface ManifestEntry {
  videoId: string;
  part: number;
  hash: string;
  title: string;
  url: string;
  file: string;
  bytes: number;
}

interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

const key = (videoId: string, part: number): string => (part > 1 ? `${videoId}.p${part}` : videoId);

export class ExportSink implements Sink {
  readonly kind = 'export' as const;
  private manifest: Manifest = { version: 1, entries: {} };
  private loaded = false;
  private readonly changed: string[] = [];
  private readonly removed: string[] = [];

  constructor(private readonly dir: string) {}

  private manifestPath(): string {
    return join(this.dir, 'manifest.json');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.dir, { recursive: true });
    try {
      this.manifest = JSON.parse(await readFile(this.manifestPath(), 'utf8')) as Manifest;
    } catch {
      this.manifest = { version: 1, entries: {} };
    }
    this.loaded = true;
  }

  async list(): Promise<OwnedSource[]> {
    await this.load();
    return Object.values(this.manifest.entries).map((e) => ({
      sourceId: e.file,
      videoId: e.videoId,
      hash: e.hash,
      part: e.part,
      name: e.title,
      size: e.bytes,
    }));
  }

  private async write(videoId: string, content: string, meta: SourceMeta): Promise<void> {
    const file = `${key(videoId, meta.part)}.txt`;
    await writeFile(join(this.dir, file), content, 'utf8');
    this.manifest.entries[key(videoId, meta.part)] = {
      videoId,
      part: meta.part,
      hash: meta.hash,
      title: meta.title,
      url: meta.url,
      file,
      bytes: Buffer.byteLength(content, 'utf8'),
    };
    this.changed.push(file);
  }

  async create(videoId: string, _name: string, content: string, meta: SourceMeta): Promise<void> {
    await this.load();
    await this.write(videoId, content, meta);
  }

  async update(existing: OwnedSource, _name: string, content: string, meta: SourceMeta): Promise<void> {
    await this.load();
    await this.write(existing.videoId, content, meta);
  }

  async remove(existing: OwnedSource): Promise<void> {
    await this.load();
    await rm(join(this.dir, existing.sourceId), { force: true });
    const gone = key(existing.videoId, existing.part);
    this.manifest.entries = Object.fromEntries(Object.entries(this.manifest.entries).filter(([k]) => k !== gone));
    this.removed.push(existing.sourceId);
  }

  async textBytesUsed(): Promise<number | undefined> {
    await this.load();
    return Object.values(this.manifest.entries).reduce((a, e) => a + e.bytes, 0);
  }

  async finish(): Promise<void> {
    await this.load();
    await writeFile(this.manifestPath(), JSON.stringify(this.manifest, null, 2) + '\n', 'utf8');
    await writeFile(
      join(this.dir, 'CHANGES.txt'),
      [
        `Upload or replace these files in Chatbase (Sources → Files):`,
        ...this.changed.map((f) => `  + ${f}`),
        this.removed.length ? `Delete these files from Chatbase:` : '',
        ...this.removed.map((f) => `  - ${f}`),
      ]
        .filter(Boolean)
        .join('\n') + '\n',
      'utf8',
    );
  }
}
