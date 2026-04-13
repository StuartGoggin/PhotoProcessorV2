import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ImportOptions, SourceShortcut } from "../types";
import { useSettings } from "../hooks";

export default function Import() {
  const { settings } = useSettings();

  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sourceOverride, setSourceOverride] = useState("");
  const [shortcuts, setShortcuts] = useState<SourceShortcut[]>([]);
  const [loadingShortcuts, setLoadingShortcuts] = useState(false);

  async function loadShortcuts() {
    setLoadingShortcuts(true);
    try {
      const data = await invoke<SourceShortcut[]>("list_sd_cards");
      setShortcuts(data);
    } catch {
      setShortcuts([]);
    } finally {
      setLoadingShortcuts(false);
    }
  }

  useEffect(() => {
    loadShortcuts();
  }, []);

  async function browseSource() {
    setError(null);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        setSourceOverride(selected);
      }
    } catch (e) {
      setError(`Failed to open source picker: ${String(e)}`);
    }
  }

  async function startImport() {
    const source = sourceOverride.trim() || settings?.source_root || "";
    const staging = settings?.staging_dir || "";

    if (!source || !staging) {
      setError("Please configure Source Root and Staging Directory in Settings first.");
      return;
    }

    setStarting(true);
    setError(null);
    setMessage(null);

    try {
      const options: ImportOptions = { reprocessExisting: false };
      const jobId = await invoke<string>("start_import_job", {
        sourceDir: source,
        stagingDir: staging,
        options,
      });
      void invoke<boolean>("start_import_prewarm_worker", { stagingDir: staging }).catch(() => {
      });
      setMessage(`Queued background job: ${jobId}. Track it in Jobs tab.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
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
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">Detected SD Cards</span>
              <button
                type="button"
                className="btn-secondary px-2 py-1 text-xs"
                onClick={loadShortcuts}
                disabled={starting || loadingShortcuts}
              >
                {loadingShortcuts ? "Scanning..." : "Rescan"}
              </button>
            </div>
            {shortcuts.length === 0 ? (
              <p className="text-xs text-gray-500">No removable drives found. Use Browse or manual path.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {shortcuts.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className="text-left bg-surface-700 hover:bg-surface-600 border border-surface-500 rounded-lg p-3 transition-colors"
                    onClick={() => setSourceOverride(item.path)}
                    disabled={starting}
                  >
                    <div className="text-sm text-white font-medium truncate">💾 {item.label}</div>
                    <div className="text-xs text-gray-400 truncate mt-1">{item.path}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Source:</span>
            <span className="text-gray-200 truncate max-w-xs">
              {settings.source_root || <span className="text-red-400">Not set</span>}
            </span>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-gray-500">Source override (optional; enables multiple sources)</label>
            <div className="flex gap-2">
              <input
                type="text"
                className="input-field w-full"
                value={sourceOverride}
                onChange={(e) => setSourceOverride(e.target.value)}
                placeholder="Leave empty to use Source from Settings"
                disabled={starting}
              />
              <button
                type="button"
                className="btn-secondary whitespace-nowrap"
                onClick={browseSource}
                disabled={starting}
              >
                Browse...
              </button>
            </div>
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

      {message && (
        <div className="bg-green-900/40 border border-green-700 rounded-lg px-4 py-3 mb-4 text-green-300 text-sm">
          {message}
        </div>
      )}

      <button className="btn-primary" onClick={startImport} disabled={starting}>
        {starting ? "Queueing..." : "Queue Import Job"}
      </button>
    </div>
  );
}
