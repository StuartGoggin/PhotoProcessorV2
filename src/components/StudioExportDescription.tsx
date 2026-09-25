import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StudioJob, StudioProject } from "../types/videoStudio";
import { clipName } from "../types/videoStudio";
import { sequenceClipCount, sequenceStatus } from "../utils/studioWorkflow";

interface ExportDescription {
  text: string;
  path: string;
  chapters: { startSeconds: number; title: string }[];
  warnings: string[];
}
interface Draft extends ExportDescription { savedText: string }

export default function StudioExportDescription({ jobs, project }: { jobs: StudioJob[]; project?: StudioProject }) {
  const exports = jobs.filter((job) => job.status === "completed" && job.output && ["project", "assembly"].includes(job.kind || ""))
    .sort((a, b) => (b.finishedAt || b.createdAt || b.id).localeCompare(a.finishedAt || a.createdAt || a.id));
  const [selected, setSelected] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const related = project ? exports.filter((job) => job.targets?.some((t) => project.clips.some((c) => c.id === t.clipId && c.path === t.sourcePath))) : exports;
  // An older snapshot may finish last. Prefer a match, not completion time alone.
  const latest = (project && related.find((job) => sequenceStatus(job, project) === "current")) || related[0];
  const firstExport = latest?.id || exports[0]?.id || "";
  useEffect(() => { if (!selected && firstExport) setSelected(firstExport); }, [selected, firstExport]);
  const draft = drafts[selected];
  const selectedExport = exports.find((job) => job.id === selected);
  const freshness = selectedExport && project ? sequenceStatus(selectedExport, project) : "unknown";
  const countLabel = (job: StudioJob) => sequenceClipCount(job) == null ? "clip count unknown" : `${sequenceClipCount(job)} clips`;
  const statusLabel = (job: StudioJob) => !project ? "" : sequenceStatus(job, project) === "current" ? "Matches current edit" : sequenceStatus(job, project) === "outdated" ? "Different from current edit" : "Older export · match unverified";
  useEffect(() => {
    if (!selected || draft) { setLoading(false); return; }
    let alive = true;
    setLoading(true); setError(""); setNotice("");
    void invoke<ExportDescription>("studio_read_export_description", { jobId: selected }).then((value) => {
      if (alive) setDrafts((previous) => ({ ...previous, [selected]: { ...value, savedText: value.text } }));
    }).catch((e) => { if (alive) setError(String(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  // Job polling must not reload a description or overwrite an edited draft.
  }, [selected, !!draft, attempt]);
  async function copy() {
    if (!draft) return;
    setError(""); setNotice("");
    try { await navigator.clipboard.writeText(draft.text); setNotice("Description copied. Paste it into your YouTube description."); }
    catch (e) { setError(`Could not copy the description. Select the text and copy manually. ${String(e)}`); }
  }
  async function save() {
    if (!draft) return;
    const jobId = selected, text = draft.text;
    setWorking(true); setError(""); setNotice("");
    try {
      const path = await invoke<string>("studio_save_export_description", { jobId, text });
      setDrafts((previous) => ({ ...previous, [jobId]: { ...previous[jobId], path, savedText: text } }));
      setNotice("Description saved alongside the selected video.");
    } catch (e) { setError(`Description was not saved: ${String(e)}`); }
    finally { setWorking(false); }
  }
  return <section className="studio-delivery rounded-xl bg-surface-800 p-4 space-y-3" aria-labelledby="studio-description-heading">
    <div><p className="text-xs uppercase tracking-widest text-cyan-300 mb-1">Delivery notes</p>
      <h2 id="studio-description-heading" className="text-lg font-semibold">YouTube description & chapters</h2></div>
    <p className="text-sm text-gray-400">Generated from the selected finished export, including its final order, title card and replays. Later project edits do not change these timings.</p>
    {!exports.length && !draft ? <p className="text-sm text-gray-300">Complete a video to generate its segment names and chapter timestamps here. No YouTube account or upload is needed.</p> : <>
      <label className="block text-sm">Finished export
        <select className="block mt-1 w-full bg-surface-900 rounded border border-surface-600 px-3 py-2" value={selected} disabled={working}
          onChange={(e) => { setSelected(e.target.value); setError(""); setNotice(""); }}>
          {selected && !selectedExport && <option value={selected}>Previous export · no longer in history</option>}
          {exports.map((job) => <option value={job.id} key={job.id}>{job.name} · {countLabel(job)} · {statusLabel(job)} · {clipName(job.output!)} · {job.finishedAt || job.createdAt || job.id}</option>)}
        </select>
      </label>
      {selectedExport && project && <p role="status" aria-label="Export sequence status" className={`text-sm ${freshness === "current" ? "text-emerald-300" : "text-amber-200"}`}>
        Selected export: {countLabel(selectedExport)}. {freshness === "current" ? "Matches the current edit recipe." : freshness === "outdated" ? `This export differs from your current ${project.clips.filter((c) => c.include).length}-clip sequence. Create an updated final video to include your changes.` : "This older export has no complete sequence record; its match to the current edit is unverified."} Earlier videos are never changed by project edits.
      </p>}
      {latest && latest.id !== selected && <div className="space-y-2">
        <p className="text-sm text-cyan-200">{project && sequenceStatus(latest, project) === "current" ? "Latest export matching your current edit" : "Latest saved export; a match to the current edit is not confirmed"}: {countLabel(latest)}. Your description draft will be kept.</p>
        <button className="btn-secondary" disabled={working} onClick={() => {
          setSelected(latest.id); setError(""); setNotice("");
          void invoke("open_in_default_app", { path: latest.output }).catch((e) => setError(`Could not open the latest video: ${String(e)}`));
        }}>Open latest export</button>
      </div>}
      <p className="text-xs text-gray-400 break-all">{selectedExport?.output || "This export is no longer in job history. Your draft is retained until you leave Studio."}</p>
      {loading && <p role="status">Loading saved description…</p>}
      {draft && <>
        <label className="block text-sm" htmlFor="studio-description">Description <span className="text-gray-400">· {draft.text !== draft.savedText ? "Unsaved changes" : "Saved"}</span></label>
        <textarea id="studio-description" className="w-full min-h-[240px] rounded-lg bg-surface-900 border border-surface-600 p-3 font-mono text-sm"
          maxLength={20000} value={draft.text} onChange={(e) => setDrafts((previous) => ({ ...previous, [selected]: { ...previous[selected], text: e.target.value } }))} />
        <p className={`text-xs ${Array.from(draft.text).length > 5000 ? "text-amber-200" : "text-gray-400"}`}>{Array.from(draft.text).length.toLocaleString()} / 5,000 YouTube description characters. Save accepts up to 20 KB of UTF-8 text.</p>
        {!!draft.warnings.length && <div className="text-sm text-amber-200" aria-label="Generated chapter guidance">
          {draft.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        </div>}
        <p className="text-xs text-gray-400">YouTube chapters need a 00:00 start, at least 3 timestamps and chapters of at least 10 seconds. Manual text edits are not revalidated and never change your video.</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => void copy()}>Copy description</button>
          <button className="btn-primary" disabled={working || !selectedExport} onClick={() => void save()}>{working ? "Saving…" : "Save alongside video"}</button>
        </div>
        <p className="text-xs text-gray-400 break-all">{draft.path}</p>
      </>}
    </>}
    {error && <div role="alert" className="text-sm text-red-300 break-words"><p>{error}</p>{!draft && <button className="btn-secondary mt-2" onClick={() => setAttempt((value) => value + 1)}>Retry description</button>}</div>}
    {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
  </section>;
}
