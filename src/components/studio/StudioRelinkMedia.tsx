import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type { StudioProject } from "../../types/videoStudio";

interface Plan {
  project: StudioProject;
  changes: { label: string; from: string; to: string }[];
  errors: string[];
  warnings: string[];
  verifiedRenders: number;
  elapsedSeconds: number;
}
export default function StudioRelinkMedia({ project, getStagingDir, onApply }: {
  project: StudioProject;
  getStagingDir: () => Promise<string>;
  onApply: (next: StudioProject, expected: string) => boolean;
}) {
  const [oldStaging, setOldStaging] = useState("");
  const [output, setOutput] = useState(project.outputDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [checked, setChecked] = useState<{ plan: Plan; snapshot: string; inputs: string } | null>(null);
  const [undo, setUndo] = useState<{ before: StudioProject; after: string } | null>(null);
  const latest = useRef(project); latest.current = project;
  const inputs = JSON.stringify([oldStaging, output]);
  const latestInputs = useRef(inputs); latestInputs.current = inputs;
  const snapshot = JSON.stringify(project);
  const stale = !!checked && (checked.snapshot !== snapshot || checked.inputs !== inputs);
  async function check() {
    setBusy(true); setError(""); setMessage(""); setChecked(null);
    const original = latest.current;
    try {
      const stagingDir = await getStagingDir();
      const plan = await invoke<Plan>("studio_relink_media", { project: original, stagingDir, oldStagingDir: oldStaging.trim(), outputDir: output.trim() });
      setChecked({ plan, snapshot: JSON.stringify(original), inputs });
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function apply() {
    if (!checked || stale || checked.plan.errors.length) return;
    const prior = JSON.parse(checked.snapshot) as StudioProject;
    if (!await confirm(`Apply ${checked.plan.changes.length} path changes to the open project? ${checked.plan.verifiedRenders} render(s) verified for reuse. Other renders remain available for playback but are not marked ready. No media will be moved and no saved project file will be overwritten.`, { title: "Apply verified media locations" })) return;
    if (latestInputs.current !== checked.inputs) { setError("Folder choices changed. Check media locations again before applying."); return; }
    if (!onApply(checked.plan.project, checked.snapshot)) { setError("Project changed while checking. Check locations again before applying."); return; }
    setUndo({ before: prior, after: JSON.stringify(checked.plan.project) });
    setChecked(null); setMessage("Media locations applied to this working project. Save a new snapshot to keep them. Media and earlier snapshots are unchanged.");
  }
  return <details open className="studio-relink bg-surface-800 rounded-xl p-4">
    <summary className="font-semibold cursor-pointer">Relink media · moved project or missing files</summary>
    <p className="text-sm text-gray-400 my-2">Restore folder locations after changing machines or drive letters. Checks read the full source files and verify existing renders; large projects can take several minutes. Nothing is moved, deleted or rendered.</p>
    <div className="grid gap-3 md:grid-cols-2">
      <label className="text-sm">Original staging folder<input className="input w-full" aria-label="Original staging folder" placeholder="E:\stage (blank to check current paths)" value={oldStaging} disabled={busy} onChange={(e) => setOldStaging(e.target.value)} /><span className="text-xs text-gray-400">Mapped into the current Local Staging Directory in Settings. Only descendants of this folder change.</span></label>
      <label className="text-sm">New output folder<div className="flex gap-2"><input className="input w-full" aria-label="Relink output folder" value={output} disabled={busy} onChange={(e) => setOutput(e.target.value)} /><button className="btn-secondary" disabled={busy} onClick={() => void (async () => { try { const folder = await open({ directory:true }); if (typeof folder === "string") setOutput(folder); } catch(e) { setError(String(e)); } })()}>Browse</button></div><span className="text-xs text-gray-400">Rendered clips and music under the old output folder follow this mapping. External music locations are left unchanged.</span></label>
    </div>
    <div className="flex gap-2 flex-wrap mt-3"><button className="btn-secondary" disabled={busy || !output.trim()} onClick={() => void check()}>{busy ? "Checking locations & content…" : "Check media locations"}</button>
      {checked && <button className="btn-primary" disabled={busy || stale || checked.plan.errors.length > 0} onClick={() => void apply()}>Apply checked locations</button>}
      {undo && <button className="btn-secondary" disabled={snapshot !== undo.after} onClick={() => { if (onApply(undo.before, undo.after)) { setUndo(null); setMessage("Previous project locations restored. No files were changed."); } }}>Undo relink</button>}
    </div>
    {error && <p role="alert" className="text-red-400 mt-2">{error}</p>}
    {message && <p role="status" className="text-green-400 mt-2">{message}</p>}
    {checked && <div className="mt-3 text-sm space-y-2">
      <p role="status">{checked.plan.changes.length} path changes · {checked.plan.verifiedRenders} verified reusable renders · checked in {checked.plan.elapsedSeconds.toFixed(1)}s</p>
      {stale && <p role="alert" className="text-amber-300">Project or folder choices changed. Check media locations again.</p>}
      {checked.plan.errors.length > 0 && <div role="alert" className="text-red-400"><p>Resolve these locations before applying:</p><ul className="list-disc ml-5 max-h-40 overflow-auto">{checked.plan.errors.map((e,i) => <li key={i}>{e}</li>)}</ul></div>}
      {checked.plan.warnings.length > 0 && <details><summary>{checked.plan.warnings.length} warnings / renders not verified</summary><ul className="list-disc ml-5 max-h-48 overflow-auto">{checked.plan.warnings.map((w,i) => <li key={i}>{w}</li>)}</ul></details>}
      <details><summary>Review exact path changes</summary><ul className="space-y-2 max-h-64 overflow-auto">{checked.plan.changes.map((c,i) => <li className="break-all" key={i}><strong>{c.label}</strong><br />{c.from}<br />→ {c.to}</li>)}</ul></details>
    </div>}
  </details>;
}
