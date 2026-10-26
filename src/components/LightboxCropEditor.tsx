import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LightboxPhoto } from "../utils/lightboxCatalogue";
import { cropPixelSize, dragCrop, fitCropRatio, FULL_CROP, validCrop, type CropHandle } from "../utils/lightboxCrop";
import { loadPhotoProcessRecipe, savePhotoProcessRecipe, type PhotoProcessRecipe } from "../utils/photoProcessRecipe";
import type { CropRect, LightboxCropInfo, LightboxCropResult } from "../types/lightboxCrop";
import { lightboxCropCommands, lightboxTypingTarget, matchLightboxCropCommand, shortcutFor } from "../utils/lightboxCommands";

interface Props {
  stagingDir: string; photo: LightboxPhoto;
  onClose: () => void; onSaved: (result: LightboxCropResult) => void;
}
const handles: Array<{ id: CropHandle; label: string; left: string; top: string; cursor: string }> = [
  { id: "nw", label: "top-left corner", left: "0%", top: "0%", cursor: "nwse-resize" },
  { id: "n", label: "top edge", left: "50%", top: "0%", cursor: "ns-resize" },
  { id: "ne", label: "top-right corner", left: "100%", top: "0%", cursor: "nesw-resize" },
  { id: "e", label: "right edge", left: "100%", top: "50%", cursor: "ew-resize" },
  { id: "se", label: "bottom-right corner", left: "100%", top: "100%", cursor: "nwse-resize" },
  { id: "s", label: "bottom edge", left: "50%", top: "100%", cursor: "ns-resize" },
  { id: "sw", label: "bottom-left corner", left: "0%", top: "100%", cursor: "nesw-resize" },
  { id: "w", label: "left edge", left: "0%", top: "50%", cursor: "ew-resize" },
];
const ratioOptions = ["Free", "Original", "3:2", "4:3", "Square", "16:9"];
// React StrictMode replays mount effects. Share only an in-flight inspection;
// keep no completed preview cache, so each explicit reload verifies new bytes.
const inspections = new Map<string, Promise<LightboxCropInfo>>();
function inspectOriginal(stagingDir: string, path: string): Promise<LightboxCropInfo> {
  const key = JSON.stringify([stagingDir, path]);
  const current = inspections.get(key);
  if (current) return current;
  const request = invoke<LightboxCropInfo>("lightbox_crop_info", { stagingDir, path });
  inspections.set(key, request);
  void request.then(() => inspections.delete(key), () => inspections.delete(key));
  return request;
}

