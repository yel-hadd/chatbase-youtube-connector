import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncJob, type TranscriptProvider } from '../src/sync.js';
import { parseConfig } from '../src/config/load.js';
import { ExportSink } from '../src/sinks/export.js';
import { ChatbaseRestSink } from '../src/sinks/rest.js';
import { sourceListingUrl } from '../src/discover/youtube.js';
import { mapItem, type TranscribeOptions, type TranscribeResult } from '../src/providers/apify.js';
import { SkipCache, skipFingerprint } from '../src/state.js';
import { renderSummary, writeReports, type RunReport } from '../src/report.js';
import type { Transcript } from '../src/types.js';
import { ExitCode } from '../src/util/errors.js';

const items = JSON.parse(readFileSync(new URL('./fixtures/actor-items.json', import.meta.url), 'utf8')) as Parameters<
  typeof mapItem
>[0][];
const real = items.map(mapItem) as Transcript[];

/** A transcript for any id, reusing a real one's segments. */
const fake = (id: string): Transcript => ({ ...real[0]!, id, title: `Video ${id}`, url: `https://youtu.be/${id}` });
const ids = (n: number, prefix: string): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(10, '0')}`.slice(0, 11));

class ScriptedProvider implements TranscriptProvider {
  calls: { urls: string[]; opts: TranscribeOptions }[] = [];
  constructor(private readonly byUrl: (url: string) => Transcript[]) {}
  async transcribe(urls: string[], opts: TranscribeOptions): Promise<TranscribeResult> {
    this.calls.push({ urls, opts });
    return { transcripts: urls.flatMap((u) => this.byUrl(u)), failures: [], runId: 'r', usageUsd: 0 };
  }
}

const noFetch = (async () => new Response('', { status: 500 })) as typeof fetch;
const run = { full: true, dryRun: false, allowMassDelete: false };

async function seededExport(videoIds: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cbyt-'));
  const sink = new ExportSink(dir);
  for (const id of videoIds) await sink.create(id, 'n', 'x', { title: id, hash: '00000000', part: 1, url: 'u' });
  await sink.finish();
  return dir;
}

describe('full runs', () => {
  it('lists a channel through its uploads playlist, which includes Shorts and live recordings', async () => {
    expect(await sourceListingUrl({ channel: 'UCpVc2Oc61kcUfBuz9lzP4MA' })).toBe(
      'https://www.youtube.com/playlist?list=UUpVc2Oc61kcUfBuz9lzP4MA',
    );
  });

  it('skips prune when any single source hit maxVideos, even if the total did not', async () => {
    const channelIds = ids(3, 'c');
    const dir = await seededExport(['olderchanne']); // owned, beyond the channel cap
    const [job] = parseConfig(
      `version: 1
jobs:
  - name: j
    sink: export
    prune: true
    maxVideos: 3
    sources:
      - channel: "UCpVc2Oc61kcUfBuz9lzP4MA"
      - playlist: "PLos3GBCBcmJVmiJzQrSixdxQ6pqZe9ExX"
`,
      {},
    );
    const provider = new ScriptedProvider((u) =>
      u.includes('list=UU') ? channelIds.map(fake) : [fake('playlist001')],
    );
    const out = await syncJob(job!, { provider, sink: new ExportSink(dir), fetchFn: noFetch }, run);
    expect(provider.calls).toHaveLength(2); // one listing per source
    expect(out.report.counts.deleted).toBe(0);
  });

  it('budgets a video source as one video, not maxVideos', async () => {
    const [job] = parseConfig(
      `version: 1
jobs:
  - name: j
    sink: export
    budget: { maxUsdPerRun: 0.05 }
    sources: [${ids(11, 'v')
      .map((id) => `{ video: "${id}" }`)
      .join(', ')}]
