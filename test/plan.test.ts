import { describe, expect, it } from 'vitest';
import { contentHash, decodeName, encodeName, MAX_NAME } from '../src/plan/naming.js';
import { planOps, type FormattedVideo } from '../src/plan/diff.js';
import type { OwnedSource } from '../src/types.js';
import { parseVideoId } from '../src/types.js';

describe('naming', () => {
  it('round-trips', () => {
    const n = encodeName('tM3wpoieYTc', 'abcdef12', 'HelpDesk walkthrough');
    expect(n).toBe('YT·tM3wpoieYTc·abcdef12·HelpDesk walkthrough');
    expect(decodeName(n)).toEqual({ videoId: 'tM3wpoieYTc', hash: 'abcdef12', part: 1 });
  });
  it('encodes parts', () => {
    expect(decodeName(encodeName('tM3wpoieYTc', 'abcdef12', 't', 3))).toEqual({ videoId: 'tM3wpoieYTc', hash: 'abcdef12', part: 3 });
  });
  it('truncates long and unicode titles to 100 characters', () => {
    const n = encodeName('tM3wpoieYTc', 'abcdef12', '日本語のタイトル '.repeat(20));
    expect([...n].length).toBeLessThanOrEqual(MAX_NAME);
    expect(n.endsWith('…')).toBe(true);
    expect(decodeName(n)?.videoId).toBe('tM3wpoieYTc');
  });
  it('ignores names that are not ours', () => {
    expect(decodeName('Pricing FAQ')).toBeUndefined();
    expect(decodeName('YT notes')).toBeUndefined();
    expect(decodeName(null)).toBeUndefined();
  });
  it('hash changes with content', () => {
    expect(contentHash(['a'])).not.toBe(contentHash(['b']));
    expect(contentHash(['a'])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('parseVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=tM3wpoieYTc&t=10', 'tM3wpoieYTc'],
    ['https://youtu.be/tM3wpoieYTc', 'tM3wpoieYTc'],
    ['https://www.youtube.com/shorts/VG1h2Rvcrow', 'VG1h2Rvcrow'],
    ['tM3wpoieYTc', 'tM3wpoieYTc'],
    ['https://example.com/watch?v=tM3wpoieYTc', undefined],
  ])('%s', (input, want) => expect(parseVideoId(input)).toBe(want));
});

const vid = (id: string, hash: string, parts = 1): FormattedVideo => ({
  videoId: id,
  title: `T ${id}`,
  url: `https://www.youtube.com/watch?v=${id}`,
  parts: Array.from({ length: parts }, (_, i) => `content ${i}`),
  hash,
});
const own = (id: string, hash: string, part = 1, sourceId = `${id}-${part}`): OwnedSource => ({
  sourceId,
  videoId: id,
  hash,
  part,
  name: encodeName(id, hash, 'x', part),
  size: 100,
});

describe('planOps', () => {
  const A = 'aaaaaaaaaaa';
  const B = 'bbbbbbbbbbb';
  it('creates new videos', () => {
    expect(planOps([vid(A, '11111111')], []).map((o) => o.kind)).toEqual(['create']);
  });
  it('skips unchanged videos', () => {
    expect(planOps([vid(A, '11111111')], [own(A, '11111111')]).map((o) => o.kind)).toEqual(['skip']);
  });
  it('updates changed videos in place', () => {
    const ops = planOps([vid(A, '22222222')], [own(A, '11111111')]);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('update');
  });
  it('adds and removes parts when a video grows or shrinks', () => {
    expect(planOps([vid(A, '22222222', 2)], [own(A, '11111111')]).map((o) => o.kind)).toEqual(['update', 'create']);
    expect(planOps([vid(A, '22222222', 1)], [own(A, '11111111', 1), own(A, '11111111', 2)]).map((o) => o.kind)).toEqual(['update', 'delete']);
  });
  it('deletes videos gone from YouTube', () => {
    const ops = planOps([], [own(B, '11111111')], [B]);
    expect(ops).toMatchObject([{ kind: 'delete', reason: 'removed-from-youtube' }]);
  });
  it('cleans up duplicates left by a race', () => {
    const ops = planOps([vid(A, '11111111')], [own(A, '11111111', 1, 's1'), own(A, '11111111', 1, 's2')]);
    expect(ops.map((o) => o.kind).sort()).toEqual(['delete', 'skip']);
  });
});
