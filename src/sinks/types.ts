import type { OwnedSource } from '../types.js';

/** Where formatted transcripts go: Chatbase (REST) or files on disk (export). */
export interface Sink {
  readonly kind: 'rest' | 'export';
  /** Every source this connector owns, decoded from names or the export manifest. */
  list(): Promise<OwnedSource[]>;
  create(videoId: string, name: string, content: string, meta: SourceMeta): Promise<void>;
  update(existing: OwnedSource, name: string, content: string, meta: SourceMeta): Promise<void>;
  remove(existing: OwnedSource): Promise<void>;
  /** Bytes currently used by the agent's text sources, when the sink can tell. */
  textBytesUsed(): Promise<number | undefined>;
  /** Called once after all writes; lets a sink flush manifests or wait for training. */
  finish(): Promise<void>;
}

export interface SourceMeta {
  title: string;
  hash: string;
  part: number;
  url: string;
  publishedAt?: string;
}

/** The agent's storage plan limit was hit; stop creating, keep what is done. */
export class StorageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageLimitError';
  }
}
