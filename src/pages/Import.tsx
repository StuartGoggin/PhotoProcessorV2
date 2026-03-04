import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings, ImportProgress, ImportResult } from "../types";
import ProgressBar from "../components/ProgressBar";

export default function Import() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    invoke<Settings>("load_settings").then(setSettings).catch(console.error);
    return () => {
      unlistenRef.current?.();
    };
  }, []);

  async function startImport() {
    if (!settings?.source_root || !settings?.staging_dir) {
      setError("Please configure Source Root and Staging Directory in Settings first.");
      return;
    }

    setRunning(true);
    setResult(null);
    setError(null);
    setProgress(null);

    // Subscribe to progress events
    const unlisten = await listen<ImportProgress>("import-progress", (event) => {
      setProgress(event.payload);
    });
    unlistenRef.current = unlisten;

    try {
      const res = await invoke<ImportResult>("start_import", {
        sourceDir: settings.source_root,
        stagingDir: settings.staging_dir,
      });
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      unlistenRef.current = null;
      setRunning(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Import Photos</h2>
      <p className="text-gray-400 text-sm mb-6">
        Copy photos from SD card to local staging directory, renamed by EXIF date.
      </p>

      {settings && (
        <div className="card mb-6 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Source:</span>
            <span className="text-gray-200 truncate max-w-xs">
              {settings.source_root || <span className="text-red-400">Not set</span>}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Staging:</span>
            <span className="text-gray-200 truncate max-w-xs">
              {settings.staging_dir || <span className="text-red-400">Not set</span>}
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 mb-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {running && progress && (
        <div className="card mb-6 space-y-3">
          <ProgressBar
            total={progress.total}
            done={progress.done}
            label={progress.current_file}
            extra={`${progress.done}/${progress.total} files • ${progress.speed_mbps.toFixed(1)} MB/s`}
          />
          {progress.skipped > 0 && (
            <p className="text-xs text-yellow-400">Skipped (duplicate): {progress.skipped}</p>
          )}
        </div>
      )}

      {result && !running && (
        <div className="card mb-6">
          <h3 className="text-green-400 font-medium mb-2">✓ Import Complete</h3>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Imported:</span>
              <span className="text-white">{result.imported} files</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Skipped:</span>
              <span className="text-white">{result.skipped} files</span>
            </div>
            {result.errors.length > 0 && (
              <div className="mt-2">
                <p className="text-red-400 text-xs font-medium">Errors ({result.errors.length}):</p>
                <div className="max-h-32 overflow-y-auto mt-1 space-y-0.5">
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-xs text-red-300">{e}</p>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <button
        className="btn-primary"
        onClick={startImport}
        disabled={running}
      >
        {running ? "Importing..." : "Start Import"}
      </button>
    </div>
  );
}
