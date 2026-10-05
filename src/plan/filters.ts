import { toRegExp, type Job } from '../config/schema.js';

export interface Filterable {
  title?: string;
  publishedAt?: string;
  durationSec?: number;
  isShort?: boolean;
}

/** Returns the reason a video is excluded, or undefined when it passes every filter. */
export function excludeReason(v: Filterable, job: Job): string | undefined {
  const title = v.title ?? '';
  if (!job.includeShorts) {
    if (v.isShort) return 'short';
    if (/(^|\s)#shorts\b/i.test(title)) return 'short';
  }
  if (v.durationSec !== undefined && v.durationSec < job.minDurationSec) return 'too-short';
  if (job.filters.publishedAfter && v.publishedAt && v.publishedAt < job.filters.publishedAfter) return 'too-old';
  if (
    job.filters.titleInclude.length &&
    v.title !== undefined &&
    !job.filters.titleInclude.some((r) => toRegExp(r).test(title))
  ) {
    return 'title-not-included';
  }
  if (job.filters.titleExclude.some((r) => toRegExp(r).test(title))) return 'title-excluded';
  return undefined;
}
