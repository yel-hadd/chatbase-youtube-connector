import { appendFile, writeFile } from 'node:fs/promises';

export const REPORT_SCHEMA_VERSION = 1;

export interface VideoResult {
  videoId: string;
  title?: string;
  action: 'created' | 'updated' | 'deleted' | 'unchanged' | 'excluded' | 'failed' | 'planned' | 'skipped';
  detail?: string;
}

export interface JobReport {
  job: string;
  sink: 'rest' | 'export';
  mode: 'incremental' | 'full';
  dryRun: boolean;
  startedAt: string;
  finishedAt?: string;
  counts: Record<VideoResult['action'], number>;
  spend: { estimatedMaxUsd: number; actualUsd?: number; apifyRunIds: string[] };
  storage?: { textBytesBefore?: number; textBytesAfter?: number };
  videos: VideoResult[];
  errors: string[];
  aborted?: string;
  /** A budget, storage or delete cap stopped part of the run. */
  capHit?: boolean;
}

export interface RunReport {
  schemaVersion: number;
  tool: string;
  version: string;
  jobs: JobReport[];
  exitCode: number;
}

export function newJobReport(
  job: string,
  sink: 'rest' | 'export',
  mode: 'incremental' | 'full',
  dryRun: boolean,
): JobReport {
  return {
    job,
    sink,
    mode,
    dryRun,
    startedAt: new Date().toISOString(),
    counts: { created: 0, updated: 0, deleted: 0, unchanged: 0, excluded: 0, failed: 0, planned: 0, skipped: 0 },
    spend: { estimatedMaxUsd: 0, apifyRunIds: [] },
    videos: [],
    errors: [],
  };
}

export function record(r: JobReport, v: VideoResult): void {
  r.counts[v.action]++;
  r.videos.push(v);
}

const usd = (n: number): string => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

export function renderSummary(run: RunReport): string {
  const lines = ['## Chatbase YouTube sync', ''];
  for (const j of run.jobs) {
    const c = j.counts;
    lines.push(`### ${j.job} (${j.mode}${j.dryRun ? ', dry run' : ''}, sink: ${j.sink})`);
    if (j.aborted) lines.push(`**Aborted:** ${j.aborted}`);
    lines.push(
      '',
      '| Created | Updated | Deleted | Unchanged | Excluded | Failed | Planned |',
      '|---|---|---|---|---|---|---|',
      `| ${c.created} | ${c.updated} | ${c.deleted} | ${c.unchanged} | ${c.excluded} | ${c.failed} | ${c.planned} |`,
      '',
      `Spend: up to ${usd(j.spend.estimatedMaxUsd)} estimated${j.spend.actualUsd !== undefined ? `, ${usd(j.spend.actualUsd)} Apify-reported run usage` : ''}.`,
    );
    const changed = j.videos.filter((v) => ['created', 'updated', 'deleted', 'failed', 'planned'].includes(v.action));
    if (changed.length) {
      lines.push('', '| Video | Action | Detail |', '|---|---|---|');
      for (const v of changed.slice(0, 50)) {
        lines.push(
          `| [${(v.title ?? v.videoId).replace(/\|/g, '/')}](https://youtu.be/${v.videoId}) | ${v.action} | ${v.detail ?? ''} |`,
        );
      }
      if (changed.length > 50) lines.push(`| … | ${changed.length - 50} more | |`);
    }
    for (const e of j.errors) lines.push(`- ⚠️ ${e}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function writeReports(run: RunReport, reportPath: string): Promise<void> {
  await writeFile(reportPath, JSON.stringify(run, null, 2) + '\n', 'utf8');
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) await appendFile(summary, renderSummary(run) + '\n', 'utf8');
}
