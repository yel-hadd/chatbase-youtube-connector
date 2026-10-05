import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRef, listPlaylist, parsePlaylistPage } from '../src/discover/youtube.js';
import { parseConfig } from '../src/config/load.js';
import { syncJob, type TranscriptProvider } from '../src/sync.js';
import { ExportSink } from '../src/sinks/export.js';
import { mapItem } from '../src/providers/apify.js';
import type { Transcript } from '../src/types.js';

const items = JSON.parse(readFileSync(new URL('./fixtures/actor-items.json', import.meta.url), 'utf8')) as Parameters<
  typeof mapItem
>[0][];
const feed = readFileSync(new URL('./fixtures/chatbase-feed.xml', import.meta.url), 'utf8');
const transcripts = items.map(mapItem) as Transcript[];

const PL = 'PLos3GBCBcmJVmiJzQrSixdxQ6pqZe9ExX';
const playlistHtml = (ids: string[], total: number): string =>
  `"numVideosText":{"runs":[{"text":"${total}"}]}` +
  ids.map((id) => `"watchEndpoint":{"videoId":"${id}","playlistId":"${PL}","index":1}`).join(',') +
  // An unrelated playlist on the same page must not leak in.
  `"watchEndpoint":{"videoId":"zzzzzzzzzzz","playlistId":"PLotherotherother"}`;

describe('classifyRef', () => {
  it.each([
    ['https://www.youtube.com/watch?v=tM3wpoieYTc', { kind: 'video', id: 'tM3wpoieYTc' }],
    ['https://www.youtube.com/watch?v=tM3wpoieYTc&list=PLabcdefghijkl', { kind: 'video', id: 'tM3wpoieYTc' }],
    [`https://www.youtube.com/playlist?list=${PL}`, { kind: 'playlist', id: PL }],
    [PL, { kind: 'playlist', id: PL }],
    ['tM3wpoieYTc', { kind: 'video', id: 'tM3wpoieYTc' }],
    ['not a thing', undefined],
  ])('%s', (input, want) => {
    expect(classifyRef(input)).toEqual(want);
  });
});

describe('parsePlaylistPage', () => {
  it('reads the videos of the requested playlist only, and the total', () => {
    const l = parsePlaylistPage(playlistHtml(['tM3wpoieYTc', 'R3omXx5vPqI'], 2), PL);
    expect(l).toEqual({ ids: ['tM3wpoieYTc', 'R3omXx5vPqI'], total: 2, complete: true });
  });
  it('flags a truncated listing', () => {
    expect(parsePlaylistPage(playlistHtml(['tM3wpoieYTc'], 150), PL).complete).toBe(false);
  });
  it('uses the Data API when a key is set, following pages', async () => {
    const pages = [
      { items: [{ contentDetails: { videoId: 'aaaaaaaaaaa' } }], nextPageToken: 'p2' },
      { items: [{ contentDetails: { videoId: 'bbbbbbbbbbb' } }] },
    ];
    let i = 0;
    const urls: string[] = [];
    const fetchFn = (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify(pages[i++]));
    }) as typeof fetch;
    const l = await listPlaylist(PL, fetchFn, 'test-key');
    expect(l).toEqual({ ids: ['aaaaaaaaaaa', 'bbbbbbbbbbb'], total: 2, complete: true });
    expect(urls[1]).toContain('pageToken=p2');
  });
});

describe('exclude config', () => {
  it('merges job entries with defaults and rejects junk', () => {
    const cfg = `version: 1
defaults:
  exclude: ["tM3wpoieYTc"]
jobs:
  - name: a
    sink: export
    exclude: ["${PL}"]
    sources: [{ channel: "UCpVc2Oc61kcUfBuz9lzP4MA" }]
`;
    expect(parseConfig(cfg, {})[0]!.exclude).toEqual(['tM3wpoieYTc', PL]);
    expect(() => parseConfig(cfg.replace(PL, 'nope'), {})).toThrow(/not a YouTube video or playlist/);
  });
});

class FakeProvider implements TranscriptProvider {
  urls: string[] = [];
  async transcribe(urls: string[]) {
    this.urls.push(...urls);
    const wanted = new Set(urls.map((u) => u.split('v=')[1]));
    return { transcripts: transcripts.filter((t) => wanted.has(t.id)), failures: [], runId: 'r', usageUsd: 0 };
  }
}

// Serves the RSS feed for the channel and a playlist page for the excluded playlist.
const fetchFn = (async (u: string) =>
  u.includes('/playlist?list=') ? new Response(playlistHtml(['R3omXx5vPqI'], 1)) : new Response(feed)) as typeof fetch;

const cfg = (extra: string) => `version: 1
jobs:
  - name: chatbase
    sink: export
    sources: [{ channel: "UCpVc2Oc61kcUfBuz9lzP4MA" }]
${extra}`;

describe('sync with exclusions', () => {
  it('never transcribes excluded videos or videos of excluded playlists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cbyt-'));
    const [job] = parseConfig(cfg(`    exclude: ["tM3wpoieYTc", "${PL}"]\n`), {});
    const provider = new FakeProvider();
    const out = await syncJob(
      job!,
      { provider, sink: new ExportSink(dir), fetchFn },
      { full: false, dryRun: false, allowMassDelete: false },
    );
    expect(provider.urls.some((u) => u.includes('tM3wpoieYTc') || u.includes('R3omXx5vPqI'))).toBe(false);
    expect(
      out.report.videos
        .filter((v) => v.detail === 'excluded in config')
        .map((v) => v.videoId)
        .sort(),
    ).toEqual(['R3omXx5vPqI', 'tM3wpoieYTc']);
  });

  it('removes already-synced videos that become excluded, only with prune', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cbyt-'));
    const [plain] = parseConfig(cfg(''), {});
    await syncJob(
      plain!,
      { provider: new FakeProvider(), sink: new ExportSink(dir), fetchFn },
      { full: false, dryRun: false, allowMassDelete: false },
    );
    expect(await readdir(dir)).toContain('tM3wpoieYTc.txt');

    const [noPrune] = parseConfig(cfg('    exclude: ["tM3wpoieYTc"]\n'), {});
    const kept = await syncJob(
      noPrune!,
      { provider: new FakeProvider(), sink: new ExportSink(dir), fetchFn },
      { full: false, dryRun: false, allowMassDelete: false },
    );
    expect(kept.report.counts.deleted).toBe(0);
    expect(kept.report.videos.find((v) => v.videoId === 'tM3wpoieYTc')?.detail).toMatch(/prune/);

    const [prune] = parseConfig(cfg('    exclude: ["tM3wpoieYTc"]\n    prune: true\n'), {});
    const removed = await syncJob(
      prune!,
      { provider: new FakeProvider(), sink: new ExportSink(dir), fetchFn },
      { full: false, dryRun: false, allowMassDelete: false },
    );
    expect(removed.report.counts.deleted).toBe(1);
    expect(await readdir(dir)).not.toContain('tM3wpoieYTc.txt');
  });
});
