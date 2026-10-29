import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProcessScopeMode } from "../types";
import type { RawCandidates, RawHistogram, RawPreviewResult, RawRecipe, RawRecipeRecord, RawScope, RawSelection } from "../types/rawDevelopment";
import { loadRawDefaults, normalizeRawRecipe, rawPreset, saveRawDefaults } from "../utils/rawRecipe";

interface Props { stagingDir: string; scopeDir: string; scopeMode: ProcessScopeMode; onOpenJobs?: () => void; onNamingBlockChange?: (reason: string | null) => void; refreshKey?: number }
type DisplayPreview = RawPreviewResult & { urls: string[]; previewVariant: "colour" | "bw" };
let previewLane: Promise<void> = Promise.resolve();
const name = (path: string) => path.split(/[\\/]/).pop() || path;
const AUTO_LEVEL_KEYS: Array<keyof RawRecipe> = ["exposure", "blackPoint", "contrast", "highlights"];
const sliders: Array<{ key: keyof RawRecipe; label: string; min: number; max: number; step?: number; hint: string }> = [
  { key: "exposure", label: "Exposure (EV)", min: -3, max: 3, step: .05, hint: "0 preserves recorded exposure" },
  { key: "highlights", label: "Highlight recovery", min: 0, max: 100, hint: "Cannot recover detail never recorded" },
  { key: "shadows", label: "Shadow lift", min: 0, max: 100, hint: "Lift gently to avoid exposing noise" },
  { key: "blackPoint", label: "Black point", min: -100, max: 100, hint: "Retain detail in dark coats" },
  { key: "contrast", label: "Contrast", min: -100, max: 100, hint: "0 is the neutral adjustment" },
  { key: "saturation", label: "Saturation", min: -100, max: 100, hint: "Colour output only" },
  { key: "curveStrength", label: "Gentle tonal S-curve", min: 0, max: 1, step: .05, hint: "0 turns the curve off" },
  { key: "sharpening", label: "Detail sharpening", min: 0, max: 100, hint: "Use 100% to judge edges and bokeh" },
  { key: "luminanceNoise", label: "Luminance noise reduction", min: 0, max: 100, hint: "Stronger values can soften mane and fur" },
  { key: "chromaNoise", label: "Colour noise reduction", min: 0, max: 100, hint: "Reduces coloured noise speckles" },
];

function imageBlob(data: string | null | undefined, urls: string[]): string | undefined {
  if (!data) return undefined;
  if (data.length > 48 * 1024 * 1024) throw new Error("Preview response exceeds the display limit. Use a smaller draft.");
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(data);
  if (!match) throw new Error("The RAW worker returned an unsupported preview image.");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: match[1] }));
  urls.push(url); return url;
}

function Histogram({ data }: { data: RawHistogram }) {
  const channels = [data.red, data.green, data.blue];
  if (channels.some((values) => !Array.isArray(values) || values.length !== 256 || values.some((value) => !Number.isFinite(value) || value < 0))) return null;
  const maximum = Math.max(1, ...channels.flat());
  return <div className="rounded border border-surface-600 p-2" aria-label="Development histogram">
    <svg viewBox="0 0 255 60" className="w-full h-16 bg-black/30" role="img" aria-label="Red, green and blue tonal distribution">
      {channels.map((values, index) => <polyline key={index} fill="none" stroke={["#f87171", "#4ade80", "#60a5fa"][index]} strokeWidth="1" points={values.map((value, x) => `${x},${59 - value / maximum * 57}`).join(" ")} />)}
    </svg>
    <p className="text-xs text-gray-400 mt-1">Preview clipping · shadows {Number.isFinite(data.shadowPercent) ? data.shadowPercent.toFixed(2) : "—"}% · highlights {Number.isFinite(data.highlightPercent) ? data.highlightPercent.toFixed(2) : "—"}%</p>
  </div>;
}

