import type { Job, Source } from './config/schema.js';
import { classifyRef, discoverRecent, listPlaylist, sourceListingUrl, warnTruncated } from './discover/youtube.js';
import { formatTranscript } from './format/markdown.js';
import { contentHash, decodeName } from './plan/naming.js';
import { planOps, type FormattedVideo, type Op } from './plan/diff.js';
import { excludeReason } from './plan/filters.js';
import { estimateSpend, overSpend } from './budget.js';
import { newJobReport, record, type JobReport } from './report.js';
import { StorageLimitError, type Sink } from './sinks/types.js';
import type { TranscribeOptions, TranscribeResult } from './providers/apify.js';
import { SkipCache, skipFingerprint } from './state.js';
import { watchUrl, type Transcript, type VideoRef } from './types.js';
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
  const skips = deps.skipCache ?? new SkipCache(undefined, job.recheckSkippedAfterDays, skipFingerprint(job));
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
      // One Actor run per source, in parallel. A source that fails or hits maxVideos makes
      // the listing incomplete, which only disables pruning: the rest of the paid work is kept.
      const listings = await Promise.allSettled(
        job.sources.map(async (src) => {
          const url = await sourceListingUrl(src, deps.fetchFn);
          return { src, url, res: await deps.provider.transcribe([url], transcribeOpts(job, false, job.maxVideos)) };
        }),
      );
      const byId = new Map<string, Transcript>();
      const failureById = new Map<string, TranscribeResult['failures'][number]>();
      let truncated = false;
      for (const l of listings) {
        if (l.status === 'rejected') {
          truncated = true;
          report.errors.push(`a source listing failed and was skipped: ${(l.reason as Error).message}`);
          continue;
        }
        const { src, url, res } = l.value;
        collect(report, res, skips, /* recordFailures */ false);
        // A video can sit in several sources (a channel and one of its playlists): keep one.
        for (const t of res.transcripts) byId.set(t.id, t);
        for (const f of res.failures) if (!byId.has(f.id)) failureById.set(f.id, f);
        if (!('video' in src) && res.transcripts.length + res.failures.length >= job.maxVideos) {
          truncated = true;
          log.warn('listing hit maxVideos; prune is skipped this run', { job: job.name, source: url });
        }
      }
      for (const id of byId.keys()) failureById.delete(id);
      const seen = new Set([...byId.keys(), ...failureById.keys()]);
      transcripts.push(...byId.values());
      const failures = [...failureById.values()];

      const needAi = job.aiFallback.enabled
        ? failures.filter(
            (f) =>
              f.code === 'NO_CAPTIONS_AVAILABLE' && !ownedIds.has(f.id) && !excluded.has(f.id) && !skips.isFresh(f.id),
          )
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

      // Excluded videos are removed under their own reason, so they never count as "gone".
      if (job.prune && !truncated) goneIds = [...ownedIds].filter((id) => !seen.has(id) && !excluded.has(id));
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
    // The delete cap counts videos removed for either reason. Exclusions were checked before
    // any spend; deletions from YouTube are only known now, after the listing was paid for.
    // Over the cap, keep the paid work: apply creates and updates, hold back those deletions.
    const removedVideos = new Set(
      ops.filter((o) => o.kind === 'delete' && o.reason === 'removed-from-youtube').map((o) => o.videoId),
    );
    const excludedVideos = job.prune ? excludedOwned.length : 0;
    if (removedVideos.size + excludedVideos > job.budget.maxDeletesPerRun && !opts.allowMassDelete) {
      ops = ops.filter((o) => !(o.kind === 'delete' && o.reason === 'removed-from-youtube'));
      report.errors.push(
        `${removedVideos.size + excludedVideos} videos would be removed, over budget.maxDeletesPerRun (${job.budget.maxDeletesPerRun}); removals of videos missing from YouTube were held back. Re-run with --allow-mass-delete if intended.`,
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
  // Whole-video removals run first: they free room for what follows.
  const removals = ops.filter((o) => o.kind === 'delete' && o.reason !== 'fewer-parts');
  // Everything else is grouped per video, so a video is written whole or not at all, and a
  // shrinking video writes its new parts before its surplus old parts are removed.
  const groups = new Map<string, Op[]>();
  for (const op of ops) {
    if (op.kind === 'delete' && op.reason !== 'fewer-parts') continue;
    const g = groups.get(op.videoId) ?? [];
    g.push(op);
    groups.set(op.videoId, g);
  }

  for (const op of removals) {
    if (op.kind !== 'delete') continue;
    try {
      await sink.remove(op.existing);
      if (room !== undefined) room += op.existing.size;
      recordOnce(report, op.videoId, 'deleted', decodeName(op.existing.name)?.title, op.reason);
    } catch (e) {
      if (e instanceof UserError) throw e;
      record(report, { videoId: op.videoId, action: 'failed', detail: (e as Error).message });
    }
  }

  let storageFull = false;
  for (const [videoId, group] of groups) {
    if (group.every((o) => o.kind === 'skip')) {
      record(report, { videoId, action: 'unchanged' });
      continue;
    }
    const writes = group.filter((o) => o.kind === 'create' || o.kind === 'update');
    const surplus = group.filter((o) => o.kind === 'delete');
    const delta = group.reduce((a, o) => a + sizeDelta(o), 0);
    const title = writes[0]?.kind === 'create' || writes[0]?.kind === 'update' ? writes[0].video.title : undefined;
    if (storageFull || (room !== undefined && delta > room)) {
      if (!storageFull) report.errors.push('storage limit reached; remaining videos were not synced');
      storageFull = true;
      report.capHit = true;
      record(report, { videoId, title, action: 'skipped', detail: 'storage limit reached' });
      continue;
    }
    try {
      for (const op of writes) {
        if (op.kind === 'create') await sink.create(op.videoId, op.name, op.content, metaOf(op));
        else await sink.update(op.existing, op.name, op.content, metaOf(op));
      }
      for (const op of surplus) await sink.remove(op.existing);
      if (room !== undefined) room -= delta;
      recordOnce(
        report,
        videoId,
        writes.some((o) => o.kind === 'create') && !writes.some((o) => o.kind === 'update') ? 'created' : 'updated',
        title,
      );
    } catch (e) {
      if (e instanceof StorageLimitError) {
        storageFull = true;
        report.capHit = true;
        report.errors.push(`Chatbase storage limit reached: ${e.message}`);
        record(report, { videoId, title, action: 'skipped', detail: 'storage limit reached' });
        continue;
      }
      if (e instanceof UserError) throw e; // auth/plan problems stop the job
      // Parts already written keep their new hash; the next run finishes the video.
      record(report, { videoId, title, action: 'failed', detail: (e as Error).message });
    }
  }
}

function recordOnce(
  report: JobReport,
  videoId: string,
  action: 'created' | 'updated' | 'deleted',
  title: string | undefined,
  detail?: string,
): void {
  if (report.videos.some((v) => v.videoId === videoId && v.action === action)) return;
  record(report, { videoId, title, action, detail });
}

function metaOf(op: Extract<Op, { kind: 'create' | 'update' }>) {
  return { title: op.video.title, hash: op.video.hash, part: op.part, url: op.video.url };
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
