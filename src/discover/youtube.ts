import { XMLParser } from 'fast-xml-parser';
import { HttpError, UserError, ExitCode } from '../util/errors.js';
import { withRetry, type FetchFn } from '../util/http.js';
import { parseVideoId, type VideoRef } from '../types.js';
import type { Source } from '../config/schema.js';

const UA = 'Mozilla/5.0 (compatible; chatbase-youtube-sync; +https://github.com/use-app/chatbase-youtube-connector)';

/** Resolve "@handle", a channel URL or a UC… id to a channel ID. */
export async function resolveChannelId(input: string, fetchFn: FetchFn = fetch): Promise<string> {
  const s = input.trim();
  const direct = s.match(/(UC[A-Za-z0-9_-]{22})/);
  if (direct) return direct[1]!;
  let url: string;
  if (s.startsWith('@')) url = `https://www.youtube.com/${s}`;
  else if (/^https?:\/\//.test(s)) url = s;
  else url = `https://www.youtube.com/@${s}`;
  const html = await withRetry(`resolve ${s}`, async () => {
    const res = await fetchFn(url, { headers: { 'user-agent': UA, 'accept-language': 'en' } });
    if (!res.ok) throw new HttpError(res.status, undefined, `YouTube ${url}: HTTP ${res.status}`);
    return res.text();
  });
  const m =
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/) ??
    html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/);
  if (!m) throw new UserError(`could not resolve YouTube channel "${input}"`, ExitCode.ConfigInvalid);
  return m[1]!;
}

export function playlistIdOf(input: string): string {
  const s = input.trim();
  try {
    const list = new URL(s).searchParams.get('list');
    if (list) return list;
  } catch {
    /* not a URL */
  }
  return s;
}

interface FeedEntry {
  'yt:videoId': string;
  title?: string;
  published?: string;
  link?: { '@_href'?: string } | Array<{ '@_href'?: string }>;
}

/** Parse a YouTube Atom feed (channel or playlist). It lists the newest 15 videos. */
export function parseFeed(xml: string): VideoRef[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
  const doc = parser.parse(xml) as { feed?: { entry?: FeedEntry | FeedEntry[] } };
  const entries = doc.feed?.entry ? (Array.isArray(doc.feed.entry) ? doc.feed.entry : [doc.feed.entry]) : [];
  return entries.map((e) => {
    const links = Array.isArray(e.link) ? e.link : e.link ? [e.link] : [];
    const href = links.map((l) => l['@_href'] ?? '').join(' ');
    return {
      id: String(e['yt:videoId']),
      title: e.title !== undefined ? String(e.title) : undefined,
      publishedAt: e.published ? String(e.published).slice(0, 10) : undefined,
      isShort: href.includes('/shorts/'),
    };
  });
}

export async function fetchFeed(kind: 'channel' | 'playlist', id: string, fetchFn: FetchFn = fetch): Promise<VideoRef[]> {
  const param = kind === 'channel' ? 'channel_id' : 'playlist_id';
  const url = `https://www.youtube.com/feeds/videos.xml?${param}=${encodeURIComponent(id)}`;
  const xml = await withRetry(`feed ${id}`, async () => {
    const res = await fetchFn(url, { headers: { 'user-agent': UA } });
    if (!res.ok) throw new HttpError(res.status, undefined, `YouTube feed ${id}: HTTP ${res.status}`);
    return res.text();
  });
  return parseFeed(xml);
}

/** URL for a source, in the form the transcript Actor accepts for a full listing. */
export async function sourceListingUrl(src: Source, fetchFn: FetchFn = fetch): Promise<string> {
  if ('channel' in src) return `https://www.youtube.com/channel/${await resolveChannelId(src.channel, fetchFn)}/videos`;
  if ('playlist' in src) return `https://www.youtube.com/playlist?list=${playlistIdOf(src.playlist)}`;
  const id = parseVideoId(src.video);
  if (!id) throw new UserError(`not a YouTube video: ${src.video}`, ExitCode.ConfigInvalid);
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Incremental discovery: the newest videos of every source, via free RSS feeds. */
export async function discoverRecent(sources: Source[], fetchFn: FetchFn = fetch): Promise<VideoRef[]> {
  const out = new Map<string, VideoRef>();
  for (const src of sources) {
    let refs: VideoRef[];
    if ('channel' in src) refs = await fetchFeed('channel', await resolveChannelId(src.channel, fetchFn), fetchFn);
    else if ('playlist' in src) refs = await fetchFeed('playlist', playlistIdOf(src.playlist), fetchFn);
    else {
      const id = parseVideoId(src.video);
      if (!id) throw new UserError(`not a YouTube video: ${src.video}`, ExitCode.ConfigInvalid);
      refs = [{ id }];
    }
    for (const r of refs) if (!out.has(r.id)) out.set(r.id, r);
  }
  return [...out.values()];
}
