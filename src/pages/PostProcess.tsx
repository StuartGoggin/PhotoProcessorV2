import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProcessProgress, ProcessResult } from "../types";
import { useSettings, useProgressListener } from "../hooks";
import { ProgressBar } from "../components";

type Task = "focus" | "enhance" | "bw";

interface TaskConfig {
  id: Task;
  label: string;
  description: string;
  command: string;
  color: string;
}

const TASKS: TaskConfig[] = [
  {
    id: "focus",
    label: "Focus Detection",
    description: "Analyse JPGs for blur using Laplacian variance. Blurry files get {Out of Focus N} appended to filename.",
    command: "run_focus_detection",
    color: "text-orange-400",
  },
  {
    id: "enhance",
    label: "JPG Enhancement",
    description: "CLAHE contrast enhancement + gentle sharpening. Saves as _improved.jpg alongside originals.",
    command: "run_enhancement",
    color: "text-blue-400",
  },
  {
    id: "bw",
    label: "B&W Conversion",
    description: "CLAHE + sharpen in grayscale. Saves as _BW.jpg alongside originals.",
    command: "run_bw_conversion",
    color: "text-gray-300",
  },
];

export default function PostProcess() {
  const { settings } = useSettings();
  const { subscribe, unsubscribe } = useProgressListener<ProcessProgress>("process-progress");

  const [running, setRunning] = useState<Task | null>(null);
  const [progress, setProgress] = useState<ProcessProgress | null>(null);
  const [results, setResults] = useState<Partial<Record<Task, ProcessResult>>>({});
  const [error, setError] = useState<string | null>(null);

  async function runTask(task: TaskConfig) {
    if (!settings?.staging_dir) {
      setError("Staging directory not configured in Settings.");
      return;
    }

    setRunning(task.id);
    setError(null);
    setProgress(null);

    await subscribe(setProgress);

    try {
      const res = await invoke<ProcessResult>(task.command, {
        stagingDir: settings.staging_dir,
      });
      setResults((r) => ({ ...r, [task.id]: res }));
    } catch (e) {
      setError(String(e));
    } finally {
      unsubscribe();
      setRunning(null);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Post Processing</h2>
      <p className="text-gray-400 text-sm mb-6">
        Run analysis and enhancement operations on images in the staging directory.
      </p>

      {settings?.staging_dir && (
        <div className="card mb-4 text-sm">
          <span className="text-gray-400">Staging: </span>
          <span className="text-gray-200">{settings.staging_dir}</span>
        </div>
      )}

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 mb-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {TASKS.map((task) => {
          const isRunning = running === task.id;
          const result = results[task.id];

          return (
            <div key={task.id} className="card">
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1">
                  <h3 className={`font-medium ${task.color}`}>{task.label}</h3>
                  <p className="text-xs text-gray-500 mt-1">{task.description}</p>
                </div>
                <button
                  className="btn-primary ml-4 whitespace-nowrap"
                  onClick={() => runTask(task)}
                  disabled={running !== null}
                >
                  {isRunning ? "Running..." : "Run"}
                </button>
              </div>

              {isRunning && progress && (
                <div className="mt-3">
                  <ProgressBar
                    total={progress.total}
                    done={progress.done}
                    label={progress.current_file}
                  />
                </div>
              )}

              {result && (
                <div className="mt-2 text-xs text-green-400 flex gap-4">
                  <span>✓ Processed: {result.processed}</span>
                  {result.out_of_focus > 0 && (
                    <span className="text-orange-400">Out of focus: {result.out_of_focus}</span>
                  )}
                  {result.errors.length > 0 && (
                    <span className="text-red-400">Errors: {result.errors.length}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
