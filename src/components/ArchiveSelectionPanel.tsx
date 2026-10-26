import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ArchivePreferences, ArchivePreview, ArchiveRequest, ArchiveRuleMode, ArchiveVariantKey } from "../types/archiveTransfer";
import { ARCHIVE_PREFERENCES_KEY, ARCHIVE_VARIANTS, archiveBytes, archiveKindLabel, archivePreset, readArchivePreferences } from "../utils/archiveTransfer";

interface Props { stagingDir: string; archiveDir: string; externalBusy: boolean; onBusyChange: (busy: boolean) => void; onQueued: (id: string) => void }
const PAGE_SIZE = 50;
export default function ArchiveSelectionPanel({ stagingDir, archiveDir, externalBusy, onBusyChange, onQueued }: Props) {
  const [preferences, setPreferences] = useState(readArchivePreferences);
  const [scopeMode, setScopeMode] = useState("all");
  const [scopePath, setScopePath] = useState("");
  const [preview, setPreview] = useState<{ signature: string; value: ArchivePreview } | null>(null);
  const [busy, setBusy] = useState<"preview" | "queue" | "folder" | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const pending = useRef(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const request: ArchiveRequest = useMemo(() => ({ ...preferences, stagingDir, archiveDir, scopeDir: scopeMode === "all" ? null : scopePath.trim() }), [preferences, stagingDir, archiveDir, scopeMode, scopePath]);
  const signature = JSON.stringify(request);
  const currentSignature = useRef(signature); currentSignature.current = signature;
  const current = preview?.signature === signature ? preview.value : null;
  const disabled = !!busy || externalBusy;

  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { try { localStorage.setItem(ARCHIVE_PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Preferences are optional; native plans remain authoritative. */ } }, [preferences]);
  useEffect(() => { setPage(0); }, [filter, search, current?.id]);
  function invalidate() { generation.current++; setPreview(null); setError(""); }
  function update(next: ArchivePreferences) { invalidate(); setPreferences(next); }
  function rule(key: ArchiveVariantKey, mode: ArchiveRuleMode, minStars = preferences.rules[key].minStars) { update({ ...preferences, rules: { ...preferences.rules, [key]: { mode, minStars } } }); }
  function flag(key: keyof Omit<ArchivePreferences, "rules">, value: boolean) { update({ ...preferences, [key]: value }); }
  async function chooseFolder() {
    if (pending.current || externalBusy) return;
    pending.current = true; setBusy("folder");
    try {
      const selected = await open({ title: "Choose a staging folder or event to archive", directory: true, multiple: false, defaultPath: scopePath || stagingDir || undefined });
      if (typeof selected === "string" && alive.current) { invalidate(); setScopeMode("folder"); setScopePath(selected); }
    } catch (failure) { if (alive.current) setError(String(failure)); }
    finally { pending.current = false; if (alive.current) setBusy(null); }
  }
  async function createPreview() {
    if (pending.current || externalBusy) return;
    if (!stagingDir || !archiveDir) { setError("Configure Staging and Archive directories in Settings first."); return; }
    if (scopeMode === "folder" && !scopePath.trim()) { setError("Choose or enter a staging folder to preview."); return; }
    const epoch = ++generation.current, requestedSignature = signature;
    pending.current = true; setBusy("preview"); onBusyChange(true); setPreview(null); setError("");
    try {
      const value = await invoke<ArchivePreview>("preview_archive_transfer", { request });
      if (alive.current && epoch === generation.current && currentSignature.current === requestedSignature) { setPreview({ signature: requestedSignature, value }); setFilter("all"); setSearch(""); setPage(0); }
    } catch (failure) { if (alive.current && epoch === generation.current) setError(String(failure)); }
    finally { pending.current = false; if (alive.current) { setBusy(null); onBusyChange(false); } }
  }
  async function queue() {
    if (pending.current || externalBusy || !current?.canStart || !current.summary.includedCount) return;
    pending.current = true; setBusy("queue"); onBusyChange(true); setError("");
    // Preview IDs are single use. Never queue a saved list silently after an error.
    setPreview(null);
    try {
      const id = await invoke<string>("start_transfer", { stagingDir: current.stagingDir, archiveDir: current.archiveDir, previewId: current.id });
      if (alive.current) onQueued(id);
    } catch (failure) { if (alive.current) setError(`${String(failure)} Generate a fresh preview before trying again.`); }
    finally { pending.current = false; if (alive.current) { setBusy(null); onBusyChange(false); } }
  }
  const matching = useMemo(() => (current?.items ?? []).filter(item => (filter === "all" || item.included === (filter === "included")) && `${item.relativePath} ${item.reason} ${archiveKindLabel(item.kind)}`.toLowerCase().includes(search.toLowerCase())), [current, filter, search]);
  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const pageIndex = Math.min(page, pageCount - 1);

  return <section className="space-y-4" aria-label="Archive selection">
    <div className="card space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap"><div><h3 className="text-base font-semibold text-white">Choose what to archive</h3><p className="text-xs text-gray-400 mt-1">Your staged library and its metadata stay in place. These rules only choose what is copied.</p></div><span className="text-xs rounded-full border border-cyan-800 px-3 py-1 text-cyan-200">Copy & verify</span></div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="space-y-1 text-xs text-gray-300"><span>Archive scope</span><select className="input-field w-full" aria-label="Archive scope" value={scopeMode} disabled={disabled} onChange={event => { invalidate(); setScopeMode(event.target.value); }}><option value="all">All staging folders</option><option value="folder">One folder or event, including subfolders</option></select></label>
        <label className="space-y-1 text-xs text-gray-300"><span>Start with a preset</span><select className="input-field w-full" aria-label="Archive preset" value="custom" disabled={disabled} onChange={event => update(archivePreset(event.target.value))}><option value="custom">Choose preset… / custom rules</option><option value="default">All originals + Google-selected versions</option><option value="rated">Rated originals + Google-selected versions</option><option value="originals">Originals only</option><option value="selected">Only Google-selected photos</option><option value="all">All photo versions and videos</option></select></label>
      </div>
      {scopeMode === "folder" && <div className="flex items-end gap-2"><label className="text-xs text-gray-300 flex-1 min-w-0 space-y-1"><span>Folder inside staging</span><input className="input-field w-full" aria-label="Folder inside staging" value={scopePath} placeholder={stagingDir ? `${stagingDir}\\event` : "Choose an event folder"} disabled={disabled} onChange={event => { invalidate(); setScopePath(event.target.value); }} /></label><button type="button" className="btn-secondary" disabled={disabled} onClick={() => void chooseFolder()}>Browse…</button></div>}
      <div className="overflow-x-auto"><table className="w-full text-sm" aria-label="Archive rules by photo version"><thead><tr className="border-b border-surface-600 text-gray-400 text-xs text-left"><th className="pb-2 pr-3 font-medium">Photo version</th><th className="pb-2 pr-3 font-medium">Include</th><th className="pb-2 font-medium">Minimum rating</th></tr></thead><tbody>{ARCHIVE_VARIANTS.map(({ key, label }) => <tr key={key} className="border-b border-surface-700"><th className="py-2 pr-3 text-left font-medium text-gray-200 whitespace-nowrap">{label}</th><td className="py-2 pr-3"><select className="input-field w-full min-w-[10rem] text-xs" aria-label={`${label} archive rule`} value={preferences.rules[key].mode} disabled={disabled} onChange={event => rule(key, event.target.value as ArchiveRuleMode)}><option value="all">All</option><option value="rated">Minimum star rating</option><option value="google_selected">Marked for Google Photos</option><option value="none">None</option></select></td><td className="py-2"><select className="input-field text-xs w-full min-w-[6rem]" aria-label={`${label} minimum rating`} value={preferences.rules[key].minStars} disabled={disabled || preferences.rules[key].mode !== "rated"} onChange={event => rule(key, preferences.rules[key].mode, Number(event.target.value))}><option value={1}>★ or higher</option><option value={2}>★★ or higher</option><option value={3}>★★★ only</option></select></td></tr>)}</tbody></table></div>
      <p className="text-xs text-gray-400">“Marked for Google Photos” uses the local checkbox on that exact Lightbox version; an upload is not required. Ratings follow the Lightbox catalogue, including the original’s rating on its generated versions.</p>
      <div className="grid sm:grid-cols-2 gap-x-5 gap-y-3 text-sm text-gray-200">
        <label className="flex items-start gap-2"><input className="mt-1" type="checkbox" aria-label="Exclude trashed photos and their versions" checked={preferences.excludeTrash} disabled={disabled} onChange={event => flag("excludeTrash", event.target.checked)} /><span>Exclude trashed photos and their versions<small className="block text-xs text-gray-400">Applies across all photo rules.</small></span></label>
        <label className="flex items-start gap-2"><input className="mt-1" type="checkbox" aria-label="Include videos" checked={preferences.includeVideos} disabled={disabled} onChange={event => flag("includeVideos", event.target.checked)} /><span>Include videos<small className="block text-xs text-gray-400">Separate from photo ratings and Google selections.</small></span></label>
        <label className="flex items-start gap-2"><input className="mt-1" type="checkbox" aria-label="Also archive source originals for selected versions" checked={preferences.includeSourceOriginals} disabled={disabled} onChange={event => flag("includeSourceOriginals", event.target.checked)} /><span>Also archive source originals for selected versions<small className="block text-xs text-gray-400">Adds their source originals explicitly; trash exclusion still applies.</small></span></label>
        <label className="flex items-start gap-2"><input className="mt-1" type="checkbox" aria-label="Include camera and user sidecars" checked={preferences.includeCameraSidecars} disabled={disabled} onChange={event => flag("includeCameraSidecars", event.target.checked)} /><span>Include camera and user sidecars<small className="block text-xs text-gray-400">Preserve recognised companion files for chosen media.</small></span></label>
      </div>
      <div className="rounded border border-surface-600 bg-surface-900 px-3 py-3"><label className="flex items-start gap-2 text-sm text-gray-200"><input className="mt-1" type="checkbox" aria-label="Back up PhotoGoGo library metadata" checked={preferences.includeLibraryMetadata} disabled={disabled} onChange={event => flag("includeLibraryMetadata", event.target.checked)} /><span>Back up PhotoGoGo library metadata<small className="block text-xs text-gray-400">Optionally retain supported selections, recipes and library records. Previews, caches and temporary files are always excluded. Archive checksum records are retained for verification.</small></span></label></div>
      {(!preferences.excludeTrash || preferences.rules.originals.mode !== "all") && <p className="text-xs text-amber-200" role="note">{!preferences.excludeTrash ? "Trash exclusion is off. Trashed photos may be included by your rules. " : ""}{preferences.rules.originals.mode !== "all" ? "This is a selective collection, not a complete backup of staging." : ""}</p>}
      <div className="flex items-center gap-3 flex-wrap"><button type="button" className="btn-secondary" disabled={disabled || !stagingDir || !archiveDir} onClick={() => void createPreview()}>{busy === "preview" ? "Scanning archive selection…" : "Preview archive"}</button><span className="text-xs text-gray-400">Rules are remembered on this machine. Changing a rule requires a new preview.</span></div>
    </div>
    {error && <div className="rounded-lg border border-red-700 bg-red-950/30 px-4 py-3 text-sm text-red-200" role="alert">{error}</div>}
    {busy === "queue" && <p role="status" className="text-sm text-cyan-200">Checking the reviewed selection and queueing its transfer…</p>}
    {current && <section className="card space-y-4" aria-label="Archive preview">
      <div className="flex items-start justify-between gap-3 flex-wrap"><div><h3 className="text-base font-semibold text-white">Review archive selection</h3><p className="text-xs text-gray-400 mt-1 break-all">{current.scopeDir}</p></div><button type="button" className="btn-primary" disabled={disabled || !current.canStart || current.summary.includedCount === 0} onClick={() => void queue()}>{busy === "queue" ? "Queueing transfer…" : "Queue reviewed transfer"}</button></div>
      <div className="grid grid-cols-3 gap-2" aria-label="Archive totals"><div className="bg-surface-900 rounded p-3"><span className="text-xs text-gray-400">Included</span><strong className="block text-lg text-cyan-200">{current.summary.includedCount.toLocaleString()}</strong></div><div className="bg-surface-900 rounded p-3"><span className="text-xs text-gray-400">Excluded</span><strong className="block text-lg text-gray-200">{current.summary.excludedCount.toLocaleString()}</strong></div><div className="bg-surface-900 rounded p-3"><span className="text-xs text-gray-400">Selected size</span><strong className="block text-lg text-white">{archiveBytes(current.summary.includedBytes)}</strong></div></div>
      {current.warnings.length > 0 && <div role="alert" className="rounded border border-amber-700/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-100 space-y-1">{current.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      {!current.canStart && <p role="status" className="text-sm text-amber-200">This preview cannot be queued. Resolve its warnings and preview again.</p>}
      {current.summary.includedCount === 0 && <p role="status" className="text-sm text-amber-200">No files match these rules. Adjust the rules and preview again.</p>}
      <div className="overflow-x-auto"><table className="w-full text-xs" aria-label="Archive totals by version"><thead className="text-gray-400 text-left"><tr><th className="pb-2">Version / file type</th><th className="pb-2 text-right">Included</th><th className="pb-2 text-right">Excluded</th><th className="pb-2 text-right">Selected size</th></tr></thead><tbody>{current.summary.groups.map(group => <tr key={group.kind} className="border-t border-surface-700 text-gray-200"><th className="text-left py-2 font-medium">{archiveKindLabel(group.kind)}</th><td className="text-right py-2">{group.includedCount.toLocaleString()}</td><td className="text-right py-2">{group.excludedCount.toLocaleString()}</td><td className="text-right py-2">{archiveBytes(group.includedBytes)}</td></tr>)}</tbody></table></div>
      <div className="flex gap-3 flex-wrap"><label className="text-xs text-gray-300 space-y-1"><span>Show files</span><select className="input-field block" aria-label="Show archive files" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All files</option><option value="included">Included only</option><option value="excluded">Excluded only</option></select></label><label className="text-xs text-gray-300 space-y-1 flex-1 min-w-[10rem]"><span>Find file or reason</span><input className="input-field w-full block" type="search" aria-label="Find archive file or reason" placeholder="Filename, version or exclusion reason" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
      <div className="overflow-x-auto"><table className="w-full text-xs" aria-label="Archive file decisions"><thead className="text-gray-400 text-left"><tr><th className="pb-2 pr-3">Decision / file</th><th className="pb-2 pr-3">Version</th><th className="pb-2">Reason</th><th className="pb-2 text-right pl-3">Size</th></tr></thead><tbody>{matching.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE).map(item => <tr key={item.relativePath} className="border-t border-surface-700 align-top"><td className="py-2 pr-3"><span className={item.included ? "text-cyan-200" : "text-gray-400"}>{item.included ? "Include" : "Exclude"}</span><span className="block text-gray-200 break-all min-w-[10rem]">{item.relativePath}</span></td><td className="py-2 pr-3 text-gray-300">{archiveKindLabel(item.kind)}</td><td className="py-2 text-gray-300 min-w-[9rem]">{item.reason}</td><td className="py-2 text-right text-gray-400 whitespace-nowrap pl-3">{archiveBytes(item.bytes)}</td></tr>)}</tbody></table>{matching.length === 0 && <p className="text-sm text-gray-400 py-3" role="status">No files match this view.</p>}</div>
      <div className="flex items-center justify-between gap-2 text-xs text-gray-400"><span>{matching.length.toLocaleString()} matching files · Page {pageIndex + 1} of {pageCount}</span><div className="flex gap-2"><button type="button" className="btn-secondary" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>Previous files</button><button type="button" className="btn-secondary" disabled={pageIndex + 1 >= pageCount} onClick={() => setPage(pageIndex + 1)}>Next files</button></div></div>
      <p className="text-xs text-gray-400">The transfer copies this reviewed selection using the existing checksum and duplicate-handling workflow. It never removes existing archive files. A changed library requires a fresh preview.</p>
    </section>}
  </section>;
}
