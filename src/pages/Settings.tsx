import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Settings } from "../types";

type PathSettingKey = "source_root" | "staging_dir" | "archive_dir";

const FIELDS: { key: PathSettingKey; label: string; help: string }[] = [
  {
    key: "source_root",
    label: "Source Root (SD Card)",
    help: "Root mount point of your SD card or camera",
  },
  {
    key: "staging_dir",
    label: "Local Staging Directory",
    help: "Where imported photos are copied and processed",
  },
  {
    key: "archive_dir",
    label: "Archive / NAS Directory",
    help: "Final destination for transfer (NAS or external drive)",
  },
];

function parseNonNegativeInt(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    source_root: "",
    staging_dir: "",
    archive_dir: "",
    stabilize_max_parallel_jobs: 0,
    stabilize_ffmpeg_threads_per_job: 0,
    face_scan_parallel_jobs: 0,
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Settings>("load_settings")
      .then((loaded) =>
        setSettings({
          source_root: loaded.source_root ?? "",
          staging_dir: loaded.staging_dir ?? "",
          archive_dir: loaded.archive_dir ?? "",
          stabilize_max_parallel_jobs: loaded.stabilize_max_parallel_jobs ?? 0,
          stabilize_ffmpeg_threads_per_job: loaded.stabilize_ffmpeg_threads_per_job ?? 0,
          face_scan_parallel_jobs: loaded.face_scan_parallel_jobs ?? 0,
        })
      )
      .catch((e) => setError(String(e)));
  }, []);

  async function pickDir(field: PathSettingKey) {
    setError(null);

    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        setSettings((s) => ({ ...s, [field]: selected }));
      }
    } catch (e) {
      setError(`Failed to open folder picker: ${String(e)}`);
    }
  }

  async function save() {
    setError(null);
    await invoke("save_settings", { settings });

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-6">Settings</h2>

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 mb-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {FIELDS.map(({ key, label, help }) => (
          <div key={key} className="card">
            <label className="block text-sm font-medium text-gray-300 mb-1">{label}</label>
            <p className="text-xs text-gray-500 mb-2">{help}</p>
            <div className="flex gap-2">
              <input
                type="text"
                className="input-field flex-1"
                value={settings[key]}
                onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value }))}
                placeholder="Click Browse or enter path..."
              />
              <button className="btn-secondary whitespace-nowrap" onClick={() => pickDir(key)}>
                Browse...
              </button>
            </div>
          </div>
        ))}

        <div className="card space-y-4">
          <div>
            <h3 className="text-sm font-medium text-white">Video Stabilization Load Management</h3>
            <p className="text-xs text-gray-500 mt-1">
              Control CPU and memory pressure for stabilization jobs. Set either value to <strong>0</strong> to use automatic tuning.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm text-gray-300">Max Parallel Stabilize Jobs</span>
              <input
                type="number"
                min={0}
                step={1}
                className="input-field mt-1"
                value={settings.stabilize_max_parallel_jobs}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    stabilize_max_parallel_jobs: parseNonNegativeInt(e.target.value),
                  }))
                }
              />
              <span className="text-xs text-gray-500">0 = Auto. Typical safe values: 1-2.</span>
            </label>

            <label className="block">
              <span className="text-sm text-gray-300">FFmpeg Threads Per Stabilize Job</span>
              <input
                type="number"
                min={0}
                step={1}
                className="input-field mt-1"
                value={settings.stabilize_ffmpeg_threads_per_job}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    stabilize_ffmpeg_threads_per_job: parseNonNegativeInt(e.target.value),
                  }))
                }
              />
              <span className="text-xs text-gray-500">0 = Auto. Typical safe values: 2-6.</span>
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              className="btn-secondary text-xs"
              onClick={() =>
                setSettings((s) => ({
                  ...s,
                  stabilize_max_parallel_jobs: 0,
                  stabilize_ffmpeg_threads_per_job: 0,
                }))
              }
            >
              Auto (Recommended)
            </button>
            <button
              className="btn-secondary text-xs"
              onClick={() =>
                setSettings((s) => ({
                  ...s,
                  stabilize_max_parallel_jobs: 1,
                  stabilize_ffmpeg_threads_per_job: 2,
                }))
              }
            >
              Low Load
            </button>
            <button
              className="btn-secondary text-xs"
              onClick={() =>
                setSettings((s) => ({
                  ...s,
                  stabilize_max_parallel_jobs: 2,
                  stabilize_ffmpeg_threads_per_job: 3,
                }))
              }
            >
              Balanced
            </button>
          </div>
        </div>

        <div className="card space-y-4">
          <div>
            <h3 className="text-sm font-medium text-white">Face Scan Performance</h3>
            <p className="text-xs text-gray-500 mt-1">
              Number of videos to scan in parallel. Higher values can be much faster but use more RAM and CPU.
            </p>
          </div>

          <label className="block max-w-xs">
            <span className="text-sm text-gray-300">Parallel Face Scan Workers</span>
            <input
              type="number"
              min={0}
              step={1}
              className="input-field mt-1"
              value={settings.face_scan_parallel_jobs}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  face_scan_parallel_jobs: parseNonNegativeInt(e.target.value),
                }))
              }
            />
            <span className="text-xs text-gray-500">0 = Auto. Typical values: 2-4.</span>
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              className="btn-secondary text-xs"
              onClick={() =>
                setSettings((s) => ({
                  ...s,
                  face_scan_parallel_jobs: 0,
                }))
              }
            >
              Auto (Recommended)
            </button>
            <button
              className="btn-secondary text-xs"
              onClick={() =>
                setSettings((s) => ({
                  ...s,
                  face_scan_parallel_jobs: 2,
                }))
              }
            >
              Conservative
            </button>
            <button
              className="btn-secondary text-xs"
              onClick={() =>
                setSettings((s) => ({
                  ...s,
                  face_scan_parallel_jobs: 4,
                }))
              }
            >
              Fast
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button className="btn-primary" onClick={save}>
          Save Settings
        </button>
        {saved && <span className="text-green-400 text-sm">✓ Saved</span>}
      </div>
    </div>
  );
}
