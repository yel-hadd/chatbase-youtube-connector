import type { Job, Source } from './config/schema.js';
import { classifyRef, discoverRecent, listPlaylist, sourceListingUrl, warnTruncated } from './discover/youtube.js';
import { formatTranscript } from './format/markdown.js';
import { contentHash } from './plan/naming.js';
import { planOps, type FormattedVideo, type Op } from './plan/diff.js';
import { excludeReason } from './plan/filters.js';
import { estimateSpend, overSpend } from './budget.js';
import { newJobReport, record, type JobReport } from './report.js';
import { StorageLimitError, type Sink } from './sinks/types.js';
import type { TranscribeOptions, TranscribeResult } from './providers/apify.js';
import { SkipCache } from './state.js';
import { watchUrl, type OwnedSource, type Transcript, type VideoRef } from './types.js';
import { log } from './util/log.js';
import { UserError, ExitCode } from './util/errors.js';
import type { FetchFn } from './util/http.js';

export interface TranscriptProvider {
  transcribe(urls: string[], opts: TranscribeOptions): Promise<TranscribeResult>;
}

export interface SyncDeps {
  provider: TranscriptProvider;
  sink: Sink;
  fetchFn?: FetchFn;
  /** Remembers unusable videos between runs. Defaults to an in-memory cache. */
  skipCache?: SkipCache;
}

export interface SyncOptions {
  full: boolean;
  dryRun: boolean;
  allowMassDelete: boolean;
}

export interface JobOutcome {
  report: JobReport;
  exitCode: ExitCode;
}

function transcribeOpts(job: Job, aiEnabled: boolean, maxResults?: number): TranscribeOptions {
  return {
    languages: job.languages,
    machineTranslate: job.machineTranslate,
    ai: { ...job.aiFallback, enabled: aiEnabled },
    maxResults,
  };
}

function format(job: Job, t: Transcript): FormattedVideo {
  const parts = formatTranscript(t, job.segmentSeconds);
  return { videoId: t.id, title: t.title, url: t.url, parts, hash: contentHash(parts) };
}

/** Worst-case transcripts a full listing can return: a video source is one video. */
function listingSize(job: Job, sources: Source[]): number {
  return sources.reduce((n, s) => n + ('video' in s ? 1 : job.maxVideos), 0);
}

