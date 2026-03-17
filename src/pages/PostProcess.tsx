import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileTree } from "../components";
import type { ProcessScopeMode, ProcessTask, TreeNode } from "../types";
import { useSettings } from "../hooks";

interface TaskConfig {
  label: string;
  description: string;
  color: string;
  runTaskId: ProcessTask;
  removeTaskId: ProcessTask;
  removeLabel: string;
  removeDescription: string;
}

interface PostProcessProps {
  onOpenJobs?: () => void;
}

const TASKS: TaskConfig[] = [
  {
    label: "Focus Detection",
    description: "Analyse JPGs for blur using Laplacian variance. Blurry files get {Out of Focus N} appended to filename.",
    color: "text-orange-400",
    runTaskId: "focus",
    removeTaskId: "remove_focus",
    removeLabel: "Remove Focus Flags",
    removeDescription: "Rename files with {Out of Focus N} back to their original filenames when the original name is free.",
  },
  {
    label: "JPG Enhancement",
    description: "CLAHE contrast enhancement + gentle sharpening. Saves as _improved.jpg alongside originals.",
    color: "text-blue-400",
    runTaskId: "enhance",
    removeTaskId: "remove_enhance",
    removeLabel: "Remove Enhancement Outputs",
    removeDescription: "Delete only generated _improved.jpg files inside the selected scope.",
  },
  {
    label: "B&W Conversion",
    description: "CLAHE + sharpen in grayscale. Saves as _BW.jpg alongside originals.",
    color: "text-gray-300",
    runTaskId: "bw",
    removeTaskId: "remove_bw",
    removeLabel: "Remove B&W Outputs",
    removeDescription: "Delete only generated _BW.jpg files inside the selected scope.",
  },
  {
    label: "MP4 Stabilisation",
    description: "Two-pass vid.stab stabilization for MP4s. Writes _stabilized.mp4 beside the source, preserves timestamps, reuses the same output name on reruns, and prefers NVIDIA H.264 encode when FFmpeg exposes NVENC.",
    color: "text-cyan-300",
    runTaskId: "stabilize",
    removeTaskId: "remove_stabilize",
    removeLabel: "Remove Stabilised MP4s",
    removeDescription: "Delete only generated _stabilized.mp4 files inside the selected scope.",
  },
];

const SCOPE_MODES: Array<{ id: ProcessScopeMode; label: string; description: string }> = [
  { id: "entireStaging", label: "Entire staging", description: "Ignore selected folder and process the whole staging tree." },
  { id: "folderRecursive", label: "Folder recursively", description: "Process the selected folder and all of its subfolders." },
  { id: "folderOnly", label: "This folder only", description: "Process only files directly inside the selected folder." },
];

function resolveTaskAction(taskId: ProcessTask): { actionLabel: string; isCleanup: boolean } {
  for (const task of TASKS) {
    if (task.runTaskId === taskId) {
      return { actionLabel: task.label, isCleanup: false };
    }
    if (task.removeTaskId === taskId) {
      return { actionLabel: task.removeLabel, isCleanup: true };
    }
  }
  return { actionLabel: taskId, isCleanup: false };
}

