import type { Job } from './config/schema.js';
import { discoverRecent, sourceListingUrl } from './discover/youtube.js';
import { formatTranscript } from './format/markdown.js';
import { contentHash } from './plan/naming.js';
import { planOps, type FormattedVideo, type Op } from './plan/diff.js';
import { excludeReason } from './plan/filters.js';
import { estimateSpend, overSpend, overStorage } from './budget.js';
import { newJobReport, record, type JobReport } from './report.js';
import { StorageLimitError, type Sink } from './sinks/types.js';
import type { TranscribeOptions, TranscribeResult } from './providers/apify.js';
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
  return { videoId: t.id, title: t.title, url: t.url, publishedAt: t.publishedAt, parts, hash: contentHash(parts) };
}

export async function syncJob(job: Job, deps: SyncDeps, opts: SyncOptions): Promise<JobOutcome> {
  const mode = opts.full ? 'full' : 'incremental';
  const report = newJobReport(job.name, deps.sink.kind, mode, opts.dryRun);
  try {
    const owned = await deps.sink.list();
    const ownedIds = new Set(owned.map((o) => o.videoId));
    log.info('inventory loaded', { job: job.name, ownedSources: owned.length, ownedVideos: ownedIds.size });

    let transcripts: Transcript[] = [];
    let goneIds: string[] = [];

    if (!opts.full) {
      // Incremental: free RSS discovery, transcribe only videos we do not hold yet.
      const recent = await discoverRecent(job.sources, deps.fetchFn);
      const fresh: VideoRef[] = [];
      for (const v of recent) {
        if (ownedIds.has(v.id)) continue;
        const why = excludeReason(v, job);
        if (why) record(report, { videoId: v.id, title: v.title, action: 'excluded', detail: why });
        else fresh.push(v);
      }
      const batch = fresh.slice(0, job.budget.maxNewVideosPerRun);
      const est = estimateSpend(job, batch.length);
      report.spend.estimatedMaxUsd = est.maxUsd;
      const over = overSpend(job, est);
      if (over) throw new UserError(over, ExitCode.BudgetExceeded);
      if (opts.dryRun) {
        for (const v of batch) record(report, { videoId: v.id, title: v.title, action: 'planned', detail: 'would transcribe and create' });
        return done(report, ExitCode.Ok);
      }
      if (batch.length) {
        const res = await deps.provider.transcribe(batch.map((v) => watchUrl(v.id)), transcribeOpts(job, job.aiFallback.enabled));
        collect(report, res);
        transcripts = res.transcripts;
      }
    } else {
      // Full: list every video through the Actor (captions only, cheap), then AI-transcribe
      // just the new videos that had no captions.
      const urls = await Promise.all(job.sources.map((s) => sourceListingUrl(s, deps.fetchFn)));
      const est = estimateSpend(job, job.maxVideos * urls.length);
      report.spend.estimatedMaxUsd = est.maxUsd;
      const over = overSpend(job, est);
      if (over) throw new UserError(`${over}. Lower maxVideos or raise the budget.`, ExitCode.BudgetExceeded);
      if (opts.dryRun) {
        record(report, { videoId: '-', action: 'planned', detail: `would list up to ${job.maxVideos} videos per source and diff against ${ownedIds.size} owned videos` });
        return done(report, ExitCode.Ok);
      }
      const listing = await deps.provider.transcribe(urls, transcribeOpts(job, false, job.maxVideos));
      collect(report, listing, /* failuresAreFinal */ !job.aiFallback.enabled);
      const seen = new Set([...listing.transcripts.map((t) => t.id), ...listing.failures.map((f) => f.id)]);
      transcripts = listing.transcripts;

      if (job.aiFallback.enabled) {
        const needAi = listing.failures.filter((f) => f.code === 'NO_CAPTIONS_AVAILABLE' && !ownedIds.has(f.id)).map((f) => f.id);
        if (needAi.length) {
          const ai = await deps.provider.transcribe(needAi.map(watchUrl), transcribeOpts(job, true));
          collect(report, ai);
          transcripts = transcripts.concat(ai.transcripts);
        }
        // Videos sent to the AI run were already recorded by collect(ai).
        const sentToAi = new Set(needAi);
        for (const f of listing.failures) {
          if (sentToAi.has(f.id)) continue;
          const action = f.code === 'NO_CAPTIONS_AVAILABLE' ? 'skipped' : 'failed';
          record(report, { videoId: f.id, action, detail: f.code });
        }
      }

      if (job.prune) {
        goneIds = [...ownedIds].filter((id) => !seen.has(id));
        // Listings are capped by maxVideos; only treat a video as gone when the listing was not truncated.
        if (listing.transcripts.length + listing.failures.length >= job.maxVideos * urls.length) {
          log.warn('listing hit maxVideos; skipping prune to avoid deleting videos beyond the cap', { job: job.name });
          goneIds = [];
        }
      }
    }

    // Filter the transcripts we got (the Actor knows durations; RSS does not).
    const formatted: FormattedVideo[] = [];
    for (const t of transcripts) {
      const why = ownedIds.has(t.id) ? undefined : excludeReason(t, job);
      if (why) record(report, { videoId: t.id, title: t.title, action: 'excluded', detail: why });
      else formatted.push(format(job, t));
    }

    const ops = planOps(formatted, owned, goneIds);
    const deletes = ops.filter((o) => o.kind === 'delete' && o.reason === 'removed-from-youtube');
    if (deletes.length > job.budget.maxDeletesPerRun && !opts.allowMassDelete) {
      throw new UserError(
        `${deletes.length} sources would be deleted, over budget.maxDeletesPerRun (${job.budget.maxDeletesPerRun}). Re-run with --allow-mass-delete if this is intended.`,
        ExitCode.BudgetExceeded,
      );
    }

    const addBytes = ops.reduce((a, o) => {
      if (o.kind === 'create') return a + Buffer.byteLength(o.content, 'utf8');
      if (o.kind === 'update') return a + Buffer.byteLength(o.content, 'utf8') - o.existing.size;
      if (o.kind === 'delete') return a - o.existing.size;
      return a;
    }, 0);
    const usedBefore = await deps.sink.textBytesUsed().catch(() => undefined);
    report.storage = { textBytesBefore: usedBefore };
    const tooBig = overStorage(job, usedBefore, addBytes);
    if (tooBig) throw new UserError(tooBig, ExitCode.BudgetExceeded);

    await apply(ops, deps.sink, report);
    await deps.sink.finish();
    report.storage.textBytesAfter = await deps.sink.textBytesUsed().catch(() => undefined);

    const failed = report.counts.failed > 0 || report.errors.length > 0;
    return done(report, failed ? ExitCode.PartialFailure : ExitCode.Ok);
  } catch (e) {
    const code = e instanceof UserError ? e.exitCode : ExitCode.Unexpected;
    report.aborted = (e as Error).message;
    log.error('job aborted', { job: job.name, error: (e as Error).message });
    return done(report, code);
  }
}

