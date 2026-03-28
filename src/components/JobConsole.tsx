import { useEffect, useRef } from "react";
import type { ImportJob, ProcessJob } from "../types";
import { getProcessAttemptLabel, getProcessResultLabel } from "../utils";

type Job = ImportJob | ProcessJob;

function isProcessJob(job: Job): job is ProcessJob {
  return "task" in job;
}

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

const PROCESS_TASK_LABELS: Record<ProcessJob["task"], string> = {
  focus: "Focus Detection",
  remove_focus: "Remove Focus Flags",
  enhance: "JPG Enhancement",
  remove_enhance: "Remove Enhancement Outputs",
  bw: "B&W Conversion",
  remove_bw: "Remove B&W Outputs",
  stabilize: "MP4 Stabilisation",
  remove_stabilize: "Remove Stabilised MP4s",
  scan_archive_naming: "Archive Naming Scan",
  apply_event_naming: "Apply Event Naming",
  transfer: "Transfer to NAS",
  verify_checksums: "Verify Checksums",
};

const PROCESS_PHASE_LABELS: Record<string, string> = {
  transfer_copy: "Copying files to archive",
  transfer_md5: "Generating transfer checksums",
  transfer_manifest: "Writing transfer manifest",
  transfer_master_manifest: "Updating master checksum manifest",
  verify_checksums: "Verifying checksum manifest",
  done: "Completed",
};

interface JobConsoleProps {
  job: Job | null;
  onClose?: () => void;
}