export default function PostProcess({ onOpenJobs }: PostProcessProps) {
  const { settings } = useSettings();

  const [queueingTask, setQueueingTask] = useState<ProcessTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastQueuedJobId, setLastQueuedJobId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedScope, setSelectedScope] = useState<string>("");
  const [scopeMode, setScopeMode] = useState<ProcessScopeMode>("entireStaging");

  const canQueue = Boolean(settings?.staging_dir);
  const effectiveScope = useMemo(() => {
    if (!settings?.staging_dir) return "";
    if (scopeMode === "entireStaging") return settings.staging_dir;
    return selectedScope || settings.staging_dir;
  }, [scopeMode, selectedScope, settings?.staging_dir]);
  const scopeModeLabel = useMemo(
    () => SCOPE_MODES.find((mode) => mode.id === scopeMode)?.label ?? scopeMode,
    [scopeMode]
  );

  useEffect(() => {
    async function loadTree() {
      const staging = settings?.staging_dir || "";
      if (!staging) {
        setTree([]);
        setSelectedScope("");
        return;
      }

      try {
        const data = await invoke<TreeNode | TreeNode[]>("list_staging_tree", {
          stagingDir: staging,
        });
        const nodes = Array.isArray(data) ? data : [data];
        setTree(nodes.filter((node) => node.type === "dir"));
        setSelectedScope(staging);
      } catch (e) {
        setError(String(e));
      }
    }

    void loadTree();
  }, [settings?.staging_dir]);

  async function runTask(taskId: ProcessTask) {
    if (!settings?.staging_dir) {
      setError("Staging directory not configured in Settings.");
      return;
    }

    const { actionLabel, isCleanup } = resolveTaskAction(taskId);
    if (isCleanup) {
      const confirmed = window.confirm(
        `Queue "${actionLabel}"?\n\nThis cleanup job will run in:\n${effectiveScope}`
      );
      if (!confirmed) return;
    }

    setQueueingTask(taskId);
    setError(null);
    setMessage(null);
    setLastQueuedJobId(null);

    try {
      const jobId = await invoke<string>("start_process_job", {
        stagingDir: settings.staging_dir,
        scopeDir: effectiveScope,
        scopeMode,
        task: taskId,
      });
      setMessage(`Queued ${actionLabel}. Job ID: ${jobId}.`);
      setLastQueuedJobId(jobId);
    } catch (e) {
      setError(String(e));
    } finally {
      setQueueingTask(null);
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Post Processing</h2>
      <p className="text-gray-400 text-sm mb-6">
        Run analysis and enhancement operations on JPGs, plus stabilization jobs for MP4s, in the staging directory.
      </p>

      {!canQueue && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg px-4 py-3 mb-4 text-yellow-200 text-sm">
          Set the staging directory in Settings before queueing post-process jobs.
        </div>
      )}

      {settings?.staging_dir && (
        <div className="card mb-4 text-sm">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <h3 className="text-white font-medium">Current Queue Target</h3>
            <span className="text-xs px-2 py-1 rounded bg-surface-700 text-gray-200">{scopeModeLabel}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <span className="text-gray-400">Staging: </span>
              <span className="text-gray-200 break-all">{settings.staging_dir}</span>
            </div>
            <div>
              <span className="text-gray-400">Scope: </span>
              <span className="text-gray-200 break-all">{effectiveScope}</span>
            </div>
          </div>
        </div>
      )}

      {settings?.staging_dir && (
        <div className="card mb-6">
          <div className="flex items-center justify-between gap-4 mb-3">
            <div>
              <h3 className="text-white font-medium">Processing Scope</h3>
              <p className="text-xs text-gray-400">Select a folder inside staging, then choose whether to process just that folder, recursively, or the full staging tree.</p>
            </div>
            <button
              className="btn-secondary"
              onClick={() => {
                setSelectedScope(settings.staging_dir);
                setScopeMode("entireStaging");
              }}
              disabled={scopeMode === "entireStaging" && selectedScope === settings.staging_dir}
            >
              Use Full Staging
            </button>
          </div>
          <div className="text-xs text-gray-400 mb-3">
            Selected target: <span className="text-gray-200 break-all">{effectiveScope}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
            {SCOPE_MODES.map((mode) => (
              <button
                key={mode.id}
                className={`text-left rounded-lg border px-3 py-2 transition-colors ${scopeMode === mode.id ? "border-accent bg-accent/10 text-white" : "border-surface-600 bg-surface-800 text-gray-300 hover:bg-surface-700"}`}
                onClick={() => setScopeMode(mode.id)}
              >
                <div className="text-sm font-medium">{mode.label}</div>
                <div className="text-xs text-gray-400 mt-1">{mode.description}</div>
              </button>
            ))}
          </div>
          <div className="h-64 rounded-lg border border-surface-600 bg-surface-900/60 overflow-hidden">
            <FileTree
              nodes={tree}
              selected={selectedScope.replace(settings.staging_dir, "").replace(/^[\\/]+/, "")}
              onSelect={(node) => {
                if (node.type !== "dir") return;
                const relative = node.path.replace(/^[\\/]+/, "");
                const absolute = relative ? `${settings.staging_dir}\\${relative.replace(/\//g, "\\")}` : settings.staging_dir;
                setSelectedScope(absolute);
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 mb-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {message && (
        <div className="bg-green-900/40 border border-green-700 rounded-lg px-4 py-3 mb-4 text-green-300 text-sm">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span>{message}</span>
            {onOpenJobs && lastQueuedJobId && (
              <button className="btn-secondary px-3 py-1.5 text-sm" onClick={onOpenJobs}>
                Open Jobs
              </button>
            )}
          </div>
        </div>
      )}

      <div className="space-y-4">
        {TASKS.map((task) => {
          const isQueueingRun = queueingTask === task.runTaskId;
          const isQueueingRemove = queueingTask === task.removeTaskId;

          return (
            <div key={task.runTaskId} className="card space-y-4">
              <div className="space-y-1">
                <h3 className={`font-medium ${task.color}`}>{task.label}</h3>
                <p className="text-sm text-gray-400">{task.description}</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-lg border border-surface-600 bg-surface-900/60 px-3 py-3 space-y-3">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-400">Run Task</div>
                    <p className="text-xs text-gray-500 mt-1">Queue this operation for the selected scope.</p>
                  </div>
                  <button
                    className="btn-primary w-full md:w-auto"
                    onClick={() => runTask(task.runTaskId)}
                    disabled={queueingTask !== null || !canQueue}
                  >
                    {isQueueingRun ? "Queueing..." : "Queue Job"}
                  </button>
                </div>
                <div className="rounded-lg border border-red-900/70 bg-red-950/20 px-3 py-3 space-y-3">
                  <div>
                    <div className="text-sm font-medium text-red-300">{task.removeLabel}</div>
                    <p className="text-xs text-gray-400 mt-1">{task.removeDescription}</p>
                  </div>
                  <button
                    className="btn-danger w-full md:w-auto"
                    onClick={() => runTask(task.removeTaskId)}
                    disabled={queueingTask !== null || !canQueue}
                  >
                    {isQueueingRemove ? "Queueing..." : "Queue Cleanup Job"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
