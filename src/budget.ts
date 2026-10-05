import type { Job } from './config/schema.js';

export interface SpendEstimate {
  transcripts: number;
  maxAiMinutes: number;
  /** Worst case: every transcript charged, plus the full AI-minute cap if AI fallback is on. */
  maxUsd: number;
}

export function estimateSpend(job: Job, transcripts: number): SpendEstimate {
  const maxAiMinutes = job.aiFallback.enabled && transcripts > 0 ? job.aiFallback.maxMinutesPerRun : 0;
  const maxUsd = transcripts * job.pricing.transcriptUsd + maxAiMinutes * job.pricing.aiMinuteUsd;
  return { transcripts, maxAiMinutes, maxUsd: Math.round(maxUsd * 10_000) / 10_000 };
}

export function overSpend(job: Job, est: SpendEstimate): string | undefined {
  if (est.maxUsd > job.budget.maxUsdPerRun) {
    return `worst-case spend $${est.maxUsd.toFixed(2)} is over budget.maxUsdPerRun ($${job.budget.maxUsdPerRun.toFixed(2)})`;
  }
  return undefined;
}