export async function syncJob(job: Job, deps: SyncDeps, opts: SyncOptions): Promise<JobOutcome> {
  const mode = opts.full ? 'full' : 'incremental';
  const report = newJobReport(job.name, deps.sink.kind, mode, opts.dryRun);
  const skips = deps.skipCache ?? new SkipCache(undefined, job.recheckSkippedAfterDays);
  try {
    await skips.load();
    const owned = await deps.sink.list();
    const ownedIds = new Set(owned.map((o) => o.videoId));
    log.info('inventory loaded', { job: job.name, ownedSources: owned.length, ownedVideos: ownedIds.size });

    const excluded = await resolveExclusions(job, deps.fetchFn);
    const excludedOwned = [...ownedIds].filter((id) => excluded.has(id));
    for (const id of excludedOwned) {
      if (job.prune) {
        if (opts.dryRun) record(report, { videoId: id, action: 'planned', detail: 'would delete (excluded)' });
      } else {
        record(report, { videoId: id, action: 'excluded', detail: 'still in the agent; set prune: true to remove it' });
      }
    }
    // Exclusion deletes are known before any spend, so check that cap now.
    if (job.prune) assertDeleteCap(job, opts, excludedOwned.length);

    let transcripts: Transcript[] = [];
    let goneIds: string[] = [];

    if (!opts.full) {
      // Incremental: free discovery (RSS for channels, the playlist page for playlists),
      // transcribe only videos we neither hold nor recently found unusable.
      const recent = await discoverRecent(job.sources, deps.fetchFn);
      const fresh: VideoRef[] = [];
      for (const v of recent) {
        if (excluded.has(v.id)) {
          if (!ownedIds.has(v.id))
            record(report, { videoId: v.id, title: v.title, action: 'excluded', detail: 'excluded in config' });
          continue;
        }
        if (ownedIds.has(v.id)) {
          record(report, { videoId: v.id, title: v.title, action: 'unchanged', detail: 'already synced' });
          continue;
        }
        const why = excludeReason(v, job);
        if (why) {
          record(report, { videoId: v.id, title: v.title, action: 'excluded', detail: why });
          continue;
        }
        const skipped = skips.isFresh(v.id);
        if (skipped) {
          record(report, { videoId: v.id, title: v.title, action: 'skipped', detail: `${skipped.reason} (cached)` });
          continue;
        }
        fresh.push(v);
      }
      const batch = fresh.slice(0, job.budget.maxNewVideosPerRun);
      const est = estimateSpend(job, batch.length);
      report.spend.estimatedMaxUsd = est.maxUsd;
      const over = overSpend(job, est);
      if (over) throw new UserError(over, ExitCode.BudgetExceeded);
      if (opts.dryRun) {
        for (const v of batch)
          record(report, { videoId: v.id, title: v.title, action: 'planned', detail: 'would transcribe and create' });
        return done(report, ExitCode.Ok);
      }
      if (batch.length) {
        const res = await deps.provider.transcribe(
          batch.map((v) => watchUrl(v.id)),
          transcribeOpts(job, job.aiFallback.enabled),
        );
        collect(report, res, skips);
        transcripts = res.transcripts;
      }
    } else {
      // Full: list every source through the Actor (captions only), one run per source so a
      // truncated listing is attributable, then AI-transcribe only new caption-less videos.
      const est = estimateSpend(job, listingSize(job, job.sources));
      report.spend.estimatedMaxUsd = est.maxUsd;
      const over = overSpend(job, est);
      if (over) throw new UserError(`${over}. Lower maxVideos or raise the budget.`, ExitCode.BudgetExceeded);
      if (opts.dryRun) {
        record(report, {
          videoId: '-',
          action: 'planned',
          detail: `would list up to ${listingSize(job, job.sources)} videos and diff against ${ownedIds.size} owned videos`,
        });
        return done(report, ExitCode.Ok);
      }
      const seen = new Set<string>();
      const failures: TranscribeResult['failures'] = [];
      let truncated = false;
      for (const src of job.sources) {
        const url = await sourceListingUrl(src, deps.fetchFn);
        const res = await deps.provider.transcribe([url], transcribeOpts(job, false, job.maxVideos));
        collect(report, res, skips, /* recordFailures */ false);
        for (const t of res.transcripts) seen.add(t.id);
        for (const f of res.failures) seen.add(f.id);
        transcripts.push(...res.transcripts);
        failures.push(...res.failures);
        if (!('video' in src) && res.transcripts.length + res.failures.length >= job.maxVideos) {
          truncated = true;
          log.warn('listing hit maxVideos; prune is skipped this run', { job: job.name, source: url });
        }
      }

      const needAi = job.aiFallback.enabled
        ? failures.filter((f) => f.code === 'NO_CAPTIONS_AVAILABLE' && !ownedIds.has(f.id) && !excluded.has(f.id))
        : [];
      if (needAi.length) {
        const ai = await deps.provider.transcribe(
          needAi.map((f) => watchUrl(f.id)),
          transcribeOpts(job, true),
        );
        collect(report, ai, skips);
        transcripts.push(...ai.transcripts);
      }
      const sentToAi = new Set(needAi.map((f) => f.id));
      for (const f of failures) if (!sentToAi.has(f.id)) recordFailure(report, skips, f);

      if (job.prune && !truncated) goneIds = [...ownedIds].filter((id) => !seen.has(id));
    }

    const formatted: FormattedVideo[] = [];
    for (const t of transcripts) {
      if (excluded.has(t.id)) {
        if (!ownedIds.has(t.id))
          record(report, { videoId: t.id, title: t.title, action: 'excluded', detail: 'excluded in config' });
        continue;
      }
      // Rules (shorts, duration, titles) gate new videos only; durations are known only now.
      const why = ownedIds.has(t.id) ? undefined : excludeReason(t, job);
      if (why) {
        record(report, { videoId: t.id, title: t.title, action: 'excluded', detail: why });
        skips.remember(t.id, why);
        continue;
      }
      skips.forget(t.id);
      formatted.push(format(job, t));
    }

    let ops = planOps(formatted, owned, goneIds, job.prune ? excludedOwned : []);
    // Deletions of videos gone from YouTube are only known now, after the listing was paid for.
    // Over the cap, keep the paid work: apply creates and updates, hold back the deletions.
    const removals = ops.filter((o) => o.kind === 'delete' && o.reason === 'removed-from-youtube');
    if (removals.length > job.budget.maxDeletesPerRun && !opts.allowMassDelete) {
      ops = ops.filter((o) => !(o.kind === 'delete' && o.reason === 'removed-from-youtube'));
      report.errors.push(
        `${removals.length} videos look deleted from YouTube, over budget.maxDeletesPerRun (${job.budget.maxDeletesPerRun}); deletions held back. Re-run with --allow-mass-delete if intended.`,
      );
      report.capHit = true;
    }

    const usedBefore = await deps.sink.textBytesUsed().catch(() => undefined);
    report.storage = { textBytesBefore: usedBefore };
    await apply(ops, deps.sink, report, storageBudget(job, usedBefore));
    await deps.sink.finish();
    await skips.save();
    report.storage.textBytesAfter = await deps.sink.textBytesUsed().catch(() => undefined);

    if (report.capHit) return done(report, ExitCode.BudgetExceeded);
    const failed = report.counts.failed > 0 || report.errors.length > 0;
    return done(report, failed ? ExitCode.PartialFailure : ExitCode.Ok);
  } catch (e) {
    await skips.save();
    const code = e instanceof UserError ? e.exitCode : ExitCode.Unexpected;
    report.aborted = (e as Error).message;
    log.error('job aborted', { job: job.name, error: (e as Error).message });
    return done(report, code);
  }
}

