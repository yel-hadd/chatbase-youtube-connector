import type { OwnedSource } from '../types.js';
import { encodeName } from './naming.js';

export interface FormattedVideo {
  videoId: string;
  title: string;
  url: string;
  publishedAt?: string;
  parts: string[];
  hash: string;
}

export type Op =
  | { kind: 'create'; videoId: string; part: number; name: string; content: string; video: FormattedVideo }
  | {
      kind: 'update';
      videoId: string;
      part: number;
      name: string;
      content: string;
      video: FormattedVideo;
      existing: OwnedSource;
    }
  | {
      kind: 'delete';
      videoId: string;
      part: number;
      existing: OwnedSource;
      reason: 'removed-from-youtube' | 'excluded' | 'fewer-parts' | 'duplicate';
    }
  | { kind: 'skip'; videoId: string; reason: 'unchanged' };

/**
 * Diff what we would write against what Chatbase already holds.
 * - `videos`: freshly formatted transcripts.
 * - `owned`: our sources currently in the agent.
 * - `goneVideoIds`: owned videos confirmed missing from YouTube (full listing only).
 * - `excludedVideoIds`: owned videos the config now excludes.
 */
export function planOps(
  videos: FormattedVideo[],
  owned: OwnedSource[],
  goneVideoIds: string[] = [],
  excludedVideoIds: string[] = [],
): Op[] {
  const ops: Op[] = [];
  const byVideo = new Map<string, OwnedSource[]>();
  for (const o of owned) {
    const list = byVideo.get(o.videoId) ?? [];
    list.push(o);
    byVideo.set(o.videoId, list);
  }

  // Duplicates of the same (video, part) can appear if two runs raced. Keep the first, delete the rest.
  for (const [videoId, list] of byVideo) {
    const seen = new Map<number, OwnedSource>();
    const keep: OwnedSource[] = [];
    for (const o of list) {
      if (seen.has(o.part)) ops.push({ kind: 'delete', videoId, part: o.part, existing: o, reason: 'duplicate' });
      else {
        seen.set(o.part, o);
        keep.push(o);
      }
    }
    byVideo.set(videoId, keep);
  }

  for (const v of videos) {
    const existing = byVideo.get(v.videoId) ?? [];
    const sameHash = existing.length === v.parts.length && existing.every((e) => e.hash === v.hash);
    if (sameHash) {
      ops.push({ kind: 'skip', videoId: v.videoId, reason: 'unchanged' });
      continue;
    }
    v.parts.forEach((content, i) => {
      const part = i + 1;
      const name = encodeName(v.videoId, v.hash, v.title, part);
      const match = existing.find((e) => e.part === part);
      if (match) ops.push({ kind: 'update', videoId: v.videoId, part, name, content, video: v, existing: match });
      else ops.push({ kind: 'create', videoId: v.videoId, part, name, content, video: v });
    });
    for (const e of existing) {
      if (e.part > v.parts.length)
        ops.push({ kind: 'delete', videoId: v.videoId, part: e.part, existing: e, reason: 'fewer-parts' });
    }
  }

  const removals: [string[], 'removed-from-youtube' | 'excluded'][] = [
    [goneVideoIds, 'removed-from-youtube'],
    [excludedVideoIds, 'excluded'],
  ];
  const queued = new Set<string>();
  for (const [ids, reason] of removals) {
    for (const id of ids) {
      if (queued.has(id)) continue;
      queued.add(id);
      for (const e of byVideo.get(id) ?? [])
        ops.push({ kind: 'delete', videoId: id, part: e.part, existing: e, reason });
    }
  }
  return ops;
}
