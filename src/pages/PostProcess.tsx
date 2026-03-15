import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProcessTask } from "../types";
import { useSettings } from "../hooks";

interface TaskConfig {
  id: ProcessTask;
  label: string;
  description: string;
  color: string;
}

const TASKS: TaskConfig[] = [
  {
    id: "focus",
    label: "Focus Detection",
    description: "Analyse JPGs for blur using Laplacian variance. Blurry files get {Out of Focus N} appended to filename.",
    color: "text-orange-400",
  },
  {
    id: "enhance",
    label: "JPG Enhancement",
    description: "CLAHE contrast enhancement + gentle sharpening. Saves as _improved.jpg alongside originals.",
    color: "text-blue-400",
  },
  {
    id: "bw",
    label: "B&W Conversion",
    description: "CLAHE + sharpen in grayscale. Saves as _BW.jpg alongside originals.",
    color: "text-gray-300",
  },
];

export default function PostProcess() {
  const { settings } = useSettings();

  const [queueingTask, setQueueingTask] = useState<ProcessTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function runTask(task: TaskConfig) {
    if (!settings?.staging_dir) {
      setError("Staging directory not configured in Settings.");
      return;
    }

    setQueueingTask(task.id);
    setError(null);
    setMessage(null);

    try {
      const jobId = await invoke<string>("start_process_job", {
        stagingDir: settings.staging_dir,
        task: task.id,
      });
      setMessage(`Queued post-process job: ${jobId}. Track it in Jobs tab.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setQueueingTask(null);
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

      {message && (
        <div className="bg-green-900/40 border border-green-700 rounded-lg px-4 py-3 mb-4 text-green-300 text-sm">
          {message}
        </div>
      )}

      <div className="space-y-4">
        {TASKS.map((task) => {
          const isQueueing = queueingTask === task.id;

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
                  disabled={queueingTask !== null}
                >
                  {isQueueing ? "Queueing..." : "Queue Job"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
