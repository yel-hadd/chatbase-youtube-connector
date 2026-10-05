import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { clock, formatTranscript, parseChapters, toBlocks, MAX_SOURCE_CHARS } from '../src/format/markdown.js';
import { mapItem } from '../src/providers/apify.js';
import type { Transcript } from '../src/types.js';

const items = JSON.parse(readFileSync(new URL('./fixtures/actor-items.json', import.meta.url), 'utf8'));
const helpdesk = mapItem(items[0]) as Transcript;

describe('clock', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(65)).toBe('1:05');
    expect(clock(3725)).toBe('1:02:05');
  });
});

describe('parseChapters', () => {
  it('reads the chapters from a real Chatbase video description', () => {
    const ch = parseChapters(helpdesk.description);
    expect(ch.length).toBeGreaterThanOrEqual(3);
    expect(ch[0]).toEqual({ start: 0, title: 'HelpDesk Introduction' });
    expect(ch[1]!.start).toBe(24);
  });
  it('ignores timestamp lists that do not start at 0:00', () => {
    expect(parseChapters('1:00 a\n2:00 b\n3:00 c')).toEqual([]);
  });
  it('needs at least three chapters', () => {
    expect(parseChapters('0:00 a\n1:00 b')).toEqual([]);
  });
});

describe('toBlocks', () => {
  const segs = Array.from({ length: 30 }, (_, i) => ({
    start: i * 5,
    end: i * 5 + 5,
    text: i % 4 === 3 ? `Sentence ${i}.` : `word ${i}`,
  }));
  it('closes blocks at a sentence end after the window', () => {
    const b = toBlocks(segs, 30);
    expect(b.length).toBeGreaterThan(2);
    for (const blk of b.slice(0, -1)) expect(blk.text.endsWith('.')).toBe(true);
  });
  it('never lets a block exceed 1.5x the window', () => {
    const noStops = segs.map((s) => ({ ...s, text: 'no stop' }));
    for (const blk of toBlocks(noStops, 20)) expect(blk.end - blk.start).toBeLessThanOrEqual(30);
  });
  it('starts a new block at each chapter', () => {
    const b = toBlocks(segs, 1000, [
      { start: 0, title: 'A' },
      { start: 50, title: 'B' },
      { start: 100, title: 'C' },
    ]);
    expect(b.map((x) => x.heading)).toEqual(['A', 'B', 'C']);
  });
  it('drops speaker-change markers', () => {
    const b = toBlocks([{ start: 0, end: 2, text: 'one >> >> two >>' }], 60);
    expect(b[0]!.text).toBe('one two');
  });
  it('drops caption noise tokens', () => {
    const b = toBlocks([{ start: 0, end: 2, text: '[Music] hello [Applause]' }], 60);
    expect(b[0]!.text).toBe('hello');
  });
});

describe('formatTranscript', () => {
  it('renders a timestamped, chaptered document for a real video', () => {
    const [doc] = formatTranscript(helpdesk, 60);
    expect(doc).toContain('# Chatbase HelpDesk - AI Customer Support with Human Handoff Walkthrough (video)');
    expect(doc).toContain('URL: https://www.youtube.com/watch?v=tM3wpoieYTc');
    expect(doc).toMatch(/## HelpDesk Introduction · 0:00–0:\d\d · \[watch\]\(https:\/\/youtu\.be\/tM3wpoieYTc\?t=0\)/);
    expect(doc).toContain('Transcript: auto-generated captions');
  });
  it('is deterministic', () => {
    expect(formatTranscript(helpdesk, 60)).toEqual(formatTranscript(helpdesk, 60));
  });
  it('splits very long transcripts into parts under the Chatbase limit', () => {
    const long: Transcript = {
      ...helpdesk,
      description: '',
      segments: Array.from({ length: 30000 }, (_, i) => ({ start: i * 3, end: i * 3 + 3, text: 'x'.repeat(60) + '.' })),
    };
    const parts = formatTranscript(long, 60);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
  });
});
