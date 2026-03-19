import type { ImportJob, ProcessJob } from "../types";

type Job = ImportJob | ProcessJob;

function isProcessJob(job: Job): job is ProcessJob {
  return "task" in job;
}

interface JobTileProps {
  job: Job;
  isSelected?: boolean;
  onClick?: () => void;
}

const PROCESS_TASK_LABELS: Record<ProcessJob["task"], string> = {
  focus: "Focus Detect",
  remove_focus: "Remove Focus",
  enhance: "Enhance",
  remove_enhance: "Remove Enhance",
  bw: "B&W",
  remove_bw: "Remove B&W",
  stabilize: "Stabilize",
  remove_stabilize: "Remove Stabilize",
};

const STABILIZATION_MODE_LABELS: Record<NonNullable<ProcessJob["stabilizationMode"]>, string> = {
  maxFrame: "Max Frame",
  edgeSafe: "Edge-Safe",
  aggressiveCrop: "Aggressive Crop",
};

const STABILIZATION_STRENGTH_LABELS: Record<NonNullable<ProcessJob["stabilizationStrength"]>, string> = {
  gentle: "Gentle",
  balanced: "Balanced",
  strong: "Strong",
};

const STATUS_COLORS: Record<Job["status"], { bg: string; text: string; border: string }> = {
  queued: { bg: "bg-blue-950", text: "text-blue-200", border: "border-blue-700" },
  running: { bg: "bg-emerald-950", text: "text-emerald-200", border: "border-emerald-700" },
  paused: { bg: "bg-amber-950", text: "text-amber-200", border: "border-amber-700" },
  aborted: { bg: "bg-red-950", text: "text-red-200", border: "border-red-700" },
  completed: { bg: "bg-surface-800", text: "text-emerald-300", border: "border-surface-600" },
  failed: { bg: "bg-red-950", text: "text-red-300", border: "border-red-600" },
};

