/** Display-only classification: interrupted attempts need a recovery decision,
 * not a place in the active execution queue. No scheduler behavior is changed.
 */
export type JobsView = "active" | "attention" | "history";
export interface JobSummary {
  status: string;
  errors?: readonly string[];
  error?: string | null;
  persistenceError?: string | null;
}
export const JOBS_VIEWS: ReadonlyArray<{ id: JobsView; label: string }> = [
  { id: "active", label: "Active" },
  { id: "attention", label: "Needs attention" },
  { id: "history", label: "History" },
];
export function isActiveJob(job: JobSummary): boolean {
  return ["running", "queued", "paused"].includes(job.status);
}
export function jobNeedsAttention(job: JobSummary): boolean {
  // Superseded errors remain visible in History, not a perpetual alert.
  if (job.status === "retried") return false;
  return ["failed", "interrupted", "aborted", "cancelled"].includes(job.status)
    || Boolean(job.error || job.persistenceError || job.errors?.length)
    || !["running", "queued", "paused", "completed"].includes(job.status);
}
export function matchesJobsView(job: JobSummary, view: JobsView): boolean {
  if (view === "active") return isActiveJob(job);
  if (view === "attention") return jobNeedsAttention(job);
  return !isActiveJob(job);
}
export function countJobs(jobs: readonly JobSummary[]): Record<JobsView, number> {
  return {
    active: jobs.filter(isActiveJob).length,
    attention: jobs.filter(jobNeedsAttention).length,
    history: jobs.filter((job) => !isActiveJob(job)).length,
  };
}
export function readPanelSize(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch { return fallback; }
}