`,
      {},
    );
    const dir = await mkdtemp(join(tmpdir(), 'cbyt-'));
    const out = await syncJob(
      job!,
      { provider: new ScriptedProvider(() => []), sink: new ExportSink(dir), fetchFn: noFetch },
      {
        ...run,
        dryRun: true,
      },
    );
    expect(out.exitCode).toBe(ExitCode.Ok);
    expect(out.report.spend.estimatedMaxUsd).toBeCloseTo(0.011);
  });

  it('holds back mass deletions but keeps the paid-for creates', async () => {
    const owned = ids(12, 'o');
    const dir = await seededExport(owned);
    const [job] = parseConfig(
      `version: 1
jobs:
  - name: j
    sink: export
    prune: true
    sources: [{ playlist: "PLos3GBCBcmJVmiJzQrSixdxQ6pqZe9ExX" }]
`,
      {},
    );
    const provider = new ScriptedProvider(() => [fake('newvideo001')]);
    const out = await syncJob(job!, { provider, sink: new ExportSink(dir), fetchFn: noFetch }, run);
    expect(out.exitCode).toBe(ExitCode.BudgetExceeded);
    expect(out.report.counts.created).toBe(1);
    expect(out.report.counts.deleted).toBe(0);
    const forced = await syncJob(
      job!,
      { provider, sink: new ExportSink(dir), fetchFn: noFetch },
      { ...run, allowMassDelete: true },
    );
    expect(forced.report.counts.deleted).toBe(12);
  });
});

describe('exclusion deletes over the cap', () => {
  it('abort before any transcription spend', async () => {
    const owned = ids(11, 'x');
    const dir = await seededExport(owned);
    const [job] = parseConfig(
      `version: 1
jobs:
  - name: j
    sink: export
    prune: true
    exclude: [${owned.map((id) => `"${id}"`).join(', ')}]
    sources: [{ video: "tM3wpoieYTc" }]
`,
      {},
    );
    const provider = new ScriptedProvider(() => [real[0]!]);
    const out = await syncJob(job!, { provider, sink: new ExportSink(dir), fetchFn: noFetch }, { ...run, full: false });
    expect(out.exitCode).toBe(ExitCode.BudgetExceeded);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('storage limit', () => {
  it('adds videos until the next would not fit, then stops with exit 3', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cbyt-'));
    const [job] = parseConfig(
      `version: 1
jobs:
  - name: j
    sink: export
    budget: { storageLimitMb: 0.004 }
    sources: [{ playlist: "PLos3GBCBcmJVmiJzQrSixdxQ6pqZe9ExX" }]
`,
      {},
    );
    // Each formatted real transcript is about 3 KB; the limit (~4.2 KB) fits one.
    const provider = new ScriptedProvider(() => [real[0]!, real[1]!]);
    const out = await syncJob(job!, { provider, sink: new ExportSink(dir), fetchFn: noFetch }, run);
    expect(out.report.counts.created).toBe(1);
    expect(out.report.videos.some((v) => v.detail === 'storage limit reached')).toBe(true);
    expect(out.exitCode).toBe(ExitCode.BudgetExceeded);
  });
});

describe('skip cache', () => {
  it('expires entries after the recheck window', () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const c = new SkipCache(undefined, 30, 'fp1', () => now);
    c.remember('aaaaaaaaaaa', 'NO_CAPTIONS_AVAILABLE');
    expect(c.isFresh('aaaaaaaaaaa')?.reason).toBe('NO_CAPTIONS_AVAILABLE');
    now = new Date('2026-02-01T00:00:00Z');
    expect(c.isFresh('aaaaaaaaaaa')).toBeUndefined();
  });
});

describe('rest sink end to end', () => {
  it('creates sources in Chatbase and makes zero writes on a re-run', async () => {
    const store = new Map<string, { id: string; name: string; size: number }>();
    let n = 0;
    const fetchFn = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (url.endsWith('/sources/summary')) return Response.json({ texts: { count: store.size, size: 0 } });
      if (method === 'GET')
        return Response.json({
          data: [...store.values()].map((s) => ({
            ...s,
            type: 'text',
            status: 'trained',
            createdAt: 'x',
            metadata: {},
          })),
          pagination: { cursor: null, hasMore: false, total: store.size },
        });
      if (method === 'POST') {
        const body = JSON.parse(init.body as string) as { name: string; content: string };
        const id = `s${++n}`;
        store.set(id, { id, name: body.name, size: body.content.length });
        return Response.json({ id }, { status: 201 });
      }
      return new Response('', { status: 405 });
    }) as typeof fetch;
    const [job] = parseConfig(
      `version: 1
