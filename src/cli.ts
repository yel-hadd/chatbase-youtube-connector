#!/usr/bin/env node
import { Command } from 'commander';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config/load.js';
import type { Job } from './config/schema.js';
import { ApifyTranscriptProvider } from './providers/apify.js';
import { ChatbaseRestSink } from './sinks/rest.js';
import { ExportSink } from './sinks/export.js';
import type { Sink } from './sinks/types.js';
import { syncJob } from './sync.js';
import { REPORT_SCHEMA_VERSION, renderSummary, writeReports, type RunReport } from './report.js';
import { configureLog, log, registerSecret } from './util/log.js';
import { ExitCode, UserError } from './util/errors.js';
import { resolveChannelId, fetchFeed } from './discover/youtube.js';
import { VERSION } from './version.js';

const env = (k: string): string => process.env[k] ?? '';

function makeSink(job: Job): Sink {
  if (job.sink === 'export') return new ExportSink(join(job.exportDir, job.name));
  return new ChatbaseRestSink(env('CHATBASE_API_KEY'), job.agentId!);
}

function makeProvider(job: Job): ApifyTranscriptProvider {
  return new ApifyTranscriptProvider(env('APIFY_TOKEN'), job.actorId, job.actorBuild);
}

function selectJobs(jobs: Job[], name?: string): Job[] {
  if (!name) return jobs;
  const j = jobs.filter((x) => x.name === name);
  if (!j.length) throw new UserError(`no job named "${name}" in the config`, ExitCode.ConfigInvalid);
  return j;
}

async function main(): Promise<number> {
  registerSecret(process.env.APIFY_TOKEN);
  registerSecret(process.env.CHATBASE_API_KEY);
  let exitCode = 0;

  const program = new Command()
    .name('chatbase-youtube-sync')
    .description('Keep a Chatbase AI agent trained on YouTube videos, with timestamped answers.')
    .version(VERSION)
    .option('-c, --config <path>', 'config file', 'chatbase-youtube.yaml')
    .option('--log-level <level>', 'debug | info | warn | error', 'info')
    .option('--pretty', 'human-readable logs instead of JSON lines', false)
    .hook('preAction', (cmd) => {
      const o = cmd.opts<{ logLevel: 'debug' | 'info' | 'warn' | 'error'; pretty: boolean }>();
      configureLog({ level: o.logLevel, pretty: o.pretty || process.stderr.isTTY === true });
    });

  program
    .command('sync')
    .description('add new videos (default), or with --full re-check every video and handle updates and deletions')
    .option('--job <name>', 'run only this job')
    .option('--full', 'list every video through the transcript Actor instead of the RSS feed', false)
    .option('--dry-run', 'show what would happen; no transcription spend, no writes', false)
    .option('--allow-mass-delete', 'permit deletions above budget.maxDeletesPerRun', false)
    .option('--report <path>', 'where to write the JSON report', 'report.json')
    .action(async (o: { job?: string; full: boolean; dryRun: boolean; allowMassDelete: boolean; report: string }) => {
      const jobs = selectJobs(await loadConfig(program.opts<{ config: string }>().config), o.job);
      const run: RunReport = { schemaVersion: REPORT_SCHEMA_VERSION, tool: 'chatbase-youtube-sync', version: VERSION, jobs: [], exitCode: 0 };
      for (const job of jobs) {
        log.info('job start', { job: job.name, sink: job.sink, full: o.full, dryRun: o.dryRun });
        const out = await syncJob(job, { provider: makeProvider(job), sink: makeSink(job) }, o);
        run.jobs.push(out.report);
        exitCode = Math.max(exitCode, out.exitCode);
      }
      run.exitCode = exitCode;
      await writeReports(run, o.report);
      process.stdout.write(renderSummary(run) + '\n');
    });

  program
    .command('validate')
    .description('check the config file and print the resolved jobs')
    .action(async () => {
      const jobs = await loadConfig(program.opts<{ config: string }>().config);
      process.stdout.write(JSON.stringify(jobs, null, 2) + '\n');
      log.info('config is valid', { jobs: jobs.length });
    });

  program
    .command('doctor')
    .description('check tokens, plan access, agents and YouTube sources without spending anything')
    .option('--job <name>', 'check only this job')
    .action(async (o: { job?: string }) => {
      const jobs = selectJobs(await loadConfig(program.opts<{ config: string }>().config), o.job);
      const results: Array<[string, boolean, string]> = [];
      const check = async (label: string, fn: () => Promise<string>): Promise<void> => {
        try {
          results.push([label, true, await fn()]);
        } catch (e) {
          results.push([label, false, (e as Error).message]);
        }
      };
      for (const job of jobs) {
        await check(`${job.name}: Apify token + Actor`, async () => {
          const r = await makeProvider(job).check();
          return `user ${r.user}, actor ${r.actor}`;
        });
        if (job.sink === 'rest') {
          await check(`${job.name}: Chatbase API + agent`, async () => {
            const r = await new ChatbaseRestSink(env('CHATBASE_API_KEY'), job.agentId!).check();
            return `${r.textSources} text sources, ${(r.textBytes / 1024).toFixed(0)} KB`;
          });
        }
        for (const s of job.sources) {
          if ('channel' in s) {
            await check(`${job.name}: channel ${s.channel}`, async () => {
              const id = await resolveChannelId(s.channel);
              const feed = await fetchFeed('channel', id);
              return `${id}, ${feed.length} recent videos in feed`;
            });
          }
        }
      }
      for (const [label, ok, msg] of results) process.stdout.write(`${ok ? '✔' : '✖'} ${label}: ${msg}\n`);
      if (results.some(([, ok]) => !ok)) exitCode = ExitCode.AuthOrPlan;
    });

  program
    .command('init')
    .description('write a starter chatbase-youtube.yaml')
    .action(async () => {
      const path = program.opts<{ config: string }>().config;
      try {
        await access(path);
        throw new UserError(`${path} already exists`, ExitCode.ConfigInvalid);
      } catch (e) {
        if (e instanceof UserError) throw e;
      }
      await writeFile(path, STARTER, 'utf8');
      process.stdout.write(`wrote ${path}\n`);
    });

  await program.parseAsync(process.argv);
  return exitCode;
}

const STARTER = `version: 1
defaults:
  languages: [en]
  segmentSeconds: 60
  includeShorts: false
  aiFallback: { enabled: false, maxMinutesPerRun: 60 }
  budget: { maxUsdPerRun: 5 }
jobs:
  - name: my-channel
    agentId: \${CHATBASE_AGENT_ID}
    sink: rest            # or "export" on Chatbase Free/Hobby
    sources:
      - channel: "@YourChannel"
`;

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof UserError) {
      log.error(e.message);
      process.exit(e.exitCode);
    }
    log.error('unexpected error', { error: (e as Error).stack ?? String(e) });
    process.exit(ExitCode.Unexpected);
  },
);
