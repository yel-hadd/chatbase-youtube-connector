import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFeed, playlistIdOf, resolveChannelId } from '../src/discover/youtube.js';
import { parseConfig, interpolateEnv } from '../src/config/load.js';
import { excludeReason } from '../src/plan/filters.js';
import { UserError } from '../src/util/errors.js';

const feed = readFileSync(new URL('./fixtures/chatbase-feed.xml', import.meta.url), 'utf8');

describe('parseFeed', () => {
  it('reads the real Chatbase channel feed', () => {
    const refs = parseFeed(feed);
    expect(refs).toHaveLength(15);
    expect(refs[0]).toMatchObject({ id: '5-zlK6vI2Q8', publishedAt: '2026-09-04', isShort: false });
    expect(refs.find((r) => r.id === 'VG1h2Rvcrow')?.isShort).toBe(true);
  });
});

describe('youtube helpers', () => {
  it('extracts playlist ids from URLs', () => {
    expect(playlistIdOf('https://www.youtube.com/playlist?list=PL123')).toBe('PL123');
    expect(playlistIdOf('PL123')).toBe('PL123');
  });
  it('accepts a channel id without a network call', async () => {
    expect(await resolveChannelId('UCpVc2Oc61kcUfBuz9lzP4MA')).toBe('UCpVc2Oc61kcUfBuz9lzP4MA');
  });
  it('resolves a handle from the canonical link', async () => {
    const fakeFetch = (async () =>
      new Response(
        '<link rel="canonical" href="https://www.youtube.com/channel/UCpVc2Oc61kcUfBuz9lzP4MA">',
      )) as typeof fetch;
    expect(await resolveChannelId('@chatbase_', fakeFetch)).toBe('UCpVc2Oc61kcUfBuz9lzP4MA');
  });
});

const base = `version: 1
jobs:
  - name: academy
    agentId: \${AGENT}
    sources:
      - channel: "@chatbase_"
`;

describe('config', () => {
  it('interpolates env vars and applies defaults', () => {
    const [job] = parseConfig(base, { AGENT: 'agent-1' });
    expect(job!.agentId).toBe('agent-1');
    expect(job!.segmentSeconds).toBe(60);
    expect(job!.budget.maxUsdPerRun).toBe(5);
    expect(job!.sink).toBe('rest');
  });
  it('fails loudly on a missing env var', () => {
    expect(() => interpolateEnv('${NOPE}', {})).toThrow(UserError);
  });
  it('requires agentId for the rest sink', () => {
    expect(() => parseConfig(base.replace('    agentId: ${AGENT}\n', ''), {})).toThrow(/agentId is required/);
  });
  it('allows export without agentId', () => {
    const [job] = parseConfig(base.replace('    agentId: ${AGENT}\n', '    sink: export\n'), {});
    expect(job!.sink).toBe('export');
  });
  it('rejects unknown keys and bad regexes', () => {
    expect(() => parseConfig(base + 'extra: 1\n', { AGENT: 'a' })).toThrow(/invalid/);
    expect(() =>
      parseConfig(base.replace('    sources:', '    filters: { titleInclude: ["("] }\n    sources:'), { AGENT: 'a' }),
    ).toThrow(/regular expression/);
  });
  it('merges nested defaults per job', () => {
    const cfg = `version: 1
defaults:
  budget: { maxUsdPerRun: 9 }
jobs:
  - name: a
    agentId: x
    budget: { maxNewVideosPerRun: 3 }
    sources: [{ video: "tM3wpoieYTc" }]
`;
    const [job] = parseConfig(cfg, {});
    expect(job!.budget).toMatchObject({ maxUsdPerRun: 9, maxNewVideosPerRun: 3 });
  });
});

describe('filters', () => {
  const [job] = parseConfig(base, { AGENT: 'a' });
  it('drops shorts, short videos and excluded titles', () => {
    expect(excludeReason({ isShort: true }, job!)).toBe('short');
    expect(excludeReason({ title: 'Teaser #shorts' }, job!)).toBe('short');
    expect(excludeReason({ durationSec: 30 }, job!)).toBe('too-short');
    expect(excludeReason({ title: 'Full tutorial', durationSec: 600 }, job!)).toBeUndefined();
  });
});