jobs:
  - name: j
    agentId: agent1
    sources: [{ video: "tM3wpoieYTc" }]
`,
      {},
    );
    const provider = new ScriptedProvider(() => [real[0]!]);
    const sink = () => new ChatbaseRestSink('key-12345678', 'agent1', fetchFn);
    const first = await syncJob(job!, { provider, sink: sink(), fetchFn: noFetch }, run);
    expect(first.report.counts.created).toBe(1);
    expect([...store.values()][0]!.name).toMatch(/^YT·tM3wpoieYTc·[0-9a-f]{8}·Chatbase HelpDesk/);
    const second = await syncJob(job!, { provider, sink: sink(), fetchFn: noFetch }, run);
    expect(second.report.counts.unchanged).toBe(1);
    expect(store.size).toBe(1);
  });
});

describe('report', () => {
  it('renders a summary and writes the JSON report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cbyt-'));
    const r: RunReport = {
      schemaVersion: 1,
      tool: 'chatbase-youtube-sync',
      version: '0.0.0',
      exitCode: 0,
      jobs: [
        {
          job: 'j',
          sink: 'export',
          mode: 'incremental',
          dryRun: false,
          startedAt: 'x',
          counts: { created: 1, updated: 0, deleted: 0, unchanged: 0, excluded: 0, failed: 0, planned: 0, skipped: 0 },
          spend: { estimatedMaxUsd: 0.001, apifyRunIds: [] },
          videos: [{ videoId: 'tM3wpoieYTc', title: 'A | B', action: 'created' }],
          errors: [],
        },
      ],
    };
    const md = renderSummary(r);
    expect(md).toContain('| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
    expect(md).toContain('$0.0010');
    expect(md).toContain('[A / B](https://youtu.be/tM3wpoieYTc)');
    await writeReports(r, join(dir, 'report.json'));
    expect(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'))).toMatchObject({ exitCode: 0 });
  });
});

describe('review fixes', () => {
  const plConfig = (extra = '') => `version: 1
jobs:
  - name: j
    sink: export
    sources:
      - channel: "UCpVc2Oc61kcUfBuz9lzP4MA"
      - playlist: "PLos3GBCBcmJVmiJzQrSixdxQ6pqZe9ExX"
${extra}`;

  it('processes a video once when two sources both list it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cbyt-'));
    const [job] = parseConfig(plConfig(), {});
    const provider = new ScriptedProvider(() => [real[0]!]);
    const out = await syncJob(job!, { provider, sink: new ExportSink(dir), fetchFn: noFetch }, run);
    expect(out.report.counts.created).toBe(1);
    expect(out.report.videos.filter((v) => v.videoId === real[0]!.id && v.action === 'created')).toHaveLength(1);
  });

  it('counts exclusions and YouTube deletions against one delete cap', async () => {
    const excludedIds = ids(6, 'e');
    const goneIds = ids(6, 'g');
    const dir = await seededExport([...excludedIds, ...goneIds]);
    const [job] = parseConfig(
      `version: 1
jobs:
  - name: j
    sink: export
    prune: true
    exclude: [${excludedIds.map((i) => `"${i}"`).join(', ')}]
    sources: [{ playlist: "PLos3GBCBcmJVmiJzQrSixdxQ6pqZe9ExX" }]