/** RAW controls remain separate from legacy JPEG jobs and share the core Jobs queue. */
export default function RawDevelopment({ stagingDir, scopeDir, scopeMode, onOpenJobs, onNamingBlockChange, refreshKey = 0 }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [defaults, setDefaults] = useState(loadRawDefaults);
  const [photoRecipe, setPhotoRecipe] = useState<RawRecipe>(defaults);
  const [savedPhotoRecipe, setSavedPhotoRecipe] = useState<RawRecipe | null>(null);
  const [lastAppliedRecipe, setLastAppliedRecipe] = useState<RawRecipe | null>(null);
  const [editingPhoto, setEditingPhoto] = useState(false);
  const [usePhotoOverrides, setUsePhotoOverrides] = useState(true);
  const [selection, setSelection] = useState<RawSelection>("nonTrash");
  const [minRating, setMinRating] = useState(1);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<RawCandidates | null>(null);
  const [candidateRevision, setCandidateRevision] = useState(0);
  const [path, setPath] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingRecipe, setLoadingRecipe] = useState(false);
  const [recipeLoaded, setRecipeLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<DisplayPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewPendingCount, setPreviewPendingCount] = useState(0);
  const [previewVariant, setPreviewVariant] = useState<"colour" | "bw">("colour");
  const [actualPixels, setActualPixels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const candidateGeneration = useRef(0);
  const recipeGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const previewRef = useRef<DisplayPreview | null>(null);
  const alive = useRef(true);
  const sourceScroll = useRef<HTMLDivElement>(null);
  const resultScroll = useRef<HTMLDivElement>(null);
  const scopeKey = JSON.stringify([stagingDir, scopeDir, scopeMode]);
  const recipe = editingPhoto ? photoRecipe : defaults;
  const recipeKey = JSON.stringify(recipe);
  const automaticLevels=recipe.autoExposure||recipe.finishingStrength>0;
  const finishLabel=recipe.finishingStrength===0?(recipe.autoExposure?"Custom Auto levels · extra finish off":"Off"):recipe.finishingStrength<=25?"Auto balance":recipe.finishingStrength<=50?"Bright":recipe.finishingStrength<=75?"Web pop":"Vivid";
  const effectivePreviewVariant = !recipe.colour && recipe.bw ? "bw" : !recipe.bw && recipe.colour ? "colour" : previewVariant;
  const photoDirty = editingPhoto && JSON.stringify(photoRecipe) !== JSON.stringify(savedPhotoRecipe || defaults);
  const namingBlock = photoDirty ? "Close this event editor and save or discard the unsaved RAW photo override before renaming its folder."
    : previewPendingCount > 0 || saving || queueing ? "Wait for the current RAW preview/save to finish before renaming its folder." : null;
  useLayoutEffect(() => { onNamingBlockChange?.(namingBlock); }, [namingBlock, onNamingBlockChange]);
  useEffect(() => () => onNamingBlockChange?.(null), [onNamingBlockChange]);
  const unavailable = candidates?.runtime?.available === false;
  const noOutput = !defaults.colour && !defaults.bw;
  const scope: RawScope = { stagingDir, scopeDir, scopeMode, selection, minRating, ...(selection === "selected" ? { selectedPaths } : {}) };

  function clearPreview() {
    for (const url of previewRef.current?.urls || []) URL.revokeObjectURL(url);
    previewRef.current = null; setPreview(null); setPreviewBusy(false); setActualPixels(false);
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; candidateGeneration.current++; recipeGeneration.current++; previewGeneration.current++; actionGeneration.current++;
      for (const url of previewRef.current?.urls || []) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const current = ++candidateGeneration.current;
    actionGeneration.current++; previewGeneration.current++; recipeGeneration.current++;
    clearPreview(); setPath(""); setSelectedPaths([]); setCandidates(null); setError(null); setMessage(null); setJobId(null);
    setRecipeLoaded(false); setEditingPhoto(false); setSavedPhotoRecipe(null); setLastAppliedRecipe(null); setLoadingRecipe(false); setSaving(false); setQueueing(false);
    if (!expanded || !stagingDir) { setLoading(false); return; }
    setLoading(true);
    // Explicit selection is chosen from the scoped original list; viewing a photo never selects it for a batch.
    invoke<RawCandidates>("raw_development_candidates", { request: { stagingDir, scopeDir, scopeMode, selection: selection === "selected" ? "all" : selection, minRating } })
      .then((data) => {
        if (current !== candidateGeneration.current) return;
        if (!Array.isArray(data.paths) || !Number.isFinite(data.total)) throw new Error("Invalid RAW candidate response");
        setCandidates(data); setPath(data.paths[0] || ""); setCandidateRevision((value) => value + 1);
      }).catch((reason) => { if (current === candidateGeneration.current) setError(String(reason)); })
      .finally(() => { if (current === candidateGeneration.current) setLoading(false); });
    return () => { candidateGeneration.current++; };
  }, [expanded, scopeKey, selection, minRating, refresh, refreshKey]);

  useEffect(() => {
    const current = ++recipeGeneration.current;
    actionGeneration.current++; setSavedPhotoRecipe(null); setLastAppliedRecipe(null); setRecipeLoaded(false); setPhotoRecipe(defaults); setEditingPhoto(false); setSaving(false);
    if (!path || !expanded) { setLoadingRecipe(false); return; }
    setLoadingRecipe(true);
    invoke<RawRecipeRecord>("get_raw_recipe", { stagingDir, path }).then((data) => {
      if (current !== recipeGeneration.current) return;
      const saved = data.recipe ? normalizeRawRecipe(data.recipe) : null;
      setSavedPhotoRecipe(saved); setPhotoRecipe(saved || defaults);
      setLastAppliedRecipe(data.lastAppliedRecipe ? normalizeRawRecipe(data.lastAppliedRecipe) : null); setRecipeLoaded(true);
    }).catch((reason) => { if (current === recipeGeneration.current) setError(`Could not read this photo's saved recipe: ${String(reason)}`); })
      .finally(() => { if (current === recipeGeneration.current) setLoadingRecipe(false); });
    return () => { recipeGeneration.current++; };
  }, [path, stagingDir, expanded, candidateRevision]);

  useEffect(() => { previewGeneration.current++; clearPreview(); }, [scopeKey, path, recipeKey, effectivePreviewVariant, expanded]);

  function edit(patch: Partial<RawRecipe>) {
    const next = (current: RawRecipe) => normalizeRawRecipe({ ...current, ...patch, preset: "custom" });
    if (editingPhoto) setPhotoRecipe(next); else setDefaults(next);
    setMessage(null);
  }
  function preset(value: "natural" | "neutral" | "highIso" | "webBright") {
    const next = { ...rawPreset(value), output: recipe.output, colour: recipe.colour, bw: recipe.bw, keepGps: recipe.keepGps, bwParams: { ...recipe.bwParams } };
    if (editingPhoto) setPhotoRecipe(next); else setDefaults(next);
    setMessage(null);
  }
  function choosePhoto(next: string) {
    if (photoDirty && !window.confirm("Discard the unsaved recipe changes for this photo? Its saved recipe and original file will remain unchanged.")) return;
    setPath(next); setError(null); setMessage(null);
  }
  function recallAppliedRecipe() {
    if (!editingPhoto || !lastAppliedRecipe || !recipeLoaded || saving || queueing) return;
    if (photoDirty && !window.confirm("Replace unsaved photo edits with its last applied recipe? The saved override and job defaults will stay unchanged.")) return;
    setPhotoRecipe(normalizeRawRecipe(lastAppliedRecipe));
    setMessage("Last applied settings recalled as an editable photo draft. Job defaults and the saved override are unchanged until you save this photo's override.");
  }
  async function savePhoto(remove: boolean) {
    if (!path || !recipeLoaded || saving) return;
    const current = ++actionGeneration.current;
    const captured = normalizeRawRecipe(photoRecipe);
    setSaving(true); setError(null); setMessage(null);
    try {
      await invoke(remove ? "clear_raw_recipe" : "save_raw_recipe", { stagingDir, path, ...(remove ? {} : { recipe: captured }) });
      if (current !== actionGeneration.current) return;
      setSavedPhotoRecipe(remove ? null : captured); setPhotoRecipe(remove ? defaults : captured);
      setMessage(remove ? "Saved override removed. This photo will use the job defaults." : "Per-photo recipe saved with the staging metadata. The CR3 original was not changed.");
    } catch (reason) { if (current === actionGeneration.current) setError(String(reason)); }
    finally { if (current === actionGeneration.current) setSaving(false); }
  }
  function generate(fullResolution: boolean) {
    if (!path || unavailable || (!recipe.colour && !recipe.bw)) return;
    const current = ++previewGeneration.current;
    const request = { stagingDir, scopeDir, scopeMode, selection: "all", minRating: 0, path, recipe: normalizeRawRecipe(recipe), fullResolution, previewVariant: effectivePreviewVariant };
    clearPreview(); setPreviewBusy(true); setPreviewPendingCount((value) => value + 1); setError(null);
    previewLane = previewLane.catch(() => {}).then(async () => {
      const urls: string[] = [];
      try {
        if (current !== previewGeneration.current) return;
        const result = await invoke<RawPreviewResult>("raw_development_preview", { request });
        if (current !== previewGeneration.current) return;
        if (result.path !== request.path || !Number.isFinite(result.width) || !Number.isFinite(result.height) || result.width <= 0 || result.height <= 0) throw new Error("RAW preview identity or dimensions did not match the requested photo.");
        const display = { ...result, original: imageBlob(result.original, urls), processed: imageBlob(result.processed, urls)!, urls, previewVariant: request.previewVariant };
        if (!display.processed) throw new Error("The RAW worker returned no developed preview.");
        previewRef.current = display; setPreview(display); setActualPixels(fullResolution && result.fullResolution);
      } catch (reason) {
        for (const url of urls) URL.revokeObjectURL(url);
        if (current === previewGeneration.current) setError(String(reason));
      } finally {
        if (alive.current) setPreviewPendingCount((value) => Math.max(0, value - 1));
        if (current === previewGeneration.current) setPreviewBusy(false);
      }
    });
  }
  async function queue() {
    if (queueing || previewPendingCount > 0 || unavailable || noOutput || !candidates?.total || (selection === "selected" && !selectedPaths.length)) return;
    if (usePhotoOverrides && photoDirty) { setError("Save or discard this photo's unsaved override before queueing with per-photo overrides."); return; }
    const current = ++actionGeneration.current;
    setQueueing(true); setError(null); setMessage(null); setJobId(null);
    try {
      const id = await invoke<string>("start_raw_development_job", { request: { ...scope, recipe: normalizeRawRecipe(defaults), usePhotoOverrides } });
      if (current !== actionGeneration.current) return;
      setJobId(id); setMessage(`RAW Development queued in Jobs. Job ID: ${id}.`);
    } catch (reason) { if (current === actionGeneration.current) setError(String(reason)); }
    finally { if (current === actionGeneration.current) setQueueing(false); }
  }
  const visiblePaths = (candidates?.paths || []).filter((item) => item.toLowerCase().includes(filter.toLowerCase()));
  const blocked = !stagingDir || loading || queueing || saving;
  return <section className="card mb-4 min-w-0" role="region" aria-label="RAW Development">
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div><h3 className="text-base font-semibold text-amber-200">RAW Development</h3><p className="text-xs text-gray-400 mt-1 max-w-3xl">Develop Canon CR3 originals into full-resolution photos. Camera previews are for quick review; finished exports always decode the RAW.</p></div>
      <button type="button" className="btn-secondary text-xs" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Close RAW controls" : "Set up RAW Development"}</button>
    </div>
    {expanded && <div className="space-y-4 mt-4">
      <div className="rounded border border-amber-800/60 bg-amber-950/15 p-2 text-xs text-amber-100">CR3 originals remain untouched. Settings are saved as recipes; colour and B&W are developed independently. Existing camera JPEGs are preserved.</div>
      <details className="rounded border border-surface-600 px-3 py-2 text-xs text-gray-400"><summary className="cursor-pointer text-gray-300">How RAW settings are applied</summary><ol className="list-decimal ml-4 mt-2 space-y-1"><li>Edit job defaults for the current batch. Save defaults on this computer to reuse them later.</li><li>Save a photo's override to keep its own settings with staging metadata. The queue uses it only when Use saved per-photo overrides is checked.</li><li>Recall last applied recipe loads the settings from the photo's previous development into an editable draft. It changes neither defaults nor the saved override until you deliberately save.</li><li>Preview uses the controls currently shown. Queue RAW Development writes full-quality outputs; follow progress in Jobs, then inspect JPEG results in Photo Lightbox.</li></ol></details>
      {candidates?.runtime && <p className={`text-xs ${unavailable ? "text-red-300" : "text-gray-400"}`}>{candidates.runtime.version && `${candidates.runtime.version} · `}{candidates.runtime.message}</p>}
      <div className="grid gap-3 md:grid-cols-2 items-start">
        <div className="space-y-2 min-w-0">
          <label className="text-xs text-gray-300 block">RAW batch selection<select aria-label="RAW batch selection" className="input-field w-full mt-1" value={selection} disabled={blocked} onChange={(event) => setSelection(event.target.value as RawSelection)}>
            <option value="nonTrash">All non-trash CR3 originals</option><option value="all">All CR3 originals, including trash-marked</option><option value="minRating">Minimum rating, excluding trash</option><option value="selected">Only originals I select below</option>
          </select></label>
          {selection === "minRating" && <label className="block text-xs text-gray-300">Minimum RAW rating<select aria-label="Minimum RAW rating" className="input-field ml-2" value={minRating} onChange={(event) => setMinRating(Number(event.target.value))}>{[1, 2, 3].map((rating) => <option key={rating} value={rating}>{rating} {rating === 1 ? "star" : "stars"} and above</option>)}</select></label>}
          <p className="text-xs text-gray-500 break-all">{scopeDir || "Configure staging in Settings"} · {scopeMode === "folderOnly" ? "this folder only" : "including subfolders"}</p>
          <div className="flex gap-2 items-center flex-wrap"><button type="button" className="btn-secondary text-xs" disabled={blocked} onClick={() => setRefresh((value) => value + 1)}>Refresh RAW list</button><span className="text-xs text-gray-400">{loading ? "Finding CR3 originals…" : candidates ? `${candidates.total.toLocaleString()} eligible original${candidates.total === 1 ? "" : "s"}` : ""}</span></div>
          {selection === "selected" && <fieldset className="rounded border border-surface-600 p-2 min-w-0"><legend className="text-xs text-gray-300 px-1">Select batch originals · {selectedPaths.length} selected</legend>
            <input aria-label="Filter RAW originals" className="input-field w-full text-xs mb-2" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter filenames" />
            <div className="max-h-40 overflow-auto space-y-1">{visiblePaths.map((item) => <label key={item} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-surface-700 text-xs text-gray-300 break-all"><input type="checkbox" aria-label={`Include ${name(item)} in RAW batch`} className="w-5 h-5 shrink-0 accent-amber-400" checked={selectedPaths.includes(item)} onChange={(event) => setSelectedPaths((current) => event.target.checked ? [...current, item] : current.filter((value) => value !== item))} />{name(item)}</label>)}</div>
            <p className="text-xs text-gray-500 mt-2">These are batch choices, independent of the Google Photos upload checkboxes.</p>
          </fieldset>}
          {candidates?.truncated && <p className="text-xs text-amber-300">The sample list is capped. Choose a narrower processing folder to inspect or select other originals; All modes still process the complete eligible scope.</p>}
        </div>
        <div className="space-y-2 min-w-0 rounded border border-surface-600 p-3 bg-surface-900/40">
          <label className="block text-xs text-gray-300">Inspect original<select aria-label="RAW preview original" className="input-field w-full mt-1 text-xs" value={path} disabled={loading || saving || !candidates?.paths.length} onChange={(event) => choosePhoto(event.target.value)}>{!path && <option value="">No eligible CR3 originals</option>}{(candidates?.paths || []).map((item) => <option key={item} value={item}>{name(item)}</option>)}</select></label>
          <div className="flex gap-2 flex-wrap"><button type="button" className="btn-secondary text-xs" disabled={(candidates?.paths.length || 0) < 2 || saving} onClick={() => { const others = candidates!.paths.filter((item) => item !== path); choosePhoto(others[Math.floor(Math.random() * others.length)]); }}>Another random RAW</button><button type="button" className="btn-secondary text-xs" disabled={!path || saving || (candidates?.paths.length || 0) < 2} onClick={() => choosePhoto(candidates!.paths[(candidates!.paths.indexOf(path) + 1) % candidates!.paths.length])}>Next RAW</button></div>
          <p className="text-xs text-gray-400">{loadingRecipe ? "Reading saved recipe…" : savedPhotoRecipe ? "This photo has a saved override." : path && recipeLoaded ? "This photo uses job defaults until an override is saved." : "Choose an original to inspect its recipe."}</p>
          {lastAppliedRecipe && <p className="text-xs text-gray-500">A last-applied recipe is available to recall in this photo's editor.</p>}
        </div>
      </div>
      <div className="flex gap-2 flex-wrap items-center border-b border-surface-600 pb-2">
        <button type="button" className={editingPhoto ? "btn-secondary text-xs" : "btn-primary text-xs"} aria-pressed={!editingPhoto} disabled={saving} onClick={() => { if (photoDirty && !window.confirm("Discard the unsaved recipe changes for this photo? Its saved recipe and original file will remain unchanged.")) return; setPhotoRecipe(savedPhotoRecipe || defaults); setEditingPhoto(false); }}>Edit job defaults</button>
        <button type="button" className={editingPhoto ? "btn-primary text-xs" : "btn-secondary text-xs"} aria-pressed={editingPhoto} disabled={!path || !recipeLoaded || saving} onClick={() => { if (!editingPhoto) setPhotoRecipe(savedPhotoRecipe || defaults); setEditingPhoto(true); }}>Edit this photo's override</button>
        <span className="text-xs text-gray-400">{editingPhoto ? `${name(path)} · ${photoDirty ? "unsaved changes" : savedPhotoRecipe ? "saved override" : "no saved override"}` : "Used for each eligible original unless it has a saved override"}</span>
      </div>
      <fieldset disabled={saving || queueing} className="space-y-3 min-w-0">
        <div className="flex items-center gap-2 flex-wrap"><span className="text-xs text-gray-300">Starting preset</span>{([['natural', 'Natural'], ['neutral', 'Neutral'], ['highIso', 'High ISO'], ['webBright', 'Internet ready']] as const).map(([value, label]) => <button type="button" key={value} className="btn-secondary text-xs" aria-pressed={recipe.preset === value} onClick={() => preset(value)}>{label}</button>)}<span className="text-xs text-gray-500">{recipe.preset === "custom" ? "Custom adjustments" : "Refine below; inspect at 100%"}</span></div>
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/15 p-3 space-y-2">
          <label className="block"><span className="flex justify-between gap-3 text-sm text-amber-100"><strong>Auto finish</strong><span className="tabular-nums">{finishLabel} · {recipe.finishingStrength}%</span></span>
            <input aria-label="RAW Auto finish strength" type="range" min={0} max={100} step={1} value={recipe.finishingStrength} className="w-full accent-amber-400 mt-2" onChange={event=>{const amount=Number(event.target.value);edit({finishingStrength:amount,autoExposure:amount>0});}} />
          </label>
          <div className="flex justify-between text-xs text-gray-400"><span>Off</span><span>Balance</span><span>Bright</span><span>Web pop</span><span>Vivid</span></div>
          <p className="text-xs text-gray-300">Try 65 for a bright, attractive Google Photos starting look. Automatic levels establish exposure; increasing strength adds midtone light, contrast, protected vibrance and restrained edge detail. White balance and output resolution stay under your control.</p>
          <p className="text-xs text-gray-500">Leaving Off enables automatic levels, so the first step can visibly change exposure. This is not an opacity blend. Returning to Off restores saved manual values. Existing Auto levels recipes remain unchanged until you adjust them.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs text-gray-300">White balance<select aria-label="RAW white balance" className="input-field w-full mt-1" value={recipe.whiteBalance} onChange={(event) => edit({ whiteBalance: event.target.value as RawRecipe["whiteBalance"] })}><option value="asShot">As shot</option><option value="auto">Automatic</option><option value="custom">Custom temperature / tint</option></select></label>
          <label className="text-xs text-gray-200 flex gap-2 items-start pt-1"><input type="checkbox" aria-label="Auto levels" className="w-5 h-5 shrink-0 accent-amber-400" checked={automaticLevels} onChange={(event) => edit({ autoExposure: event.target.checked, ...(!event.target.checked ? {finishingStrength:0} : {}) })} /><span>Auto levels<small className="block text-xs text-gray-500 mt-1">Off by default. Automatically calculates exposure, black point, contrast and highlight compression. Those manual values are kept for when you turn Auto levels off.</small></span></label>
          {recipe.whiteBalance === "custom" && <><label className="text-xs text-gray-300">Temperature (K)<input type="number" aria-label="RAW temperature" className="input-field w-full mt-1" min={2000} max={12000} step={50} value={recipe.temperature} onChange={(event) => edit({ temperature: Number(event.target.value) })} /></label><label className="text-xs text-gray-300">Tint multiplier<input type="number" aria-label="RAW tint" className="input-field w-full mt-1" min={.5} max={2} step={.01} value={recipe.tint} onChange={(event) => edit({ tint: Number(event.target.value) })} /></label></>}
          {sliders.map(({ key, label, min, max, step = 1, hint }) => {
            const automatic = automaticLevels && AUTO_LEVEL_KEYS.includes(key);
            return <label key={key} className="block min-w-0"><span className="flex justify-between gap-2 text-xs text-gray-300"><span>{label}</span><span className="text-amber-200 tabular-nums">{automatic ? "Saved " : ""}{Number(recipe[key]).toFixed(step < 1 ? 2 : 0)}</span></span><input aria-label={`RAW ${label}`} type="range" className="w-full accent-amber-400 mt-1 disabled:opacity-40" disabled={automatic} value={Number(recipe[key])} min={min} max={max} step={step} onChange={(event) => edit({ [key]: Number(event.target.value) })} /><span className="block text-xs text-gray-500">{automatic ? "Calculated by Auto levels; saved manual value returns when off" : hint}</span></label>;
          })}
        </div>
        <p className="text-xs text-gray-400">Detail sharpening uses edge-limited unsharp masking. It does not identify a horse or rider automatically; inspect blurred backgrounds at 100% and keep the amount conservative.</p>
        <div className="flex gap-4 flex-wrap items-center rounded bg-surface-900/60 p-3">
          <label className="text-xs text-gray-300">Output format<select aria-label="RAW output format" className="input-field block mt-1" value={recipe.output} onChange={(event) => edit({ output: event.target.value as RawRecipe["output"] })}><option value="jpeg">Full-resolution sRGB JPEG</option><option value="tiff16">Full-resolution 16-bit TIFF</option></select></label>
          <label className="text-xs text-gray-200 flex gap-2 items-center"><input type="checkbox" className="w-5 h-5 accent-amber-400" checked={recipe.colour} onChange={(event) => edit({ colour: event.target.checked })} />Colour development</label>
          <label className="text-xs text-gray-200 flex gap-2 items-center"><input type="checkbox" className="w-5 h-5 accent-amber-400" checked={recipe.bw} onChange={(event) => edit({ bw: event.target.checked })} />Independent B&W</label>
          <label className="text-xs text-gray-200 flex gap-2 items-center"><input type="checkbox" className="w-5 h-5 accent-amber-400" checked={recipe.keepGps} onChange={(event) => edit({ keepGps: event.target.checked })} />Keep GPS in output copies</label>
        </div>
        {recipe.output === "tiff16" && <p className="text-xs text-amber-200">TIFF exports are written beside the original and can be included in an archive. Photo Lightbox compares JPEG versions; TIFF exports are available in the output folder.</p>}
        {recipe.bw && <details className="rounded border border-surface-600 px-3 py-2"><summary className="cursor-pointer text-xs text-gray-300">Independent B&W adjustments</summary><div className="grid gap-3 sm:grid-cols-3 mt-3">{([
          ["localContrast", "B&W local contrast", 0, 1, .05], ["sharpness", "B&W sharpening", 0, 1, .05], ["curveStrength", "B&W S-curve strength", 0, 1, .05], ["shadowDepth", "B&W shadow depth", 0, .25, .01], ["highlightLift", "B&W highlight lift", 0, .25, .01], ["midpoint", "B&W tonal midpoint", .25, .75, .01],
        ] as const).map(([key, label, min, max, step]) => <label key={key} className="text-xs text-gray-300"><span className="flex justify-between"><span>{label}</span><span>{recipe.bwParams[key].toFixed(2)}</span></span><input type="range" aria-label={`RAW ${label}`} min={min} max={max} step={step} className="w-full accent-amber-400" value={recipe.bwParams[key]} onChange={(event) => edit({ bwParams: { ...recipe.bwParams, [key]: Number(event.target.value) } })} /></label>)}</div><p className="text-xs text-gray-500 mt-2">The B&W branch starts from RAW development, independently of the colour JPEG. RAW B&W local contrast maps 0–1 to RawTherapee Local Contrast Amount 0–0.15; sharpening uses its edge-limited unsharp mask. These controls use the RAW engine rather than the JPEG job's CLAHE processing.</p></details>}
      </fieldset>
      <div className="flex gap-2 flex-wrap items-center">
        {editingPhoto ? <><button type="button" className="btn-secondary text-xs" disabled={!recipeLoaded || saving || queueing || (!photoRecipe.colour && !photoRecipe.bw)} onClick={() => void savePhoto(false)}>{saving ? "Saving recipe…" : "Save this photo's override"}</button><button type="button" className="btn-secondary text-xs" disabled={!savedPhotoRecipe || saving || queueing} onClick={() => void savePhoto(true)}>Remove saved override</button><button type="button" className="btn-secondary text-xs" disabled={!lastAppliedRecipe || !recipeLoaded || saving || queueing} onClick={recallAppliedRecipe}>Recall last applied recipe</button><button type="button" className="btn-secondary text-xs" disabled={saving || queueing} onClick={() => setPhotoRecipe(savedPhotoRecipe || defaults)}>Discard unsaved edits</button></> : <button type="button" className="btn-secondary text-xs" disabled={noOutput} onClick={() => setMessage(saveRawDefaults(defaults) ? "Job defaults saved on this computer. Saved per-photo overrides remain unchanged." : "Could not save defaults on this computer. Current settings still apply to the next queued job.")}>Save job defaults on this computer</button>}
        {(!recipe.colour && !recipe.bw) && <span className="text-xs text-amber-300">Choose at least one output.</span>}
      </div>
      <div className="rounded border border-surface-600 bg-surface-900/40 p-3 space-y-3" aria-label="RAW comparison preview" aria-busy={previewBusy}>
        <label className="text-xs text-gray-300 flex items-center gap-2">Preview branch<select aria-label="RAW preview branch" className="input-field w-auto text-xs py-1.5" value={effectivePreviewVariant} disabled={!recipe.colour && !recipe.bw} onChange={(event) => setPreviewVariant(event.target.value === "bw" ? "bw" : "colour")}><option value="colour" disabled={!recipe.colour}>Colour</option><option value="bw" disabled={!recipe.bw}>B&W</option></select></label>
        <div className="flex gap-2 items-center flex-wrap"><h4 className="text-sm font-medium text-white mr-auto">Inspect before developing</h4><button type="button" className="btn-secondary text-xs" disabled={!path || unavailable || previewBusy || (!recipe.colour && !recipe.bw)} onClick={() => generate(false)}>Generate RAW preview</button><button type="button" className="btn-secondary text-xs" disabled={!path || unavailable || previewBusy || (!recipe.colour && !recipe.bw)} onClick={() => generate(true)}>100% RAW detail check</button></div>
        <p className="text-xs text-gray-400">Uses the {editingPhoto ? "photo override currently shown" : "job defaults currently shown"}. Adjustments clear the comparison; click to regenerate. Previewing neither queues a job nor exports a photo.</p>
        {previewBusy && <p role="status" className="text-xs text-amber-200 py-8 text-center">Developing the requested comparison…</p>}
        {preview && <>
          <div className="flex items-center gap-2 flex-wrap"><button type="button" className="btn-secondary text-xs" aria-pressed={!actualPixels} onClick={() => setActualPixels(false)}>Fit RAW comparison</button><button type="button" className="btn-secondary text-xs" aria-pressed={actualPixels} disabled={!preview.fullResolution} onClick={() => setActualPixels(true)}>Actual developed pixels</button><span className="text-xs text-gray-400">{preview.width} × {preview.height} · {preview.fullResolution ? "Full-resolution RAW development" : "Draft display"} · {(preview.elapsedMs / 1000).toFixed(2)} s</span></div>
          {preview.warning && <p className="text-xs text-amber-200">{preview.warning}</p>}
          <div className={`grid gap-2 min-w-0 ${preview.original ? "lg:grid-cols-2" : "grid-cols-1"}`}>
            {[{ label: preview.sourceLabel || "Camera preview · rendering may differ", src: preview.original, width: preview.originalWidth, height: preview.originalHeight, own: sourceScroll, other: resultScroll, original: true }, { label: `${preview.previewVariant === "bw" ? "B&W" : "Colour"} RAW-developed result`, src: preview.processed, width: preview.width, height: preview.height, own: resultScroll, other: sourceScroll, original: false }].filter((image) => image.src).map((image) => <figure key={image.label} className="rounded overflow-hidden border border-surface-600 min-w-0"><figcaption className="bg-surface-800 text-xs px-2 py-1 text-gray-300">{image.label}{image.width && image.height ? ` · ${image.width} × ${image.height}` : ""}</figcaption><div ref={image.own} className="h-80 overflow-auto bg-black/50 flex" onScroll={(event) => { if (!actualPixels || !image.other.current) return; image.other.current.scrollLeft = event.currentTarget.scrollLeft; image.other.current.scrollTop = event.currentTarget.scrollTop; }}><img draggable={false} title="Display preview only. Queue RAW Development to save full-quality photos beside the original." onContextMenu={(event) => event.preventDefault()} alt={image.original ? "RAW camera reference preview" : "RAW developed comparison"} src={image.src!} className={actualPixels ? "shrink-0 self-start" : "w-full h-full object-contain"} style={actualPixels ? { width: image.width, maxWidth: "none" } : undefined} /></div></figure>)}
          </div>
          {preview.histogram && <Histogram data={preview.histogram} />}
          <p className="text-xs text-gray-500">Inspect fine fur, mane, edge halos and smooth background areas. A camera preview can be smaller than the RAW and uses a different rendering. The preview images are display copies.</p>
        </>}
      </div>
      {error && <p role="alert" className="rounded border border-red-800 bg-red-950/20 p-3 text-sm text-red-300 break-words">{error}</p>}
      {message && <div role="status" className="rounded border border-emerald-800 bg-emerald-950/20 p-3 text-xs text-emerald-200 flex items-center gap-2 flex-wrap"><span className="break-words">{message}</span>{jobId && onOpenJobs && <button type="button" className="btn-secondary text-xs" onClick={onOpenJobs}>Open Jobs</button>}</div>}
      <div className="border-t border-surface-600 pt-3 space-y-3">
        <label className="flex gap-2 items-center text-xs text-gray-200"><input type="checkbox" className="w-5 h-5 accent-amber-400" checked={usePhotoOverrides} disabled={queueing} onChange={(event) => setUsePhotoOverrides(event.target.checked)} />Use saved per-photo overrides where present</label>
        <div className="flex gap-3 items-center flex-wrap"><button type="button" className="btn-primary text-sm" disabled={blocked || previewPendingCount > 0 || unavailable || noOutput || !candidates?.total || (selection === "selected" && !selectedPaths.length) || (usePhotoOverrides && photoDirty)} onClick={() => void queue()}>{queueing ? "Queueing RAW Development…" : "Queue RAW Development"}</button><p className="text-xs text-gray-400 max-w-2xl">{selection === "selected" ? `${selectedPaths.length} explicitly selected original${selectedPaths.length === 1 ? "" : "s"}` : "Every eligible CR3 original in the current processing scope"} · {usePhotoOverrides ? "job defaults plus saved photo overrides" : "job defaults only"}. Full-resolution outputs; originals and unrelated files are preserved.</p></div>
        {previewPendingCount > 0 && <p className="text-xs text-amber-200">Wait for the active or queued preview to finish before queueing a full development job.</p>}
        {usePhotoOverrides && photoDirty && <p className="text-xs text-amber-300">Save or discard the unsaved photo override before queueing.</p>}
        <p className="text-xs text-gray-500">Follow progress, pause or cancel through core Jobs. Preview quality and batch throughput depend on the source and recipe; developing does not use the camera thumbnail as its final output.</p>
      </div>
    </div>}
  </section>;
}
