import type { ImportJob } from "../types/api";

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function formatImportRate(value: unknown): string {
  return nonNegative(value) ? `${value.toFixed(1)} MB/s` : "N/A";
}

export function formatImportBytes(value: unknown): string {
  if (!nonNegative(value)) return "N/A";
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

export function importWaitReason(job: ImportJob): string | null {
  if (!["queued", "running", "paused"].includes(job.status)) return null;
  return typeof job.waitReason === "string" && job.waitReason.trim() ? job.waitReason : null;
}

export function importPhaseLabel(job: ImportJob): string {
  if (job.status === "paused") return "Paused";
  if (job.status === "completed") return "Completed";
  if (job.status === "failed") return "Failed";
  if (job.status === "aborted") return "Aborted";
  if (job.status === "queued" || job.phase === "waiting") return "Waiting";
  const labels: Record<string, string> = {
    scanning: "Scanning source",
    copying: "Copying + checksumming source",
    hashing: "Checksumming source",
    verifying: "Verifying destination copy",
    publishing: "Publishing verified file",
    recovering: "Recovering unfinished imports",
  };
  const label = typeof job.phase === "string" ? labels[job.phase] : undefined;
  return typeof label === "string" ? label : "Importing";
}

export function isReadingImportSource(job: ImportJob): boolean {
  return job.status === "running" && job.phase === "copying";
}

export function importSourceLabel(job: ImportJob): string {
  const label = typeof job.sourceDevice === "string" && job.sourceDevice.trim() ? job.sourceDevice : null;
  return label ? `${label}${job.sourceIdentityKnown === true ? "" : " (physical identity unavailable)"}` : "Source identity unavailable";
}

export interface ImportReadSummary {
  knownSources: number;
  combinedMbps: number | null;
  unidentifiedReads: boolean;
  incomplete: boolean;
  waitingJobs: number;
  activeSources: number | null;
  maxSources: number | null;
}

/** Only source reads are combined; destination verification and saved rates are not live reads. */
export function summarizeImportReads(jobs: ImportJob[]): ImportReadSummary {
  const sources = new Map<string, number | null>();
  let unidentifiedReads = false;
  let incomplete = false;
  let waitingJobs = 0;
  let activeSources: number | null = null;
  let maxSources: number | null = null;
  for (const job of jobs) {
    if (job.status === "queued" || (job.status === "running" && job.phase === "waiting")) waitingJobs += 1;
    if (job.status !== "running" && job.status !== "queued" && job.status !== "paused") continue;
    if (Number.isInteger(job.activeSources) && nonNegative(job.activeSources)) {
      activeSources = Math.max(activeSources ?? 0, job.activeSources);
    }
    if (Number.isInteger(job.maxSources) && nonNegative(job.maxSources) && job.maxSources > 0) {
      maxSources = Math.max(maxSources ?? 0, job.maxSources);
    }
    if (job.status === "running" && !job.phase) incomplete = true;
    if (!isReadingImportSource(job)) continue;
    const source = typeof job.sourceDeviceKey === "string" ? job.sourceDeviceKey.trim() : "";
    if (job.sourceIdentityKnown !== true || !source) {
      unidentifiedReads = true;
      continue;
    }
    const rate = nonNegative(job.sourceReadMbps) ? job.sourceReadMbps : null;
    // A poll/event overlap must not count one physical source twice. Keep one
    // measurement, not the sum; unknown identities are excluded altogether.
    const previous = sources.get(source);
    sources.set(source, rate === null ? previous ?? null : Math.max(previous ?? 0, rate));
  }
  if ([...sources.values()].some((value) => value === null)) incomplete = true;
  const rates = [...sources.values()].filter((value): value is number => value !== null);
  const combined = rates.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(combined)) incomplete = true;
  return {
    knownSources: sources.size,
    combinedMbps: rates.length && Number.isFinite(combined) ? combined : sources.size || unidentifiedReads || incomplete ? null : 0,
    unidentifiedReads,
    incomplete,
    waitingJobs,
    activeSources: activeSources !== null && maxSources !== null && activeSources > maxSources ? null : activeSources,
    maxSources,
  };
}