`,
      {},
    );
    const out = await syncJob(
      job!,
      { provider: new ScriptedProvider(() => [real[0]!]), sink: new ExportSink(dir), fetchFn: noFetch },
      run,
    );
    expect(out.exitCode).toBe(ExitCode.BudgetExceeded);
    // Exclusions (6) are within the cap and applied; the 6 YouTube removals would exceed it.
    expect(out.report.counts.deleted).toBe(6);
    expect(out.report.counts.created).toBe(1);
  });

  it('keeps the other sources when one listing fails, and does not prune', async () => {
    const dir = await seededExport(['ownedolder1']);
    const [job] = parseConfig(plConfig('    prune: true\n'), {});
    const provider: TranscriptProvider = {
      async transcribe(urls) {
        if (urls[0]!.includes('list=UU')) throw new Error('Actor run FAILED');
        return { transcripts: [real[1]!], failures: [], runId: 'r', usageUsd: 0 };
      },
    };
    const out = await syncJob(job!, { provider, sink: new ExportSink(dir), fetchFn: noFetch }, run);
    expect(out.report.counts.created).toBe(1);
    expect(out.report.counts.deleted).toBe(0);
    expect(out.report.errors.join(' ')).toMatch(/listing failed/);
  });

  it('does not re-pay AI transcription for a cached skip in full mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cbyt-'));
    const [job] = parseConfig(plConfig('    aiFallback: { enabled: true }\n'), {});
    const cache = new SkipCache(undefined, 30, 'fp');
    cache.remember('nocaptions1', 'too-short');
    const calls: string[][] = [];
    const provider: TranscriptProvider = {
      async transcribe(urls) {
        calls.push(urls);
        return { transcripts: [], failures: [{ id: 'nocaptions1', code: 'NO_CAPTIONS_AVAILABLE', message: '' }] };
      },
    };
    await syncJob(job!, { provider, sink: new ExportSink(dir), fetchFn: noFetch, skipCache: cache }, run);
    expect(calls).toHaveLength(2); // the two listings, no AI run
  });

  it('forgets skips decided under different settings', () => {
    const a = new SkipCache(undefined, 30, 'settings-a');
    a.remember('aaaaaaaaaaa', 'short');
    expect(a.isFresh('aaaaaaaaaaa')).toBeDefined();
    const [base] = parseConfig(plConfig(), {});
    const [shorts] = parseConfig(plConfig('    includeShorts: true\n'), {});
    expect(skipFingerprint(base!)).not.toBe(skipFingerprint(shorts!));
  });

  it('writes a shrinking video’s new parts before removing its surplus part', async () => {
    const order: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'cbyt-'));
    const inner = new ExportSink(dir);
    const id = real[0]!.id;
    await inner.create(id, 'n', 'x', { title: 't', hash: '00000000', part: 1, url: 'u' });
    await inner.create(id, 'n', 'y', { title: 't', hash: '00000000', part: 2, url: 'u' });
    await inner.finish();
    const sink = new ExportSink(dir);
    const spy: typeof sink = Object.assign(Object.create(Object.getPrototypeOf(sink) as object) as typeof sink, sink, {
      update: async (...a: Parameters<typeof sink.update>) => {
        order.push(`update p${a[3].part}`);
        return sink.update(...a);
      },
      remove: async (o: Parameters<typeof sink.remove>[0]) => {
        order.push(`remove p${o.part}`);
        return sink.remove(o);
      },
    });
    const [job] = parseConfig(
      `version: 1
jobs:
  - name: j
    sink: export
    sources: [{ video: "${id}" }]
`,
      {},
    );
    await syncJob(job!, { provider: new ScriptedProvider(() => [real[0]!]), sink: spy, fetchFn: noFetch }, run);
    expect(order).toEqual(['update p1', 'remove p2']);
  });
});
