import { XMLParser } from 'fast-xml-parser';
import { HttpError, UserError, ExitCode } from '../util/errors.js';
import { withRetry, type FetchFn } from '../util/http.js';
import { parseVideoId, type VideoRef } from '../types.js';
import { log } from '../util/log.js';
import type { Source } from '../config/schema.js';

const UA = 'Mozilla/5.0 (compatible; chatbase-youtube-sync; +https://github.com/yel-hadd/chatbase-youtube-connector)';

/** Resolve "@handle", a channel URL or a UC… id to a channel ID. */
export async function resolveChannelId(input: string, fetchFn: FetchFn = fetch): Promise<string> {
  const s = input.trim();
  const direct = /(UC[A-Za-z0-9_-]{22})/.exec(s);
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
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/.exec(html) ??
    /"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(html);
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

// fast-xml-parser yields strings, numbers or objects depending on the content, so treat
// every value as unknown and convert explicitly.
interface FeedEntry {
  'yt:videoId': unknown;
  title?: unknown;
  published?: unknown;
  link?: { '@_href'?: string } | { '@_href'?: string }[];
}

function textOf(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
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
      id: textOf(e['yt:videoId']),
      title: e.title !== undefined ? textOf(e.title) : undefined,
      publishedAt: e.published ? textOf(e.published).slice(0, 10) : undefined,
      isShort: href.includes('/shorts/'),
    };
  });
}

export async function fetchFeed(
  kind: 'channel' | 'playlist',
  id: string,
  fetchFn: FetchFn = fetch,
): Promise<VideoRef[]> {
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
  // The uploads playlist (UU…) holds every upload, including Shorts and live recordings,
  // which the channel's /videos tab leaves out. Pruning relies on seeing all of them.
  if ('channel' in src)
    return `https://www.youtube.com/playlist?list=UU${(await resolveChannelId(src.channel, fetchFn)).slice(2)}`;
  if ('playlist' in src) return `https://www.youtube.com/playlist?list=${playlistIdOf(src.playlist)}`;
  const id = parseVideoId(src.video);
  if (!id) throw new UserError(`not a YouTube video: ${src.video}`, ExitCode.ConfigInvalid);
  return `https://www.youtube.com/watch?v=${id}`;
}

const PLAYLIST_ID_RE = /^(?:PL|UU|OL|FL|LL|RD)[A-Za-z0-9_-]{10,}$/;

export type Ref = { kind: 'video'; id: string } | { kind: 'playlist'; id: string };

/** Classify a config entry: a video URL/ID or a playlist URL/ID. */
export function classifyRef(input: string): Ref | undefined {
  const s = input.trim();
  try {
    const list = new URL(s).searchParams.get('list');
    const v = parseVideoId(s);
    // A watch URL that also carries &list= points at a video; a /playlist URL is a playlist.
    if (v) return { kind: 'video', id: v };
    if (list) return { kind: 'playlist', id: list };
  } catch {
    /* not a URL */
  }
  if (PLAYLIST_ID_RE.test(s)) return { kind: 'playlist', id: s };
  const v = parseVideoId(s);
  return v ? { kind: 'video', id: v } : undefined;
}

export interface PlaylistListing {
  ids: string[];
  /** Number of videos YouTube reports for the playlist, when known. */
  total?: number;
  complete: boolean;
}

/**
 * Every video in a playlist. With a YouTube Data API key the listing is complete
 * (playlistItems, 1 quota unit per 50 videos). Without one we read the public
 * playlist page, which carries the first 100 videos and the total count, so a
 * truncated listing is detected rather than silently accepted.
 */
export async function listPlaylist(
  playlistId: string,
  fetchFn: FetchFn = fetch,
  apiKey: string | undefined = process.env.YOUTUBE_API_KEY,
): Promise<PlaylistListing> {
  if (apiKey) {
    const ids: string[] = [];
    let pageToken = '';
    do {
      const qs = new URLSearchParams({ part: 'contentDetails', maxResults: '50', playlistId, key: apiKey });
      if (pageToken) qs.set('pageToken', pageToken);
      const data = await withRetry(`playlistItems ${playlistId}`, async () => {
        const res = await fetchFn(`https://www.googleapis.com/youtube/v3/playlistItems?${qs}`);
        if (!res.ok) throw new HttpError(res.status, undefined, `YouTube Data API playlistItems: HTTP ${res.status}`);
        return (await res.json()) as {
          items?: { contentDetails?: { videoId?: string } }[];
          nextPageToken?: string;
        };
      });
      for (const it of data.items ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
      pageToken = data.nextPageToken ?? '';
    } while (pageToken);
    return { ids, total: ids.length, complete: true };
  }
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  const html = await withRetry(`playlist ${playlistId}`, async () => {
    const res = await fetchFn(url, { headers: { 'user-agent': UA, 'accept-language': 'en' } });
    if (!res.ok) throw new HttpError(res.status, undefined, `YouTube playlist ${playlistId}: HTTP ${res.status}`);
    return res.text();
  });
  return parsePlaylistPage(html, playlistId);
}

export function parsePlaylistPage(html: string, playlistId: string): PlaylistListing {
  const esc = playlistId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`"watchEndpoint":\\{"videoId":"([A-Za-z0-9_-]{11})","playlistId":"${esc}"`, 'g');
  const ids = [...new Set([...html.matchAll(re)].map((m) => m[1]!))];
  const m =
    /"numVideosText".{0,160}?"text":"([\d,.]+)"/.exec(html) ?? /"stats":\[\{"runs":\[\{"text":"([\d,.]+)"/.exec(html);
  const total = m ? Number(m[1]!.replace(/[,.]/g, '')) : undefined;
  return { ids, total, complete: total === undefined ? ids.length < 100 : ids.length >= total };
}

/** Incremental discovery: the newest videos of every source, via free RSS feeds. */
export async function discoverRecent(sources: Source[], fetchFn: FetchFn = fetch): Promise<VideoRef[]> {
  const out = new Map<string, VideoRef>();
  for (const src of sources) {
    let refs: VideoRef[];
    if ('channel' in src) refs = await fetchFeed('channel', await resolveChannelId(src.channel, fetchFn), fetchFn);
    else if ('playlist' in src) {
      const listing = await listPlaylist(playlistIdOf(src.playlist), fetchFn);
      if (!listing.complete) warnTruncated(src.playlist, listing);
      refs = listing.ids.map((id) => ({ id }));
    } else {
      const id = parseVideoId(src.video);
      if (!id) throw new UserError(`not a YouTube video: ${src.video}`, ExitCode.ConfigInvalid);
      refs = [{ id }];
    }
    for (const r of refs) if (!out.has(r.id)) out.set(r.id, r);
  }
  return [...out.values()];
}

export function warnTruncated(what: string, l: PlaylistListing): void {
  log.warn('playlist listing is incomplete; set YOUTUBE_API_KEY for a full listing', {
    playlist: what,
    listed: l.ids.length,
    total: l.total,
  });
}
