import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../hooks";

export default function TidyUp() {
  const { settings } = useSettings();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function collectTrash() {
    if (!settings?.staging_dir) {
      setError("Staging directory not configured.");
      return;
    }

    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const count = await invoke<number>("collect_trash", {
        stagingDir: settings.staging_dir,
      });
      setResult(count);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Tidy Up</h2>
      <p className="text-gray-400 text-sm mb-6">
        Move files marked with <code className="bg-surface-700 px-1 rounded">{"{trash}"}</code> to a{" "}
        <code className="bg-surface-700 px-1 rounded">Trash/</code> subdirectory in staging.
      </p>

      {settings?.staging_dir && (
        <div className="card mb-6 text-sm">
          <span className="text-gray-400">Staging: </span>
          <span className="text-gray-200">{settings.staging_dir}</span>
        </div>
      )}

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 mb-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {result !== null && (
        <div className="card mb-6">
          <p className="text-green-400 font-medium">
            ✓ Moved {result} file{result !== 1 ? "s" : ""} to Trash/
          </p>
          {result === 0 && (
            <p className="text-gray-400 text-sm mt-1">No files were marked for trash.</p>
          )}
        </div>
      )}

      <button className="btn-danger" onClick={collectTrash} disabled={running}>
        {running ? "Collecting..." : "Collect Trash"}
      </button>
    </div>
  );
}