function pct(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

function formatDuration(startStr: string | null, endStr: string | null): string {
  if (!startStr || !endStr) return "";
  try {
    const start = new Date(startStr).getTime();
    const end = new Date(endStr).getTime();
    const ms = end - start;
    const secs = Math.floor(ms / 1000);
    const mins = Math.floor(secs / 60);
    const hours = Math.floor(mins / 60);

    if (hours > 0) return `${hours}h ${mins % 60}m`;
    if (mins > 0) return `${mins}m ${secs % 60}s`;
    return `${secs}s`;
  } catch {
    return "";
  }
}

export default function JobTile({ job, isSelected = false, onClick }: JobTileProps) {
  const progress = pct(job.done, job.total);
  const colors = STATUS_COLORS[job.status];
  const processJob = isProcessJob(job) ? job : null;
  const importJob = !isProcessJob(job) ? job : null;
  const title = processJob ? PROCESS_TASK_LABELS[processJob.task] : "Import";
  const detail = processJob ? processJob.scopeMode : importJob?.reprocessExisting ? "Reprocess" : "Import";
  const duration = formatDuration(job.startedAt, job.finishedAt);
  const stabilizationModeLabel =
    processJob && processJob.task === "stabilize" && processJob.stabilizationMode
      ? STABILIZATION_MODE_LABELS[processJob.stabilizationMode]
      : null;
  const stabilizationStrengthLabel =
    processJob && processJob.task === "stabilize" && processJob.stabilizationStrength
      ? STABILIZATION_STRENGTH_LABELS[processJob.stabilizationStrength]
      : null;
  const bitratePolicyLabel =
    processJob && processJob.task === "stabilize" && typeof processJob.preserveSourceBitrate === "boolean"
      ? processJob.preserveSourceBitrate
        ? "Preserve bitrate"
        : "Encoder quality"
      : null;
  const threadingLabel =
    processJob &&
    processJob.task === "stabilize" &&
    (typeof processJob.stabilizeMaxParallelJobsUsed === "number" ||
      typeof processJob.stabilizeFfmpegThreadsPerJobUsed === "number")
      ? `${processJob.stabilizeMaxParallelJobsUsed ?? "-"} jobs • ${processJob.stabilizeFfmpegThreadsPerJobUsed ?? "-"} threads/job`
      : null;

  return (
    <div
      onClick={onClick}
      className={`
        flex-shrink-0 w-72 rounded-lg border cursor-pointer
        ${colors.bg} ${colors.border}
        p-4 space-y-2 transition-all duration-300
        ${job.status === "running" ? "ring-2 ring-emerald-600 shadow-lg shadow-emerald-600/20" : ""}
        ${job.status === "completed" ? "opacity-75 hover:opacity-100" : ""}
        ${isSelected ? "ring-2 ring-blue-500 shadow-lg shadow-blue-500/30" : "hover:shadow-md"}
      `}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white truncate">{title}</div>
          <div className="text-xs text-gray-400 truncate">{detail}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {stabilizationModeLabel && (
              <div className="inline-flex items-center rounded border border-cyan-700 bg-cyan-900/30 px-2 py-0.5 text-[10px] font-medium text-cyan-200">
                {stabilizationModeLabel}
              </div>
            )}
            {stabilizationStrengthLabel && (
              <div className="inline-flex items-center rounded border border-teal-700 bg-teal-900/30 px-2 py-0.5 text-[10px] font-medium text-teal-200">
                {stabilizationStrengthLabel}
              </div>
            )}
            {bitratePolicyLabel && (
              <div className="inline-flex items-center rounded border border-sky-700 bg-sky-900/30 px-2 py-0.5 text-[10px] font-medium text-sky-200">
                {bitratePolicyLabel}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {job.status === "completed" && <span className="text-emerald-400 text-lg">✓</span>}
          <div className={`text-xs px-2 py-1 rounded-full capitalize whitespace-nowrap font-medium ${colors.text}`}>
            {job.status === "completed" ? "Done" : job.status}
          </div>
        </div>
      </div>

      {/* Progress bar or completion stats */}
      {job.status === "completed" ? (
        // For completed jobs, show elapsed time and summary
        <div className="space-y-2 pt-1">
          {duration && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">Elapsed</span>
              <span className="font-semibold text-emerald-300">{duration}</span>
            </div>
          )}
          {job.total === 0 || job.done === 0 ? (
            <div className="text-xs text-amber-300 bg-amber-950/30 rounded px-2 py-1 text-center">
              {processJob ? "No files matched criteria" : "No files processed"}
            </div>
          ) : (
            <div className="w-full h-1.5 bg-emerald-600/30 rounded-full overflow-hidden">
              <div className="w-full h-full bg-emerald-600 rounded-full" />
            </div>
          )}
        </div>
      ) : (
        // For active jobs, show progress bar
        <div className="space-y-1">
          <div className="w-full h-1.5 bg-surface-700 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 rounded-full ${
                job.status === "running" ? "bg-emerald-500" : job.status === "paused" ? "bg-amber-500" : "bg-blue-500"
              }`}
              style={{ width: `${Math.max(5, progress)}%` }}
            />
          </div>
          <div className="flex justify-between items-center px-1">
            <span className="text-xs text-gray-400">{progress.toFixed(0)}%</span>
            <span className="text-xs text-gray-400">
              {job.done}/{job.total}
            </span>
          </div>
        </div>
      )}

      {/* Stats */}
      {job.status !== "completed" && (
        <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
          {processJob ? (
            <>
              <div className="bg-surface-700/40 rounded px-2 py-1">
                <div className="text-gray-500">Processed</div>
                <div className="font-semibold text-white">{processJob.processed}</div>
              </div>
              <div className="bg-surface-700/40 rounded px-2 py-1">
                <div className="text-gray-500">Out of Focus</div>
                <div className="font-semibold text-yellow-300">{processJob.outOfFocus}</div>
              </div>
            </>
          ) : (
            <>
              <div className="bg-surface-700/40 rounded px-2 py-1">
                <div className="text-gray-500">Imported</div>
                <div className="font-semibold text-white">{importJob?.imported ?? 0}</div>
              </div>
              <div className="bg-surface-700/40 rounded px-2 py-1">
                <div className="text-gray-500">Speed</div>
                <div className="font-semibold text-white">{(importJob?.speedMbps ?? 0).toFixed(1)} MB/s</div>
              </div>
            </>
          )}
        </div>
      )}

      {threadingLabel && (
        <div className="pt-1 border-t border-surface-600">
          <div className="text-xs text-cyan-300">Threading: {threadingLabel}</div>
        </div>
      )}

      {/* Current file if available (for active jobs) or summary (for completed) */}
      {job.status !== "completed" && job.currentFile && (
        <div className="pt-1 border-t border-surface-600">
          <div className="text-xs text-gray-500">Processing:</div>
          <div className="text-xs text-gray-300 truncate">{job.currentFile}</div>
        </div>
      )}

      {job.status === "completed" && job.done > 0 && (
        <div className="pt-1 border-t border-surface-600">
          <div className="grid grid-cols-2 gap-2 text-xs">
            {processJob ? (
              <>
                <div>
                  <span className="text-gray-500">Processed:</span>
                  <span className="ml-1 font-semibold text-emerald-300">{processJob.processed}</span>
                </div>
                <div>
                  <span className="text-gray-500">Out of Focus:</span>
                  <span className="ml-1 font-semibold text-yellow-300">{processJob.outOfFocus}</span>
                </div>
              </>
            ) : (
              <>
                <div>
                  <span className="text-gray-500">Imported:</span>
                  <span className="ml-1 font-semibold text-emerald-300">{importJob?.imported ?? 0}</span>
                </div>
                <div>
                  <span className="text-gray-500">Skipped:</span>
                  <span className="ml-1 font-semibold text-amber-300">{importJob?.skipped ?? 0}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Error indicator */}
      {job.errors.length > 0 && (
        <div className="pt-1 border-t border-surface-600">
          <div className="text-xs font-medium text-red-300">⚠ {job.errors.length} error(s)</div>
        </div>
      )}
    </div>
  );
}