function assertDeleteCap(job: Job, opts: SyncOptions, count: number): void {
  if (count > job.budget.maxDeletesPerRun && !opts.allowMassDelete) {
    throw new UserError(
      `${count} sources would be deleted, over budget.maxDeletesPerRun (${job.budget.maxDeletesPerRun}). Re-run with --allow-mass-delete if this is intended.`,
      ExitCode.BudgetExceeded,
    );
  }
}

/** Bytes we may still add, or undefined when there is no configured limit. */
function storageBudget(job: Job, usedBytes: number | undefined): number | undefined {
  if (!job.budget.storageLimitMb || usedBytes === undefined) return undefined;
  return job.budget.storageLimitMb * 1024 * 1024 - usedBytes;
}

function recordFailure(report: JobReport, skips: SkipCache, f: TranscribeResult['failures'][number]): void {
  // A video without captions is expected; it is remembered so it is not re-checked daily.
  if (f.code === 'NO_CAPTIONS_AVAILABLE') {
    record(report, { videoId: f.id, action: 'skipped', detail: f.code });
    skips.remember(f.id, f.code);
  } else {
    record(report, { videoId: f.id, action: 'failed', detail: f.code });
  }
}

function collect(report: JobReport, res: TranscribeResult, skips: SkipCache, recordFailures = true): void {
  if (res.runId) report.spend.apifyRunIds.push(res.runId);
  if (res.usageUsd !== undefined) report.spend.actualUsd = (report.spend.actualUsd ?? 0) + res.usageUsd;
  if (recordFailures) for (const f of res.failures) recordFailure(report, skips, f);
}

function sizeDelta(op: Op): number {
  if (op.kind === 'create') return Buffer.byteLength(op.content, 'utf8');
  if (op.kind === 'update') return Buffer.byteLength(op.content, 'utf8') - op.existing.size;
  if (op.kind === 'delete') return -op.existing.size;
  return 0;
}

async function apply(ops: Op[], sink: Sink, report: JobReport, room: number | undefined): Promise<void> {
  // Deletions first: they free room for what follows.
  const ordered = [...ops.filter((o) => o.kind === 'delete'), ...ops.filter((o) => o.kind !== 'delete')];
  let left = room;
  let storageFull = false;
  const doneVideos = new Set<string>();
  for (const op of ordered) {
    if (op.kind === 'skip') {
      record(report, { videoId: op.videoId, action: 'unchanged' });
      continue;
    }
    const delta = sizeDelta(op);
    if (op.kind !== 'delete' && (storageFull || (left !== undefined && delta > left))) {
      if (!storageFull) report.errors.push('storage limit reached; remaining videos were not synced');
      storageFull = true;
      report.capHit = true;
      record(report, { videoId: op.videoId, action: 'skipped', detail: 'storage limit reached' });
      continue;
    }
    try {
      if (op.kind === 'create') await sink.create(op.videoId, op.name, op.content, metaOf(op));
      else if (op.kind === 'update') await sink.update(op.existing, op.name, op.content, metaOf(op));
      else await sink.remove(op.existing);
      if (left !== undefined) left -= delta;
      const action = op.kind === 'create' ? 'created' : op.kind === 'update' ? 'updated' : 'deleted';
      // Count a multi-part video once.
      const key = `${action}:${op.videoId}`;
      if (!doneVideos.has(key)) {
        doneVideos.add(key);
        record(report, {
          videoId: op.videoId,
          title: op.kind === 'delete' ? titleOf(op.existing) : op.video.title,
          action,
          detail: op.kind === 'delete' ? op.reason : undefined,
        });
      }
    } catch (e) {
      if (e instanceof StorageLimitError) {
        storageFull = true;
        report.capHit = true;
        report.errors.push(`Chatbase storage limit reached: ${e.message}`);
        record(report, { videoId: op.videoId, action: 'skipped', detail: 'storage limit reached' });
        continue;
      }
      if (e instanceof UserError) throw e; // auth/plan problems stop the job
      record(report, { videoId: op.videoId, action: 'failed', detail: (e as Error).message });
    }
  }
}

function metaOf(op: Extract<Op, { kind: 'create' | 'update' }>) {
  return { title: op.video.title, hash: op.video.hash, part: op.part, url: op.video.url };
}

function titleOf(o: OwnedSource): string {
  return o.name.replace(/^YT·[A-Za-z0-9_-]{11}·[0-9a-f]{8}·(?:p\d+·)?/, '');
}

function done(report: JobReport, exitCode: ExitCode): JobOutcome {
  report.finishedAt = new Date().toISOString();
  return { report, exitCode };
}

/** Expand the `exclude` list into a set of video IDs (playlists are listed in full). */
async function resolveExclusions(job: Job, fetchFn?: FetchFn): Promise<Set<string>> {
  const out = new Set<string>();
  for (const entry of job.exclude) {
    const ref = classifyRef(entry);
    if (!ref) continue; // rejected by config validation
    if (ref.kind === 'video') {
      out.add(ref.id);
      continue;
    }
    const listing = await listPlaylist(ref.id, fetchFn);
    if (!listing.complete) warnTruncated(entry, listing);
    for (const id of listing.ids) out.add(id);
  }
  return out;
}