export default function LightboxCropEditor({ stagingDir, photo, onClose, onSaved }: Props) {
  const [info, setInfo] = useState<LightboxCropInfo | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropRect>({ ...FULL_CROP });
  const [ratioName, setRatioName] = useState("Free");
  const [portrait, setPortrait] = useState(false);
  const [recipe, setRecipe] = useState<PhotoProcessRecipe>(loadPhotoProcessRecipe);
  const [bw, setBw] = useState(!!(photo.bw || photo.crop?.bw));
  const [enhanced, setEnhanced] = useState(!!(photo.improved || photo.crop?.improved));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState({ width: 1, height: 1 });
  const dialog = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const loadRequest = useRef(0);
  const drag = useRef<{ pointer: number; x: number; y: number; start: CropRect; handle: CropHandle } | null>(null);
  const ratioFrame = useRef<CropRect>({ ...FULL_CROP });
  const applyRef = useRef<() => void>(() => {});
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const cropHelp = useRef<HTMLDetailsElement>(null);
  const actionsRef = useRef<Record<string, () => void>>({});

  async function load() {
    const request = ++loadRequest.current;
    setLoading(true); setError(""); setInfo(null);
    try {
      const details = await inspectOriginal(stagingDir, photo.original.path);
      if (!alive.current || request !== loadRequest.current) return;
      if (!(details.width > 0 && details.height > 0 && details.sourceFingerprint && details.original)) throw new Error("The original preview and crop dimensions could not be verified.");
      // Native returns these preview pixels, upright dimensions and fingerprint
      // from the same source bytes: never pair a fresh fingerprint with a cache.
      const initialCrop = validCrop(details.crop) ? details.crop : { ...FULL_CROP };
      setInfo(details); setSource(details.original.startsWith("data:") ? details.original : `data:image/jpeg;base64,${details.original}`); setCrop(initialCrop); ratioFrame.current = initialCrop;
      setRatioName("Free"); setPortrait(details.height > details.width);
    } catch (reason) { if (alive.current && request === loadRequest.current) setError(String(reason)); }
    finally { if (alive.current && request === loadRequest.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; ++loadRequest.current; };
  }, [stagingDir, photo.original.path]);
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setAvailable({ width: Math.max(1, entry.contentRect.width - 40), height: Math.max(1, entry.contentRect.height - 40) }));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    function key(event: KeyboardEvent) {
      const action = matchLightboxCropCommand(event);
      if (action && (["crop-close", "crop-help", "crop-apply"].includes(action) || !lightboxTypingTarget(event.target))) {
        event.preventDefault(); event.stopPropagation();
        if (busyRef.current) return;
        if (action === "crop-close") closeRef.current();
        else if (action === "crop-apply") applyRef.current();
        else if (action === "crop-help" && cropHelp.current) {cropHelp.current.open = !cropHelp.current.open; cropHelp.current.scrollIntoView({ block: "nearest" }); cropHelp.current.querySelector<HTMLElement>("summary")?.focus();}
        else actionsRef.current[action]?.();
      } else if (event.key === "Tab") {
        const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? [])].filter(node => node.getClientRects().length);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    }
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); previouslyFocused?.focus(); };
  }, []);

  function ratioFor(name = ratioName, vertical = portrait): number | null {
    if (!info || name === "Free") return null;
    if (name === "Original") return info.width / info.height;
    const ratio = name === "Square" ? 1 : name === "3:2" ? 3 / 2 : name === "4:3" ? 4 / 3 : 16 / 9;
    return vertical ? 1 / ratio : ratio;
  }
  function chooseRatio(name: string, vertical = portrait) {
    setRatioName(name); setPortrait(vertical);
    if (name === "Free") { ratioFrame.current = crop; return; }
    // Ratio toggles share the last manually framed region, rather than repeatedly
    // shrinking an already ratio-cropped rectangle on each portrait/landscape flip.
    if (info) setCrop(fitCropRatio(ratioFrame.current, ratioFor(name, vertical), info.width, info.height));
  }
  function resetFullFrame() {
    if (loading || busyRef.current) return;
    ratioFrame.current = { ...FULL_CROP }; setCrop({ ...FULL_CROP }); setRatioName("Free");
  }
  actionsRef.current = {
    "crop-reset": resetFullFrame,
    "crop-orientation": () => {if (!loading && !busyRef.current && !["Free", "Original", "Square"].includes(ratioName)) chooseRatio(ratioName, !portrait);},
    "crop-bw": () => {if (!loading && !busyRef.current) setBw(value => !value);},
    "crop-enhanced": () => {if (!loading && !busyRef.current) setEnhanced(value => !value);},
  };
  function begin(event: React.PointerEvent, handle: CropHandle) {
    if (busy || loading || !info || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    surface.current?.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, start: crop, handle };
  }
  function move(event: React.PointerEvent) {
    const action = drag.current, box = surface.current?.getBoundingClientRect();
    if (!action || !box || !info || action.pointer !== event.pointerId) return;
    const next = dragCrop(action.start, action.handle, (event.clientX - action.x) / box.width, (event.clientY - action.y) / box.height, ratioFor(), info.width, info.height);
    ratioFrame.current = next; setCrop(next);
  }
  function end(event: React.PointerEvent) {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
    if (surface.current?.hasPointerCapture(event.pointerId)) surface.current.releasePointerCapture(event.pointerId);
  }
  function nudge(event: React.KeyboardEvent, handle: CropHandle) {
    if (!info || busy || !event.key.startsWith("Arrow")) return;
    event.preventDefault(); event.stopPropagation();
    const pixels = event.shiftKey ? 10 : 1;
    const next = dragCrop(crop, handle, (event.key === "ArrowLeft" ? -pixels : event.key === "ArrowRight" ? pixels : 0) / info.width, (event.key === "ArrowUp" ? -pixels : event.key === "ArrowDown" ? pixels : 0) / info.height, ratioFor(), info.width, info.height);
    ratioFrame.current = next; setCrop(next);
  }
  async function apply() {
    if (!info || !source || loading || busyRef.current || !validCrop(crop)) return;
    const size = cropPixelSize(crop, info.width, info.height);
    if (size.width < 16 || size.height < 16) { setError("The crop must retain at least 16 × 16 pixels."); return; }
    busyRef.current = true; setBusy(true); setError("");
    try {
      const result = await invoke<LightboxCropResult>("lightbox_apply_crop", { request: {
        stagingDir, path: photo.original.path, sourceFingerprint: info.sourceFingerprint, crop,
        regenerateBw: bw, regenerateEnhanced: enhanced, ...recipe,
      } });
      if (!alive.current) return;
      savePhotoProcessRecipe(recipe); onSaved(result);
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  applyRef.current = () => { void apply(); };
  const scale = info ? Math.min(available.width / info.width, available.height / info.height) : 1;
  const width = info ? info.width * scale : 1, height = info ? info.height * scale : 1;
  const { width: outputWidth, height: outputHeight } = info ? cropPixelSize(crop, info.width, info.height) : { width: 0, height: 0 };
  const adjustment = (label: string, value: number, min: number, max: number, update: (value: number) => void, step = .05) => <label className="block text-xs text-gray-300 space-y-1"><span className="flex justify-between gap-2"><span>{label}</span><span className="tabular-nums text-cyan-200">{value.toFixed(2)}</span></span><input type="range" aria-label={label} min={min} max={max} step={step} value={value} disabled={busy} onChange={event => update(Number(event.target.value))} className="w-full accent-cyan-400" /></label>;
  return <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="crop-heading" tabIndex={-1} className="fixed inset-0 z-50 flex flex-col bg-surface-900 text-gray-200 outline-none" data-testid="lightbox-crop-editor">
    <header className="flex-shrink-0 border-b border-surface-600 p-3 sm:px-5 flex items-center justify-between gap-3">
      <div className="min-w-0"><h2 id="crop-heading" className="text-lg font-semibold text-white">Crop photo</h2><p className="text-xs text-gray-400 truncate">{photo.original.name} · Original stays untouched</p></div>
      <button ref={cancel} type="button" className="btn-secondary text-xs min-h-11" onClick={onClose} disabled={busy}>Cancel <kbd aria-hidden="true" className="ml-2 text-gray-400">{shortcutFor("crop-close")}</kbd></button>
    </header>
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
      <div ref={area} className="relative flex-1 min-h-48 min-w-0 overflow-hidden bg-black flex items-center justify-center">
        {loading ? <span role="status" className="text-sm text-gray-400">Loading original crop preview…</span> : source && info ? <div ref={surface} style={{ width, height, touchAction: "none" }} className="relative flex-shrink-0 select-none" onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={() => { drag.current = null; }}>
          <img src={source} alt="Uncropped original for crop selection" draggable={false} className="absolute inset-0 w-full h-full pointer-events-none" />
          <div className="absolute border-2 border-white" data-testid="crop-selection" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%`, boxShadow: "0 0 0 9999px rgba(0,0,0,.65)", boxSizing: "border-box" }}>
            <button type="button" aria-label="Move crop selection" disabled={busy} className="absolute inset-0 w-full h-full cursor-move focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300" style={{ touchAction: "none" }} onPointerDown={event => begin(event, "move")} onKeyDown={event => nudge(event, "move")} />
            {[1 / 3, 2 / 3].map(at => <div key={`v${at}`} className="absolute top-0 bottom-0 border-l border-white/40 pointer-events-none" style={{ left: `${at * 100}%` }} />)}
            {[1 / 3, 2 / 3].map(at => <div key={`h${at}`} className="absolute left-0 right-0 border-t border-white/40 pointer-events-none" style={{ top: `${at * 100}%` }} />)}
            {handles.map(handle => <button key={handle.id} type="button" aria-label={`Crop ${handle.label}`} disabled={busy} className="absolute w-7 h-7 flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300" style={{ left: handle.left, top: handle.top, transform: "translate(-50%, -50%)", cursor: handle.cursor, touchAction: "none" }} onPointerDown={event => begin(event, handle.id)} onKeyDown={event => nudge(event, handle.id)}><span className="block w-3 h-3 bg-white border border-black rounded-sm shadow" /></button>)}
          </div>
        </div> : <span className="p-5 text-sm text-gray-400">Original preview unavailable</span>}
      </div>
      <aside className="lg:w-80 lg:flex-shrink-0 max-h-[38vh] lg:max-h-none overflow-y-auto border-t lg:border-t-0 lg:border-l border-surface-600 p-3 sm:p-4 space-y-4">
        <section className="space-y-3"><h3 className="text-sm font-medium text-white">Composition</h3><label className="block text-xs text-gray-400">Aspect ratio<select aria-label="Crop aspect ratio" value={ratioName} onChange={event => chooseRatio(event.target.value)} disabled={loading || busy} className="w-full mt-1 bg-surface-800 border border-surface-600 rounded-lg p-2 text-gray-100">{ratioOptions.map(name => <option key={name}>{name}</option>)}</select></label>
          {ratioName !== "Free" && ratioName !== "Original" && ratioName !== "Square" && <button type="button" className="btn-secondary text-xs w-full" disabled={busy} onClick={() => chooseRatio(ratioName, !portrait)}>Switch to {portrait ? "landscape" : "portrait"}</button>}
          <div className="rounded-lg border border-surface-600 p-2 text-xs space-y-1"><div aria-live="polite" className="text-cyan-200 tabular-nums" data-testid="crop-output-dimensions">{outputWidth.toLocaleString()} × {outputHeight.toLocaleString()} pixels</div><div className="text-gray-400">Full source pixels · no upscaling · JPEG quality 95</div></div>
          <button type="button" className="btn-secondary text-xs min-h-11" disabled={loading || busy} onClick={resetFullFrame}>Reset full frame <kbd aria-hidden="true" className="ml-2 text-gray-400">{shortcutFor("crop-reset")}</kbd></button>
          <p className="text-xs text-gray-400">Drag corners or edges. Drag inside to move. Focus a handle and use arrow keys for 1-pixel changes (Shift: 10 pixels).</p>
        </section>
        <section className="space-y-3 border-t border-surface-600 pt-3"><h3 className="text-sm font-medium text-white">Regenerate from this crop</h3><label className="flex gap-3 text-sm items-center min-h-11 rounded-lg border border-surface-600 px-2 cursor-pointer"><input className="w-6 h-6 accent-cyan-400 shrink-0" type="checkbox" checked={bw} disabled={busy || loading} onChange={event => setBw(event.target.checked)} />B&W crop version <kbd className="ml-auto text-xs text-gray-400">{shortcutFor("crop-bw")}</kbd></label><label className="flex gap-3 text-sm items-center min-h-11 rounded-lg border border-surface-600 px-2 cursor-pointer"><input className="w-6 h-6 accent-cyan-400 shrink-0" type="checkbox" checked={enhanced} disabled={busy || loading} onChange={event => setEnhanced(event.target.checked)} />Enhanced crop version <kbd className="ml-auto text-xs text-gray-400">{shortcutFor("crop-enhanced")}</kbd></label><p className="text-xs text-gray-400">Both start independently from the new crop. Existing original B&W/Enhanced files stay unchanged. Unchecked previous crop versions are cleared when the crop changes.</p>
          <details><summary className="text-xs text-cyan-200 cursor-pointer">Current Photo Process settings</summary><p className="text-xs text-gray-400 my-2">Uses your current saved settings, not a reconstruction of an older output's recipe. Changes here also become your Photo Process defaults.</p><div className="space-y-3">
            {adjustment("Crop enhancement contrast", recipe.enhanceContrastLevel, 0, 2, value => setRecipe(current => ({ ...current, enhanceContrastLevel: value })))}
            {adjustment("Crop enhancement sharpening", recipe.enhanceSharpnessLevel, 0, 1, value => setRecipe(current => ({ ...current, enhanceSharpnessLevel: value })))}
            {([ ["localContrast", "Crop B&W local contrast", 0, 1], ["sharpness", "Crop B&W sharpening", 0, 1], ["curveStrength", "Crop S-curve strength", 0, 1], ["shadowDepth", "Crop S-curve shadow depth", 0, .25], ["highlightLift", "Crop S-curve highlight lift", 0, .25], ["midpoint", "Crop S-curve midpoint", .25, .75] ] as const).map(([key, label, min, max]) => <div key={key}>{adjustment(label, recipe.bwParams[key], min, max, value => setRecipe(current => ({ ...current, bwParams: { ...current.bwParams, [key]: value } })), .01)}</div>)}
          </div></details>
        </section>
        <details ref={cropHelp} className="rounded-lg border border-surface-600 p-3 text-xs text-gray-300"><summary className="cursor-pointer text-cyan-200">Crop keyboard help <kbd className="ml-2">F1 / ?</kbd></summary><dl className="mt-3 space-y-2">{lightboxCropCommands.map(command => <div key={command.id}><dt className="font-medium text-gray-200">{command.label}</dt><dd className="text-gray-400">{command.keys.join(" / ")}</dd></div>)}</dl><p className="mt-3 text-gray-400">Tab reaches each handle and setting. Space toggles a focused checkbox; Enter activates a focused button. Main Lightbox rating and selection shortcuts are suspended here.</p></details>
      </aside>
    </div>
    <footer className="flex-shrink-0 border-t border-surface-600 p-3 sm:px-5 space-y-2">
      {error && <div role="alert" className="text-sm text-amber-200 whitespace-pre-wrap break-words">{error}<button type="button" className="btn-secondary text-xs ml-3" disabled={busy || loading} onClick={() => { void load(); }}>Reload original and reset selection</button></div>}
      <div className="flex items-center justify-between gap-3 flex-wrap"><p className="text-xs text-gray-400">Saves <strong className="text-gray-200">_crop.jpg</strong> beside the original. Re-editing always starts from the untouched original.</p><button type="button" className="btn-primary text-sm min-h-11" aria-label="Apply crop & regenerate" aria-busy={busy} disabled={loading || busy || !info || !source} onClick={() => { void apply(); }}>{busy ? "Saving crop and regenerating…" : <>Apply crop &amp; regenerate <kbd aria-hidden="true" className="ml-2 text-xs">{shortcutFor("crop-apply")}</kbd></>}</button></div>
    </footer>
  </div>;
}