function collect(report: JobReport, res: TranscribeResult, failuresAreFinal = true): void {
  if (res.runId) report.spend.apifyRunIds.push(res.runId);
  if (res.usageUsd !== undefined) report.spend.actualUsd = (report.spend.actualUsd ?? 0) + res.usageUsd;
  if (!failuresAreFinal) return;
  for (const f of res.failures) {
    // A video without captions is expected when AI fallback is off; it is not a failure of the run.
    const action = f.code === 'NO_CAPTIONS_AVAILABLE' ? 'skipped' : 'failed';
    record(report, { videoId: f.id, action, detail: f.code });
  }
}

async function apply(ops: Op[], sink: Sink, report: JobReport): Promise<void> {
  let storageFull = false;
  const doneVideos = new Set<string>();
  for (const op of ops) {
    if (op.kind === 'skip') {
      record(report, { videoId: op.videoId, action: 'unchanged' });
      continue;
    }
    if (storageFull && op.kind !== 'delete') {
      record(report, { videoId: op.videoId, action: 'skipped', detail: 'storage limit reached' });
      continue;
    }
    const meta =
      op.kind === 'delete'
        ? undefined
        : { title: op.video.title, hash: op.video.hash, part: op.part, url: op.video.url, publishedAt: op.video.publishedAt };
    try {
      if (op.kind === 'create') await sink.create(op.videoId, op.name, op.content, meta!);
      else if (op.kind === 'update') await sink.update(op.existing, op.name, op.content, meta!);
      else await sink.remove(op.existing);
      const action = op.kind === 'create' ? 'created' : op.kind === 'update' ? 'updated' : 'deleted';
      // Count a multi-part video once.
      const key = `${action}:${op.videoId}`;
      if (!doneVideos.has(key)) {
        doneVideos.add(key);
        record(report, {
          videoId: op.videoId,
          title: op.kind === 'delete' ? op.existing.name : op.video.title,
          action,
          detail: op.kind === 'delete' ? op.reason : undefined,
        });
      }
    } catch (e) {
      if (e instanceof StorageLimitError) {
        storageFull = true;
        report.errors.push(`Chatbase storage limit reached: ${e.message}`);
        record(report, { videoId: op.videoId, action: 'skipped', detail: 'storage limit reached' });
        continue;
      }
      if (e instanceof UserError) throw e; // auth/plan problems stop the job
      record(report, { videoId: op.videoId, action: 'failed', detail: (e as Error).message });
    }
  }
}

function done(report: JobReport, exitCode: ExitCode): JobOutcome {
  report.finishedAt = new Date().toISOString();
  return { report, exitCode };
}
