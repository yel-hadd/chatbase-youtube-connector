import { HttpError } from './errors.js';
import { log } from './log.js';

export type FetchFn = typeof fetch;

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export const defaultRetry: RetryOptions = { retries: 5, baseDelayMs: 500, maxDelayMs: 30_000 };

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 429, 5xx and network failures are retried; other 4xx are not. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof HttpError) return e.status === 429 || e.status >= 500;
  return e instanceof TypeError; // fetch network failure
}

export async function withRetry<T>(label: string, fn: () => Promise<T>, opts: RetryOptions = defaultRetry): Promise<T> {
  const nap = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= opts.retries || !isRetryable(e)) throw e;
      const retryAfter = e instanceof HttpError && e.retryAfterSec !== undefined ? e.retryAfterSec * 1000 : undefined;
      const backoff = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
      const delay = retryAfter ?? Math.round(backoff / 2 + Math.random() * (backoff / 2));
      log.warn('retrying', { label, attempt: attempt + 1, delayMs: delay, reason: (e as Error).message });
      await nap(delay);
    }
  }
}

/** Parse a JSON response, turning non-2xx into HttpError with the API's error code. */
export async function readJson<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    const ra = res.headers.get('retry-after');
    throw new HttpError(
      res.status,
      err?.code,
      `${context}: HTTP ${res.status}${err?.code ? ` ${err.code}` : ''}${err?.message ? ` (${err.message})` : ''}`,
      ra !== null && !Number.isNaN(Number(ra)) ? Number(ra) : undefined,
    );
  }
  return body as T;
}

/**
 * Sliding-window token bucket. Chatbase allows 100 requests per 10 s per key;
 * we default to 80 to leave headroom for other clients on the same key.
 */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly nap: (ms: number) => Promise<void> = sleep,
  ) {}

  async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
      if (this.stamps.length < this.max) {
        this.stamps.push(t);
        return;
      }
      const wait = this.windowMs - (t - this.stamps[0]!) + 5;
      await this.nap(wait);
    }
  }
}
