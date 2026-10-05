import { createHash } from 'node:crypto';
import { FORMAT_VERSION } from '../format/markdown.js';

// The connector keeps no database: the name of each Chatbase source carries the
// state we need. Format (Chatbase caps names at 100 characters):
//
//   YT·<videoId>·<hash8>·<title>          single-part video
//   YT·<videoId>·<hash8>·p2·<title>       second part of a very long video
//
// hash8 covers the formatted content and FORMAT_VERSION, so a changed transcript
// or a new formatter version shows up as a different hash.

export const PREFIX = 'YT·';
export const MAX_NAME = 100;
const SEP = '·';
const RE = /^YT·([A-Za-z0-9_-]{11})·([0-9a-f]{8})·(?:p(\d{1,3})·)?/;

export function contentHash(parts: string[]): string {
  const h = createHash('sha256');
  h.update(`v${FORMAT_VERSION}\n`);
  for (const p of parts) h.update(p);
  return h.digest('hex').slice(0, 8);
}

export function encodeName(videoId: string, hash: string, title: string, part = 1): string {
  const head = `${PREFIX}${videoId}${SEP}${hash}${SEP}${part > 1 ? `p${part}${SEP}` : ''}`;
  const clean = title.replace(/\s+/g, ' ').trim() || videoId;
  // Chatbase validates the 100 limit in UTF-16 code units (JSON Schema maxLength), so an
  // emoji counts as 2. Trim whole graphemes (never half an emoji) until the name fits.
  if (head.length + clean.length <= MAX_NAME) return head + clean;
  const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean), (g) => g.segment);
  while (chars.length && head.length + chars.join('').length + 1 > MAX_NAME) chars.pop();
  return `${head}${chars.join('')}…`;
}

export function decodeName(
  name: string | null | undefined,
): { videoId: string; hash: string; part: number } | undefined {
  if (!name) return undefined;
  const m = RE.exec(name);
  if (!m) return undefined;
  return { videoId: m[1]!, hash: m[2]!, part: m[3] ? Number(m[3]) : 1 };
}
