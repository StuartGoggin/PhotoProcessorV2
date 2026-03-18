import { useEffect, useRef } from "react";
import type { ImportJob, ProcessJob } from "../types";

type Job = ImportJob | ProcessJob;

const STABILIZATION_MODE_LABELS: Record<NonNullable<ProcessJob["stabilizationMode"]>, string> = {
  maxFrame: "Max Frame",
  edgeSafe: "Edge-Safe",
  aggressiveCrop: "Aggressive Crop",
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

  const isProcessJob = "task" in job;
  const taskLabel = isProcessJob ? job.task : "import";
  const hasLogs = job.logs && job.logs.length > 0;
  const stabilizationModeLabel =
    isProcessJob && job.task === "stabilize" && job.stabilizationMode
      ? STABILIZATION_MODE_LABELS[job.stabilizationMode]
      : null;

  return (
    <div className="flex flex-col h-full gap-3 p-4 overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-sm font-semibold text-white">
              {isProcessJob ? `Task: ${taskLabel}` : "Import Job"}
            </h3>
            {stabilizationModeLabel && (
              <p className="text-xs text-cyan-300 mt-0.5">Mode: {stabilizationModeLabel}</p>
            )}
            <p className="text-xs text-gray-400">
              Job ID: <span className="font-mono">{job.id.slice(0, 8)}</span>
            </p>
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
          {isProcessJob ? (
            <>
              <div className="bg-surface-800 rounded px-2 py-1.5">
                <div className="text-gray-500 mb-0.5">Processed</div>
                <div className="font-semibold text-white">{job.processed}</div>
              </div>
              <div className="bg-surface-800 rounded px-2 py-1.5">
                <div className="text-gray-500 mb-0.5">Out of Focus</div>
                <div className="font-semibold text-yellow-300">{job.outOfFocus}</div>
              </div>
            </>
          ) : (
            <>
              <div className="bg-surface-800 rounded px-2 py-1.5">
                <div className="text-gray-500 mb-0.5">Imported</div>
                <div className="font-semibold text-white">{job.imported}</div>
              </div>
              <div className="bg-surface-800 rounded px-2 py-1.5">
                <div className="text-gray-500 mb-0.5">Speed</div>
                <div className="font-semibold text-white">{job.speedMbps.toFixed(1)} MB/s</div>
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
            ref={textareaRef}
            readOnly
            value={job.logs.join("\n")}
            className="flex-1 overflow-auto bg-gray-950 border border-surface-600 rounded px-3 py-2 text-xs text-green-300 font-mono"
            style={{ resize: "none" }}
          />
        ) : (
          <div className="flex-1 bg-gray-950 border border-surface-600 rounded px-3 py-2 flex items-center justify-center">
            <p className="text-xs text-gray-500">
              {job.status === "queued" ? "Waiting to start..." : "No output yet"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
