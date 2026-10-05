import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ApifyTranscriptProvider, mapItem } from '../src/providers/apify.js';
import { UserError } from '../src/util/errors.js';

const items = JSON.parse(readFileSync(new URL('./fixtures/actor-items.json', import.meta.url), 'utf8')) as Parameters<
  typeof mapItem
>[0][];

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

const opts = {
  languages: ['en'],
  machineTranslate: true,
  ai: { enabled: true, maxMinutesPerRun: 30, skipLongerThanMin: 60 },
};

function scripted(responses: ((url: string, init: RequestInit) => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return responses[i++]!(url, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('ApifyTranscriptProvider', () => {
  it('starts a run with the mapped input, polls, and pages the dataset', async () => {
    const { fetchFn, calls } = scripted([
      () => json({ data: { id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' } }),
      () => json({ data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1', usageTotalUsd: 0.002 } }),
      () =>
        json([...items, { url: 'https://www.youtube.com/watch?v=zzzzzzzzzzz', error_code: 'NO_CAPTIONS_AVAILABLE' }]),
    ]);
    const p = new ApifyTranscriptProvider(
      'apify_api_TESTTOKEN123',
      'codepoetry/youtube-transcript-ai-scraper',
      '2.8.3',
      fetchFn,
      0,
    );
    const res = await p.transcribe(['https://www.youtube.com/watch?v=tM3wpoieYTc'], opts);

    expect(calls[0]!.url).toBe(
      'https://api.apify.com/v2/acts/codepoetry~youtube-transcript-ai-scraper/runs?build=2.8.3',
    );
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer apify_api_TESTTOKEN123');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      startUrls: [{ url: 'https://www.youtube.com/watch?v=tM3wpoieYTc' }],
      enableAiFallback: true,
      maxAiMinutes: 30,
      skipAiFallbackIfLongerThan: 60,
      machineTranslateCaptions: true,
      outputFormats: ['json', 'llm'],
    });
    expect(calls[2]!.url).toContain('/datasets/ds1/items?clean=true&format=json&offset=0&limit=100');
    expect(res.transcripts.map((t) => t.id)).toEqual(['tM3wpoieYTc', 'R3omXx5vPqI']);
    expect(res.failures).toEqual([
      { id: 'zzzzzzzzzzz', code: 'NO_CAPTIONS_AVAILABLE', message: 'no transcript returned' },
    ]);
    expect(res.usageUsd).toBe(0.002);
  });

  it('fails clearly when the run does not succeed', async () => {
    const { fetchFn } = scripted([() => json({ data: { id: 'run1', status: 'FAILED', defaultDatasetId: 'ds1' } })]);
    const p = new ApifyTranscriptProvider('apify_api_TESTTOKEN123', 'a/b', undefined, fetchFn, 0);
    await expect(p.transcribe(['https://youtu.be/tM3wpoieYTc'], opts)).rejects.toThrow(/FAILED/);
  });

  it('does nothing for an empty batch', async () => {
    const p = new ApifyTranscriptProvider('', 'a/b');
    expect(await p.transcribe([], opts)).toEqual({ transcripts: [], failures: [] });
  });

  it('asks for a token only when it is needed', async () => {
    const p = new ApifyTranscriptProvider('', 'a/b');
    await expect(p.transcribe(['https://youtu.be/tM3wpoieYTc'], opts)).rejects.toThrow(UserError);
  });

  it('maps upload dates and keeps items without an id out', () => {
    const t = mapItem(items[0]!);
    expect(t && 'publishedAt' in t ? t.publishedAt : undefined).toBe('2026-07-15');
    expect(mapItem({})).toBeUndefined();
  });
});
