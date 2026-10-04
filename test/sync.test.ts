import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncJob, type TranscriptProvider } from '../src/sync.js';
import { parseConfig } from '../src/config/load.js';
import { ExportSink } from '../src/sinks/export.js';
import { mapItem, type TranscribeOptions } from '../src/providers/apify.js';
import type { Transcript } from '../src/types.js';
import { ExitCode } from '../src/util/errors.js';

const items = JSON.parse(readFileSync(new URL('./fixtures/actor-items.json', import.meta.url), 'utf8'));
const feed = readFileSync(new URL('./fixtures/chatbase-feed.xml', import.meta.url), 'utf8');
const transcripts = items.map(mapItem) as Transcript[];

// RSS feed fixture contains tM3wpoieYTc and R3omXx5vPqI among 15 videos.
const feedFetch = (async () => new Response(feed)) as typeof fetch;

class FakeProvider implements TranscriptProvider {
  calls: Array<{ urls: string[]; opts: TranscribeOptions }> = [];
  async transcribe(urls: string[], opts: TranscribeOptions) {
    this.calls.push({ urls, opts });
    const wanted = new Set(urls.map((u) => u.split('v=')[1]));
    return {
      transcripts: transcripts.filter((t) => wanted.has(t.id)),
      failures: [...wanted].filter((id) => !transcripts.some((t) => t.id === id)).map((id) => ({ id: id!, code: 'NO_CAPTIONS_AVAILABLE', message: 'none' })),
      runId: 'run1',
      usageUsd: 0.002,
    };
  }
}

const cfg = (extra = '') => `version: 1
defaults:
  budget: { maxUsdPerRun: 1 }
jobs:
  - name: chatbase
    sink: export
    sources:
      - channel: "UCpVc2Oc61kcUfBuz9lzP4MA"
${extra}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cbyt-'));
});

describe('syncJob (export sink, end to end with real fixtures)', () => {
  it('transcribes new videos, writes files, and is idempotent on re-run', async () => {
    const [job] = parseConfig(cfg(), {});
    const provider = new FakeProvider();
    const first = await syncJob(job!, { provider, sink: new ExportSink(dir), fetchFn: feedFetch }, { full: false, dryRun: false, allowMassDelete: false });
    expect(first.exitCode).toBe(ExitCode.Ok);
    expect(first.report.counts.created).toBe(2);
    // 15 in the feed, 1 short excluded, 2 with transcripts, the rest had no captions (skipped).
    expect(first.report.counts.excluded).toBe(1);
    const files = await readdir(dir);
    expect(files).toEqual(expect.arrayContaining(['tM3wpoieYTc.txt', 'R3omXx5vPqI.txt', 'manifest.json', 'index.csv', 'CHANGES.txt']));
    const doc = await readFile(join(dir, 'tM3wpoieYTc.txt'), 'utf8');
    expect(doc).toContain('[watch](https://youtu.be/tM3wpoieYTc?t=0)');

    // Second run: the two owned videos are not re-transcribed; nothing is written.
    const provider2 = new FakeProvider();
    const second = await syncJob(job!, { provider: provider2, sink: new ExportSink(dir), fetchFn: feedFetch }, { full: false, dryRun: false, allowMassDelete: false });
    expect(second.report.counts.created).toBe(0);
    expect(provider2.calls[0]!.urls.some((u) => u.includes('tM3wpoieYTc'))).toBe(false);
  });

  it('dry run spends nothing and writes nothing', async () => {
    const [job] = parseConfig(cfg(), {});
    const provider = new FakeProvider();
    const out = await syncJob(job!, { provider, sink: new ExportSink(dir), fetchFn: feedFetch }, { full: false, dryRun: true, allowMassDelete: false });
    expect(provider.calls).toHaveLength(0);
    expect(out.report.counts.planned).toBe(14);
    expect(await readdir(dir)).toEqual([]);
  });

  it('aborts with BudgetExceeded before spending', async () => {
    const [job] = parseConfig(cfg('    budget: { maxUsdPerRun: 0.001 }\n'), {});
    const provider = new FakeProvider();
    const out = await syncJob(job!, { provider, sink: new ExportSink(dir), fetchFn: feedFetch }, { full: false, dryRun: false, allowMassDelete: false });
    expect(out.exitCode).toBe(ExitCode.BudgetExceeded);
    expect(provider.calls).toHaveLength(0);
  });

  it('full mode with prune deletes videos no longer on the channel', async () => {
    const [job] = parseConfig(cfg('    prune: true\n    maxVideos: 50\n'), {});
    const sink = new ExportSink(dir);
    // Seed: one owned video that the listing will not return.
    await sink.create('zzzzzzzzzzz', 'n', 'old', { title: 'Old', hash: '00000000', part: 1, url: 'u' });
    await sink.finish();
    const provider = new FakeProvider();
    provider.transcribe = async (_urls, _opts) => ({ transcripts, failures: [], runId: 'r', usageUsd: 0 });
    const out = await syncJob(job!, { provider, sink: new ExportSink(dir), fetchFn: feedFetch }, { full: true, dryRun: false, allowMassDelete: false });
    expect(out.report.counts.deleted).toBe(1);
    expect(out.report.counts.created).toBe(2);
    expect((await readdir(dir)).includes('zzzzzzzzzzz.txt')).toBe(false);
  });
});
