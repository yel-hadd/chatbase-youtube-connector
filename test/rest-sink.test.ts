import { describe, expect, it } from 'vitest';
import { ChatbaseRestSink } from '../src/sinks/rest.js';
import { StorageLimitError } from '../src/sinks/types.js';
import { UserError } from '../src/util/errors.js';
import { RateLimiter } from '../src/util/http.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handlers: Handler[]): {
  fetchFn: typeof fetch;
  calls: { url: string; method: string; body?: string }[];
} {
  const calls: { url: string; method: string; body?: string }[] = [];
  let i = 0;
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body as string | undefined });
    const h = handlers[Math.min(i++, handlers.length - 1)]!;
    return h(String(url), init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const item = (id: string, name: string) => ({
  id,
  type: 'text',
  name,
  size: 10,
  status: 'trained',
  createdAt: 'x',
  metadata: {},
});

describe('ChatbaseRestSink', () => {
  it('lists only our sources across pages', async () => {
    const { fetchFn, calls } = fakeFetch([
      () =>
        json(200, {
          data: [item('s1', 'YT·aaaaaaaaaaa·11111111·One'), item('s2', 'Notes about YT·')],
          pagination: { cursor: 'c2', hasMore: true, total: 3 },
        }),
      () =>
        json(200, {
          data: [item('s3', 'YT·bbbbbbbbbbb·22222222·p2·Two')],
          pagination: { cursor: null, hasMore: false, total: 3 },
        }),
    ]);
    const sink = new ChatbaseRestSink('key-12345678', 'agent1', fetchFn);
    const owned = await sink.list();
    expect(owned.map((o) => [o.sourceId, o.videoId, o.part])).toEqual([
      ['s1', 'aaaaaaaaaaa', 1],
      ['s3', 'bbbbbbbbbbb', 2],
    ]);
    expect(calls[0]!.url).toContain('/agents/agent1/sources?type=text&name=YT%C2%B7&limit=100');
    expect(calls[1]!.url).toContain('cursor=c2');
  });

  it('sends text sources with the right body and auth', async () => {
    const { fetchFn, calls } = fakeFetch([() => json(201, item('s9', 'YT·x'))]);
    await new ChatbaseRestSink('key-12345678', 'agent1', fetchFn).create('x', 'YT·n', 'body', {
      title: 't',
      hash: 'h',
      part: 1,
      url: 'u',
    });
    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ type: 'text', name: 'YT·n', content: 'body' });
  });

  it('turns the plan error into a clear user error', async () => {
    const { fetchFn } = fakeFetch([
      () => json(403, { error: { code: 'SUBSCRIPTION_API_RESTRICTED_PLAN', message: 'Standard needed' } }),
    ]);
    await expect(new ChatbaseRestSink('key-12345678', 'a', fetchFn).list()).rejects.toThrow(UserError);
  });

  it('raises StorageLimitError on 422 SOURCE_SIZE_LIMIT_EXCEEDED', async () => {
    const { fetchFn } = fakeFetch([() => json(422, { error: { code: 'SOURCE_SIZE_LIMIT_EXCEEDED' } })]);
    await expect(
      new ChatbaseRestSink('key-12345678', 'a', fetchFn).create('x', 'n', 'c', {
        title: 't',
        hash: 'h',
        part: 1,
        url: 'u',
      }),
    ).rejects.toThrow(StorageLimitError);
  });

  it('waits for training and retries an update on 409 SOURCE_IS_TRAINING', async () => {
    const { fetchFn, calls } = fakeFetch([
      () => json(409, { error: { code: 'SOURCE_IS_TRAINING' } }),
      () => json(200, item('s1', 'n')),
      () => json(200, item('s1', 'n')),
    ]);
    const sink = new ChatbaseRestSink('key-12345678', 'a', fetchFn, { pollMs: 1 });
    await sink.update({ sourceId: 's1', videoId: 'v', hash: 'h', part: 1, name: 'n', size: 1 }, 'n2', 'c2', {
      title: 't',
      hash: 'h',
      part: 1,
      url: 'u',
    });
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'PUT']);
  });

  const meta = { title: 't', hash: 'h', part: 1, url: 'u' };
  const owned = { sourceId: 's1', videoId: 'aaaaaaaaaaa', hash: 'h', part: 1, name: 'n', size: 1 };

  it('reports a missing agent clearly', async () => {
    const { fetchFn } = fakeFetch([() => json(404, { error: { code: 'AGENT_NOT_FOUND' } })]);
    await expect(new ChatbaseRestSink('key-12345678', 'nope', fetchFn).list()).rejects.toThrow(/agentId/);
  });

  it('treats deleting an already-gone source as done', async () => {
    const { fetchFn } = fakeFetch([() => json(404, { error: { code: 'SOURCE_NOT_FOUND' } })]);
    await expect(new ChatbaseRestSink('key-12345678', 'a', fetchFn).remove(owned)).resolves.toBeUndefined();
  });

  it('recreates a source that was deleted in the dashboard since we listed', async () => {
    const { fetchFn, calls } = fakeFetch([
      () => json(409, { error: { code: 'SOURCE_PENDING_DELETION' } }),
      () => json(201, item('s2', 'YT·new')),
    ]);
    await new ChatbaseRestSink('key-12345678', 'a', fetchFn).update(owned, 'YT·new', 'c', meta);
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'POST']);
  });

  it('does not duplicate a create that landed before a 5xx', async () => {
    const { fetchFn, calls } = fakeFetch([
      () => json(502, { error: { code: 'UPSTREAM' } }),
      () => json(200, { data: [item('s9', 'YT·n')], pagination: { cursor: null, hasMore: false, total: 1 } }),
    ]);
    await new ChatbaseRestSink('key-12345678', 'a', fetchFn).create('x', 'YT·n', 'c', meta);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET']);
  });

  it('retries a create after a 5xx when the source did not land', async () => {
    const { fetchFn, calls } = fakeFetch([
      () => json(502, { error: { code: 'UPSTREAM' } }),
      () => json(200, { data: [], pagination: { cursor: null, hasMore: false, total: 0 } }),
      () => json(201, item('s9', 'YT·n')),
    ]);
    await new ChatbaseRestSink('key-12345678', 'a', fetchFn).create('x', 'YT·n', 'c', meta);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST']);
  });

  it('gives up after a second 5xx on create instead of posting again blindly', async () => {
    const { fetchFn, calls } = fakeFetch([
      () => json(502, { error: { code: 'UPSTREAM' } }),
      () => json(200, { data: [], pagination: { cursor: null, hasMore: false, total: 0 } }),
      () => json(502, { error: { code: 'UPSTREAM' } }),
    ]);
    await expect(new ChatbaseRestSink('key-12345678', 'a', fetchFn).create('x', 'YT·n', 'c', meta)).rejects.toThrow(
      /502/,
    );
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST']);
  });

  it('retries 429 using Retry-After', async () => {
    const { fetchFn, calls } = fakeFetch([
      () => json(429, { error: { code: 'RATE_LIMIT_TOO_MANY_REQUESTS' } }, { 'retry-after': '0' }),
      () => json(200, { data: [], pagination: { cursor: null, hasMore: false, total: 0 } }),
    ]);
    await new ChatbaseRestSink('key-12345678', 'a', fetchFn).list();
    expect(calls).toHaveLength(2);
  });
});

describe('RateLimiter', () => {
  it('holds requests beyond the window budget', async () => {
    let now = 0;
    const waits: number[] = [];
    const rl = new RateLimiter(
      2,
      1000,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    await rl.take();
    await rl.take();
    await rl.take();
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
  });
});
