import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Settings } from "../types";

const FIELDS: { key: keyof Settings; label: string; help: string }[] = [
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

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    source_root: "",
    staging_dir: "",
    archive_dir: "",
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<Settings>("load_settings").then(setSettings).catch(console.error);
  }, []);

  async function pickDir(field: keyof Settings) {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setSettings((s) => ({ ...s, [field]: selected }));
    }
  }

  async function save() {
    await invoke("save_settings", { settings });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-6">Settings</h2>

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