export default function JobConsole({ job, onClose }: JobConsoleProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom as logs grow
  useEffect(() => {
    if (textareaRef.current && job && job.logs.length > 0) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
    }
  }, [job?.logs]);

  if (!job) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <p className="text-sm">Select a job tile to view its console output</p>
      </div>
    );
  }

  const processJob = isProcessJob(job) ? job : null;
  const importJob = !isProcessJob(job) ? job : null;
  const taskLabel = processJob ? PROCESS_TASK_LABELS[processJob.task] : "Import";
  const processPhaseLabel = processJob?.currentPhase ? PROCESS_PHASE_LABELS[processJob.currentPhase] ?? processJob.currentPhase : null;
  const hasLogs = job.logs && job.logs.length > 0;
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
        ? "Preserve source bitrate"
        : "Encoder quality mode"
      : null;
  const threadingLabel =
    processJob &&
    processJob.task === "stabilize" &&
    (typeof processJob.stabilizeMaxParallelJobsUsed === "number" ||
      typeof processJob.stabilizeFfmpegThreadsPerJobUsed === "number")
      ? `${processJob.stabilizeMaxParallelJobsUsed ?? "-"} parallel jobs, ${processJob.stabilizeFfmpegThreadsPerJobUsed ?? "-"} ffmpeg threads/job`
      : null;
  const isTransferJob = processJob?.task === "transfer";
  const transferLocalProcessedCount = processJob?.transferLocalProcessedCount ?? 0;
  const transferLocalSidecarHitsCount = processJob?.transferLocalSidecarHitsCount ?? 0;
  const transferLocalManifestHitsCount = processJob?.transferLocalManifestHitsCount ?? 0;
  const transferLocalHashComputedCount = processJob?.transferLocalHashComputedCount ?? 0;
  const transferUploadedCount = processJob?.transferUploadedCount ?? 0;
  const transferDeduplicatedCount = processJob?.transferDeduplicatedCount ?? 0;
  const transferRenamedCount = processJob?.transferRenamedCount ?? 0;
  const transferServerHashMatchCount = processJob?.transferServerHashMatchCount ?? 0;
  const transferServerHashUnverifiedCount = processJob?.transferServerHashUnverifiedCount ?? 0;
  const transferIndexedAddedCount = processJob?.transferIndexedAddedCount ?? 0;
  const transferCopyRemainingCount = Math.max((job.total ?? 0) - transferUploadedCount, 0);
  const transferVerifyNonDuplicateCount = Math.max(
    transferLocalProcessedCount - transferDeduplicatedCount,
    0,
  );

  const transferPhaseSummary = (() => {
    if (!isTransferJob || !processJob) return [] as Array<{ label: string; value: number; tone?: string }>;

    switch (processJob.currentPhase) {
      case "compute_local_hashes":
        return [
          { label: "Local Processed", value: transferLocalProcessedCount, tone: "text-white" },
          { label: "Sidecar Hits", value: transferLocalSidecarHitsCount, tone: "text-teal-300" },
          { label: "Manifest Hits", value: transferLocalManifestHitsCount, tone: "text-cyan-300" },
          { label: "Computed", value: transferLocalHashComputedCount, tone: "text-amber-300" },
          { label: "Remaining", value: Math.max((job.total ?? 0) - transferLocalProcessedCount, 0), tone: "text-gray-300" },
        ];
      case "verify_server":
        return [
          { label: "Hash Matches", value: transferServerHashMatchCount, tone: "text-sky-300" },
          { label: "Verified Duplicates", value: transferDeduplicatedCount, tone: "text-cyan-300" },
          { label: "Non-Duplicate", value: transferVerifyNonDuplicateCount, tone: "text-amber-300" },
          { label: "Unverified Matches", value: transferServerHashUnverifiedCount, tone: "text-rose-300" },
        ];
      case "transfer_copy":
        return [
          { label: "Uploaded", value: transferUploadedCount, tone: "text-emerald-300" },
          { label: "Remaining", value: transferCopyRemainingCount, tone: "text-amber-300" },
          { label: "Renamed", value: transferRenamedCount, tone: "text-yellow-300" },
        ];
      case "update_master_hashes":
        return [
          { label: "Indexed Added", value: transferIndexedAddedCount, tone: "text-teal-300" },
          { label: "Uploaded", value: transferUploadedCount, tone: "text-emerald-300" },
        ];
      default:
        return [
          { label: "Local Processed", value: transferLocalProcessedCount, tone: "text-white" },
          { label: "Uploaded", value: transferUploadedCount, tone: "text-emerald-300" },
          { label: "Deduplicated", value: transferDeduplicatedCount, tone: "text-cyan-300" },
        ];
    }
  })();

  return (
    <div className="flex flex-col h-full gap-3 p-4 overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-sm font-semibold text-white">
              {processJob ? `Task: ${taskLabel}` : "Import Job"}
            </h3>
            {stabilizationModeLabel && (
              <p className="text-xs text-cyan-300 mt-0.5">Mode: {stabilizationModeLabel}</p>
            )}
            {stabilizationStrengthLabel && (
              <p className="text-xs text-teal-300 mt-0.5">Strength: {stabilizationStrengthLabel}</p>
            )}
            {bitratePolicyLabel && (
              <p className="text-xs text-sky-300 mt-0.5">Bitrate: {bitratePolicyLabel}</p>
            )}
            {threadingLabel && (
              <p className="text-xs text-cyan-200/90 mt-0.5">Threading in use: {threadingLabel}</p>
            )}
            {processPhaseLabel && (
              <p className="text-xs text-amber-300 mt-0.5">Phase: {processPhaseLabel}</p>
            )}
            <p className="text-xs text-gray-400">
              Job ID: <span className="font-mono">{job.id.slice(0, 8)}</span>
            </p>
            {importJob?.logFilePath && (
              <p className="text-xs text-gray-400 break-all">
                Log File: <span className="font-mono text-gray-300">{importJob.logFilePath}</span>
              </p>
            )}
            {importJob?.manifestFilePath && (
              <p className="text-xs text-gray-400 break-all">
                Manifest: <span className="font-mono text-gray-300">{importJob.manifestFilePath}</span>
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className={`text-xs px-2 py-1 rounded-full capitalize font-medium ${
              job.status === "running" ? "bg-emerald-900/40 text-emerald-200 border border-emerald-700" :
              job.status === "completed" ? "bg-emerald-900/40 text-emerald-300 border border-emerald-700" :
              job.status === "failed" ? "bg-red-900/40 text-red-300 border border-red-700" :
              job.status === "paused" ? "bg-amber-900/40 text-amber-200 border border-amber-700" :
              "bg-surface-700 text-gray-300 border border-surface-600"
            }`}>
              {job.status === "completed" ? "Done" : job.status}
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-200 transition-colors p-1 hover:bg-surface-700 rounded"
              title="Close console"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-4 gap-2 text-xs">
          <div className="bg-surface-800 rounded px-2 py-1.5">
            <div className="text-gray-500 mb-0.5">Progress</div>
            <div className="font-semibold text-white">{job.done}/{job.total}</div>
          </div>
          {processJob ? (
            <>
              <div className="bg-surface-800 rounded px-2 py-1.5">
                <div className="text-gray-500 mb-0.5">{getProcessAttemptLabel(processJob.task)}</div>
                <div className="font-semibold text-white">{isTransferJob ? transferLocalProcessedCount : processJob.processed}</div>
              </div>
              <div className="bg-surface-800 rounded px-2 py-1.5">
                <div className="text-gray-500 mb-0.5">{getProcessResultLabel(processJob.task)}</div>
                <div className="font-semibold text-yellow-300">{isTransferJob ? transferUploadedCount : processJob.resultCount}</div>
              </div>
            </>
          ) : (
            <>
              <div className="bg-surface-800 rounded px-2 py-1.5">
                <div className="text-gray-500 mb-0.5">Imported</div>
                <div className="font-semibold text-white">{importJob?.imported ?? 0}</div>
              </div>
              <div className="bg-surface-800 rounded px-2 py-1.5">
                <div className="text-gray-500 mb-0.5">Speed</div>
                <div className="font-semibold text-white">{(importJob?.speedMbps ?? 0).toFixed(1)} MB/s</div>
              </div>
            </>
          )}
          <div className="bg-surface-800 rounded px-2 py-1.5">
            <div className="text-gray-500 mb-0.5">Errors</div>
            <div className={`font-semibold ${job.errors.length > 0 ? "text-red-300" : "text-gray-400"}`}>
              {job.errors.length}
            </div>
          </div>
        </div>
        {isTransferJob && (
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-2 text-xs mt-2">
            <div className="bg-surface-800 rounded px-2 py-1.5">
              <div className="text-gray-500 mb-0.5">Uploaded</div>
              <div className="font-semibold text-emerald-300">{transferUploadedCount}</div>
            </div>
            <div className="bg-surface-800 rounded px-2 py-1.5">
              <div className="text-gray-500 mb-0.5">Deduplicated</div>
              <div className="font-semibold text-cyan-300">{transferDeduplicatedCount}</div>
            </div>
            <div className="bg-surface-800 rounded px-2 py-1.5">
              <div className="text-gray-500 mb-0.5">Renamed</div>
              <div className="font-semibold text-amber-300">{transferRenamedCount}</div>
            </div>
            <div className="bg-surface-800 rounded px-2 py-1.5">
              <div className="text-gray-500 mb-0.5">Hash Matches</div>
              <div className="font-semibold text-sky-300">{transferServerHashMatchCount}</div>
            </div>
            <div className="bg-surface-800 rounded px-2 py-1.5">
              <div className="text-gray-500 mb-0.5">Unverified Matches</div>
              <div className="font-semibold text-rose-300">{transferServerHashUnverifiedCount}</div>
            </div>
            <div className="bg-surface-800 rounded px-2 py-1.5">
              <div className="text-gray-500 mb-0.5">Indexed Added</div>
              <div className="font-semibold text-teal-300">{transferIndexedAddedCount}</div>
            </div>
          </div>
        )}
        {isTransferJob && transferPhaseSummary.length > 0 && (
          <div className="mt-2 rounded border border-surface-700 bg-surface-900/40 px-2 py-1.5">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Phase Summary</div>
            <div className="flex flex-wrap gap-3 text-xs">
              {transferPhaseSummary.map((item) => (
                <div key={item.label} className="inline-flex items-center gap-1">
                  <span className="text-gray-400">{item.label}:</span>
                  <span className={`font-semibold ${item.tone ?? "text-white"}`}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {importJob && (
          <div className="grid grid-cols-5 gap-2 text-xs mt-2">
            <div className="bg-surface-800 rounded px-2 py-1.5">
              <div className="text-gray-500 mb-0.5">Source Files</div>
              <div className="font-semibold text-white">{importJob.sourceFileTotal}</div>
            </div>
            <div className="bg-surface-800 rounded px-2 py-1.5">
              <div className="text-gray-500 mb-0.5">Attempted</div>
              <div className="font-semibold text-white">{importJob.done}/{importJob.total}</div>
            </div>
            <div className="bg-surface-800 rounded px-2 py-1.5">
              <div className="text-gray-500 mb-0.5">Ignored</div>
              <div className="font-semibold text-sky-300">{importJob.ignoredFileTotal}</div>
            </div>
            <div className="bg-surface-800 rounded px-2 py-1.5">
              <div className="text-gray-500 mb-0.5">Ignored .md5</div>
              <div className="font-semibold text-cyan-300">{importJob.ignoredLegacyMd5SidecarTotal}</div>
            </div>
            <div className="bg-surface-800 rounded px-2 py-1.5">
              <div className="text-gray-500 mb-0.5">Unsupported</div>
              <div className="font-semibold text-amber-300">{importJob.unsupportedFileTotal}</div>
            </div>
          </div>
        )}
      </div>

      {/* Errors section */}
      {job.errors.length > 0 && (
        <div className="flex-shrink-0 bg-red-900/20 border border-red-700 rounded p-2 max-h-20 overflow-auto">
          <div className="text-xs font-medium text-red-200 mb-1">Errors</div>
          <div className="text-xs text-red-300 space-y-0.5">
            {job.errors.slice(-5).map((err, idx) => (
              <div key={idx} className="truncate">{err}</div>
            ))}
            {job.errors.length > 5 && <div className="text-red-400 text-xs italic">... +{job.errors.length - 5} more</div>}
          </div>
        </div>
      )}

      {/* Console */}
      <div className="flex-1 flex flex-col min-h-0">
        <label className="text-xs text-gray-400 mb-1 flex-shrink-0">
          Console Output {hasLogs && `(${job.logs.length} lines)`}
        </label>
        {hasLogs ? (
          <textarea
            id="job-console-output"
            ref={textareaRef}
            readOnly
            value={job.logs.join("\n")}
            aria-label="Job console output"
            title="Job console output"
            className="job-console-textarea flex-1 overflow-auto bg-gray-950 border border-surface-600 rounded px-3 py-2 text-xs text-green-300 font-mono"
          />
        ) : (
          <div className="flex-1 bg-gray-950 border border-surface-600 rounded px-3 py-2 flex items-center justify-center">
            <p className="text-xs text-gray-500">
              {job.status === "queued" ? "Waiting to start..." : "No output yet"}
            </p>
          </div>
        )}
      </div>

      {/* Status Line (updates in-place) */}
      {processJob?.statusLine && job.status === "running" && (
        <div className="flex-shrink-0 bg-surface-800/50 border border-surface-600 rounded px-3 py-2">
          <p className="text-xs text-cyan-300 font-mono">
            ▶ {processJob.statusLine}
          </p>
        </div>
      )}
    </div>
  );
}
