// Chatbase API v2 sink. https://www.chatbase.co/docs/api-v2/sources
// Text sources train on write; there is no separate train call.

import { HttpError, UserError, ExitCode } from '../util/errors.js';
import { RateLimiter, isRateLimited, isRetryable, readJson, sleep, withRetry, type FetchFn } from '../util/http.js';
import { log } from '../util/log.js';
import { decodeName, PREFIX } from '../plan/naming.js';
import type { OwnedSource } from '../types.js';
import { StorageLimitError, type Sink, type SourceMeta } from './types.js';

const API = 'https://www.chatbase.co/api/v2';

interface SourceItem {
  id: string;
  type: string;
  name: string | null;
  size: number;
  status: string;
}

interface ListResponse {
  data: SourceItem[];
  pagination: { cursor: string | null; hasMore: boolean; total: number };
}

interface SummaryResponse {
  texts?: { count: number; size: number };
}

export class ChatbaseRestSink implements Sink {
  readonly kind = 'rest' as const;
  private readonly limiter: RateLimiter;

  constructor(
    private readonly apiKey: string,
    private readonly agentId: string,
    private readonly fetchFn: FetchFn = fetch,
    opts: { requestsPer10s?: number; trainingWaitMs?: number; pollMs?: number } = {},
  ) {
    if (!apiKey) throw new UserError('CHATBASE_API_KEY is not set', ExitCode.AuthOrPlan);
    this.limiter = new RateLimiter(opts.requestsPer10s ?? 80, 10_000);
    this.trainingWaitMs = opts.trainingWaitMs ?? 120_000;
    this.pollMs = opts.pollMs ?? 3_000;
  }

  private readonly trainingWaitMs: number;
  private readonly pollMs: number;

  private base(): string {
    return `${API}/agents/${encodeURIComponent(this.agentId)}/sources`;
  }

  private async call<T>(
    label: string,
    path: string,
    init: RequestInit = {},
    retryable: (e: unknown) => boolean = isRetryable,
  ): Promise<T> {
    return withRetry(
      label,
      async () => {
        await this.limiter.take();
        const res = await this.fetchFn(path, {
          ...init,
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        });
        try {
          return await readJson<T>(res, `Chatbase ${label}`);
        } catch (e) {
          throw this.translate(e);
        }
      },
      undefined,
      retryable,
    );
  }

  /** Map plan and auth errors to clear, non-retryable user errors. */
  private translate(e: unknown): unknown {
    if (!(e instanceof HttpError)) return e;
    if (e.code === 'SUBSCRIPTION_API_RESTRICTED_PLAN') {
      return new UserError(
        'Chatbase API v2 needs the Standard plan or higher. Use `sink: export` on Free/Hobby, or upgrade.',
        ExitCode.AuthOrPlan,
      );
    }
    if (e.status === 401)
      return new UserError('Chatbase rejected the API key (401). Check CHATBASE_API_KEY.', ExitCode.AuthOrPlan);
    if (e.code === 'AGENT_NOT_FOUND') {
      return new UserError(`Chatbase agent "${this.agentId}" was not found. Check agentId.`, ExitCode.ConfigInvalid);
    }
    if (e.code === 'SOURCE_SIZE_LIMIT_EXCEEDED') return new StorageLimitError(e.message);
    return e;
  }

  async list(): Promise<OwnedSource[]> {
    const out: OwnedSource[] = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({ type: 'text', name: PREFIX, limit: '100' });
      if (cursor) qs.set('cursor', cursor);
      const page: ListResponse = await this.call<ListResponse>('list sources', `${this.base()}?${qs}`);
      for (const s of page.data) {
        const d = decodeName(s.name);
        // The API filter is a substring match, so confirm the prefix ourselves.
        if (!d || s.type !== 'text') continue;
        out.push({
          sourceId: s.id,
          videoId: d.videoId,
          hash: d.hash,
          part: d.part,
          name: s.name ?? '',
          size: s.size,
          status: s.status,
        });
      }
      cursor = page.pagination.hasMore ? page.pagination.cursor : null;
    } while (cursor);
    return out;
  }

  async create(_videoId: string, name: string, content: string, _meta: SourceMeta): Promise<void> {
    const body = JSON.stringify({ type: 'text', name, content });
    // POST has no idempotency key. Only 429 (never processed) is retried blindly; after a
    // 5xx or network error the source may exist, so look it up before trying again.
    try {
      await this.call('create source', this.base(), { method: 'POST', body }, isRateLimited);
    } catch (e) {
      if (!isRetryable(e)) throw e;
      if (await this.existsByName(name)) return;
      await this.call('create source (retry)', this.base(), { method: 'POST', body }, isRateLimited);
    }
  }

  private async existsByName(name: string): Promise<boolean> {
    const qs = new URLSearchParams({ type: 'text', name, limit: '100' });
    const page = await this.call<ListResponse>('find source', `${this.base()}?${qs}`);
    return page.data.some((s) => s.name === name);
  }

  async update(existing: OwnedSource, name: string, content: string, meta: SourceMeta): Promise<void> {
    const path = `${this.base()}/${encodeURIComponent(existing.sourceId)}`;
    try {
      await this.call('update source', path, { method: 'PUT', body: JSON.stringify({ name, content }) });
    } catch (e) {
      if (e instanceof HttpError && (e.code === 'SOURCE_PENDING_DELETION' || e.code === 'SOURCE_NOT_FOUND')) {
        // Someone deleted it in the dashboard since we listed. Recreate it.
        await this.create(existing.videoId, name, content, meta);
        return;
      }
      if (!(e instanceof HttpError && e.code === 'SOURCE_IS_TRAINING')) throw e;
      // One writer at a time: wait for the current training to land, then retry once.
      await this.waitTrained(existing.sourceId);
      await this.call('update source (retry)', path, { method: 'PUT', body: JSON.stringify({ name, content }) });
    }
  }

  async remove(existing: OwnedSource): Promise<void> {
    try {
      await this.call('delete source', `${this.base()}/${encodeURIComponent(existing.sourceId)}`, { method: 'DELETE' });
    } catch (e) {
      if (e instanceof HttpError && (e.code === 'SOURCE_ALREADY_PENDING_DELETION' || e.code === 'SOURCE_NOT_FOUND'))
        return;
      throw e;
    }
  }

  private async waitTrained(sourceId: string): Promise<void> {
    const deadline = Date.now() + this.trainingWaitMs;
    while (Date.now() < deadline) {
      const s = await this.call<SourceItem>('get source', `${this.base()}/${encodeURIComponent(sourceId)}`);
      if (s.status === 'trained' || s.status === 'failed') return;
      await sleep(this.pollMs);
    }
    log.warn('source still training after wait', { sourceId });
  }

  async textBytesUsed(): Promise<number | undefined> {
    const s = await this.call<SummaryResponse>('sources summary', `${this.base()}/summary`);
    return s.texts?.size;
  }

  async finish(): Promise<void> {
    /* writes are already live; training runs on Chatbase's side */
  }

  /** Used by `doctor`: proves the key, the plan and the agent in one cheap call. */
  async check(): Promise<{ textSources: number; textBytes: number }> {
    const s = await this.call<SummaryResponse>('sources summary', `${this.base()}/summary`);
    return { textSources: s.texts?.count ?? 0, textBytes: s.texts?.size ?? 0 };
  }
}
