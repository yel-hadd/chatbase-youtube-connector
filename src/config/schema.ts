import { z } from 'zod';
import { classifyRef } from '../discover/youtube.js';

const regexString = z.string().refine((s) => {
  try {
    toRegExp(s);
    return true;
  } catch {
    return false;
  }
}, 'invalid regular expression');

/** Accepts "(?i)pattern" as a case-insensitive shorthand, like most config formats. */
export function toRegExp(s: string): RegExp {
  return s.startsWith('(?i)') ? new RegExp(s.slice(4), 'i') : new RegExp(s);
}

const refString = z.string().refine((s) => classifyRef(s) !== undefined, 'not a YouTube video or playlist URL/ID');

const sourceSchema = z.union([
  z.object({ channel: z.string().min(2) }).strict(),
  z.object({ playlist: z.string().min(2) }).strict(),
  z.object({ video: z.string().min(2) }).strict(),
]);

const aiFallbackSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxMinutesPerRun: z.number().int().positive().default(60),
    skipLongerThanMin: z.number().int().nonnegative().default(90),
    language: z.string().optional(),
  })
  .strict();

const budgetSchema = z
  .object({
    maxUsdPerRun: z.number().positive().default(5),
    maxNewVideosPerRun: z.number().int().positive().default(200),
    maxDeletesPerRun: z.number().int().nonnegative().default(10),
    storageLimitMb: z.number().positive().optional(),
  })
  .strict();

const pricingSchema = z
  .object({
    transcriptUsd: z.number().nonnegative().default(0.001),
    aiMinuteUsd: z.number().nonnegative().default(0.012),
  })
  .strict();

const filtersSchema = z
  .object({
    titleInclude: z.array(regexString).default([]),
    titleExclude: z.array(regexString).default([]),
    publishedAfter: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
      .optional(),
  })
  .strict();

const defaultsSchema = z
  .object({
    languages: z.array(z.string()).min(1).default(['en']),
    machineTranslate: z.boolean().default(true),
    aiFallback: aiFallbackSchema.default({}),
    segmentSeconds: z.number().int().min(15).max(600).default(60),
    includeShorts: z.boolean().default(false),
    minDurationSec: z.number().int().nonnegative().default(60),
    maxVideos: z.number().int().positive().default(500),
    prune: z.boolean().default(false),
    budget: budgetSchema.default({}),
    pricing: pricingSchema.default({}),
    filters: filtersSchema.default({}),
    /** Videos or playlists to keep out of the agent, by URL or ID. Job entries add to these. */
    exclude: z.array(refString).default([]),
    sink: z.enum(['rest', 'export']).default('rest'),
    exportDir: z.string().default('out'),
    actorId: z.string().default('codepoetry/youtube-transcript-ai-scraper'),
    actorBuild: z.string().optional(),
  })
  .strict();

export type Defaults = z.infer<typeof defaultsSchema>;

// Job-level nested objects must not carry their own defaults, or a job that sets
// one budget field would silently reset the others to built-in defaults instead
// of inheriting them from `defaults`.
const jobSchema = defaultsSchema
  .partial()
  .extend({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes'),
    agentId: z.string().optional(),
    sources: z.array(sourceSchema).min(1),
    aiFallback: z
      .object({
        enabled: z.boolean(),
        maxMinutesPerRun: z.number().int().positive(),
        skipLongerThanMin: z.number().int().nonnegative(),
        language: z.string(),
      })
      .partial()
      .strict()
      .optional(),
    budget: z
      .object({
        maxUsdPerRun: z.number().positive(),
        maxNewVideosPerRun: z.number().int().positive(),
        maxDeletesPerRun: z.number().int().nonnegative(),
        storageLimitMb: z.number().positive(),
      })
      .partial()
      .strict()
      .optional(),
    pricing: z
      .object({ transcriptUsd: z.number().nonnegative(), aiMinuteUsd: z.number().nonnegative() })
      .partial()
      .strict()
      .optional(),
    filters: z
      .object({
        titleInclude: z.array(regexString),
        titleExclude: z.array(regexString),
        publishedAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((job, ctx) => {
    if ((job.sink ?? 'rest') === 'rest' && !job.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'agentId is required when sink is "rest"' });
    }
  });

export const configSchema = z
  .object({
    version: z.literal(1),
    defaults: defaultsSchema.default({}),
    jobs: z.array(jobSchema).min(1),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const j of cfg.jobs) {
      if (seen.has(j.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate job name "${j.name}"` });
      seen.add(j.name);
    }
  });

export type RawConfig = z.infer<typeof configSchema>;
export type Source = z.infer<typeof sourceSchema>;

export interface Job extends Defaults {
  name: string;
  agentId?: string;
  sources: Source[];
}

/** Merge defaults into each job. Nested objects merge one level deep. */
export function resolveJobs(cfg: RawConfig): Job[] {
  return cfg.jobs.map((j) => {
    const d = cfg.defaults;
    return {
      ...d,
      ...j,
      aiFallback: { ...d.aiFallback, ...(j.aiFallback ?? {}) },
      budget: { ...d.budget, ...(j.budget ?? {}) },
      pricing: { ...d.pricing, ...(j.pricing ?? {}) },
      filters: { ...d.filters, ...(j.filters ?? {}) },
      exclude: [...d.exclude, ...(j.exclude ?? [])],
    };
  });
}
