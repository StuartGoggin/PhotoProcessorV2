import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ImportOptions } from "../types";
import { useSettings } from "../hooks";

export default function Cleanup() {
  const { settings } = useSettings();
  const [starting, setStarting] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [trashMoved, setTrashMoved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function queueReprocess() {
    const staging = settings?.staging_dir || "";
    if (!staging) {
      setError("Please configure Staging Directory in Settings first.");
      return;
    }

    setStarting(true);
    setError(null);
    setMessage(null);

    try {
      const options: ImportOptions = { reprocessExisting: true };
      const jobId = await invoke<string>("start_import_job", {
        sourceDir: staging,
        stagingDir: staging,
        options,
      });
      void invoke<boolean>("start_import_prewarm_worker", {
        stagingDir: staging,
        previewMaxWidth: Math.max(120, settings?.timeline_preview_width ?? 420),
        previewMaxHeight: Math.max(68, settings?.timeline_preview_height ?? 240),
        previewFps: Math.max(2, Math.min(30, settings?.timeline_preview_fps ?? 8)),
      }).catch(() => {
      });
      void invoke<boolean>("start_preview_monitor_worker", {
        stagingDir: staging,
        maxWidth: Math.max(120, settings?.timeline_preview_width ?? 420),
        maxHeight: Math.max(68, settings?.timeline_preview_height ?? 240),
        previewFps: Math.max(2, Math.min(30, settings?.timeline_preview_fps ?? 8)),
      }).catch(() => {
      });
      setMessage(`Queued cleanup job: ${jobId}. Track it in Jobs tab.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  async function collectTrash() {
    const staging = settings?.staging_dir || "";
    if (!staging) {
      setError("Please configure Staging Directory in Settings first.");
      return;
    }

    setCollecting(true);
    setError(null);
    setMessage(null);
    setTrashMoved(null);

    try {
      const count = await invoke<number>("collect_trash", {
        stagingDir: staging,
      });
      setTrashMoved(count);
      setMessage(`Moved ${count} file${count !== 1 ? "s" : ""} to Trash.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setCollecting(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Cleanup</h2>
      <p className="text-gray-400 text-sm mb-6">
        Maintenance operations for already imported staging files.
      </p>

      <div className="card mb-6 space-y-3">
        <h3 className="text-white font-medium">Reprocess Staging Tree</h3>
        <p className="text-xs text-gray-400">
          Re-check existing files in staging, correct naming/timestamps, and ensure `.md5` sidecars exist.
        </p>
        <div className="text-xs text-gray-400 break-all">
          <span className="text-gray-500">Staging:</span> {settings?.staging_dir || "(not set)"}
        </div>
        <button className="btn-primary" onClick={queueReprocess} disabled={starting}>
          {starting ? "Queueing..." : "Queue Reprocess Job"}
        </button>
      </div>

      <div className="card mb-6 space-y-3">
        <h3 className="text-white font-medium">Collect Trash</h3>
        <p className="text-xs text-gray-400">
          Move files marked with <code className="bg-surface-700 px-1 rounded">{"{trash}"}</code> to <code className="bg-surface-700 px-1 rounded">Trash/</code> under staging.
        </p>
        <button className="btn-danger" onClick={collectTrash} disabled={collecting}>
          {collecting ? "Collecting..." : "Collect Trash"}
        </button>
        {trashMoved !== null && (
          <p className="text-xs text-gray-400">
            Last run moved {trashMoved} file{trashMoved !== 1 ? "s" : ""}.
          </p>
        )}
      </div>

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
    </div>
  );
}
