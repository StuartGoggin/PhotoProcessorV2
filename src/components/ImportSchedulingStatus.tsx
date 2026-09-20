import type { ImportJob } from "../types/api";
import {
  formatImportBytes, formatImportRate, importPhaseLabel, importSourceLabel,
  importWaitReason, isReadingImportSource, summarizeImportReads,
} from "../utils/importScheduling";

export function ImportJobSchedulingStatus({ job, compact = false }: { job: ImportJob; compact?: boolean }) {
  const waiting = importWaitReason(job);
  const active = job.status === "running" || job.status === "queued" || job.status === "paused";
  const reading = isReadingImportSource(job);
  return (
    <div className={`text-xs ${compact ? "space-y-0.5" : "rounded border border-surface-600 bg-surface-900/40 p-2 space-y-1"}`} aria-label="Import source status">
      <p className="text-cyan-200">{importPhaseLabel(job)}{reading ? ` · ${formatImportRate(job.sourceReadMbps)} source read` : ""}</p>
      <p className="text-gray-400 break-words" title={job.sourceDir}>{importSourceLabel(job)}</p>
      {waiting && <p className="text-amber-200 break-words">{waiting}</p>}
      {!compact && <>
        {active && job.sourceIdentityKnown === false && <p className="text-gray-400">Safe serial scheduling until the physical source can be identified.</p>}
        {job.status === "running" && job.phase === "verifying" && <p className="text-gray-400">Reading the destination, not rereading the SD card.</p>}
        {(job.bytesRead !== undefined || job.bytesCopied !== undefined) && <p className="text-gray-400">Source read: {formatImportBytes(job.bytesRead)} · Copied to staging: {formatImportBytes(job.bytesCopied)}</p>}
      </>}
    </div>
  );
}

export default function ImportSchedulingStatus({ jobs, compact = false }: { jobs: ImportJob[]; compact?: boolean }) {
  if (!jobs.some((job) => job.status === "running" || job.status === "queued" || job.status === "paused")) return null;
  const summary = summarizeImportReads(jobs);
  const partial = summary.unidentifiedReads || summary.incomplete;
  const sourceCount = summary.activeSources === null ? null : `${summary.activeSources}${summary.maxSources === null ? "" : `/${summary.maxSources}`} source slot(s) occupied`;
  return (
    <section className={`text-xs ${compact ? "text-gray-300" : "rounded border border-cyan-900 bg-cyan-950/20 p-3 space-y-2"}`} aria-label="Import source capacity">
      <p className="flex flex-wrap gap-x-3 gap-y-1">
        <span className="font-medium text-cyan-200">Import reads</span>
        <span>{formatImportRate(summary.combinedMbps)} {partial ? "known measured sources" : "combined source read"}</span>
        {sourceCount && <span>{sourceCount}</span>}
        {summary.waitingJobs > 0 && <span className="text-amber-200">{summary.waitingJobs} waiting</span>}
      </p>
      {partial && <p className="text-amber-200">Partial reading: unavailable or unidentified source measurements are not added to the total.</p>}
      {!compact && <p className="text-gray-400">One import stream per physical source; different sources can overlap. Destination verification is separate from source reads. Devices may still share a USB bus. N/A means the measurement is unavailable.</p>}
    </section>
  );
}
