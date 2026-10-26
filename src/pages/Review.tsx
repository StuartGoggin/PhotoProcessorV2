import { useEffect, useRef, useState } from "react";
import { useReview, type ReviewContext } from "../hooks/useReview";
import { FileTree, ImagePanel, StarRating } from "../components";
import LightboxCropEditor from "../components/LightboxCropEditor";
import LightboxHelp from "../components/LightboxHelp";
import LightboxVersionControls from "../components/LightboxVersionControls";
import { useGooglePhotoCuration } from "../hooks/useGooglePhotoCuration";
import { lightboxCommands, lightboxTypingTarget, matchLightboxCommand, shortcutFor, type LightboxCommandId } from "../utils/lightboxCommands";

const emptyPan = () => [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
const frameId = (context?: ReviewContext) => context ? JSON.stringify([context.root, context.path, context.epoch, context.cropped]) : "";
const panelNames = ["Original", "B&W", "Enhanced"];

export default function Review() {
  const review = useReview();
  const { tree, selected, siblings, siblingIdx, images, zoom, loading, trashed, stars, error, renaming,
    stagingDir, cropped, selectedPhoto, catalogueRevision } = review;
  const [cropOpen, setCropOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [cropMessage, setCropMessage] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const actionBusy = useRef(false), alive = useRef(true);
  const modal = useRef({ crop: false, help: false });
  const reviewRoot = useRef<HTMLDivElement>(null);
  const [activePanel, setActivePanel] = useState(0);
  const active = useRef(0);
  const [visibleFrame, setVisibleFrame] = useState("");
  const visible = useRef("");
  const [pan, setPan] = useState({ frame: "", offsets: emptyPan() });
  const panRef = useRef(pan);
  const [resetKey, setResetKey] = useState(0);
  const curation = useGooglePhotoCuration(catalogueRevision ? stagingDir : "", catalogueRevision);
  const version = cropped && selectedPhoto?.crop ? selectedPhoto.crop : selectedPhoto;
  const snapshot = review.getSnapshot();
  const renderContext = snapshot?.context.path === selected?.path && snapshot?.context.root === stagingDir ? snapshot.context : undefined;
  const renderFrame = frameId(renderContext);
  const ready = !!renderFrame && visibleFrame === renderFrame && !loading && review.isReady();
  const renderedImages = [images.original, images.bw, images.improved];
  const disabled = busy || renaming || !ready || curation.saving;
  const editable = !!selected && /\.jpe?g$/i.test(selected.name) && !/_(crop|bw|improved)(?:\{[^}]+\})*\.jpe?g$/i.test(selected.name);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setFeedback(""); }, [renderFrame]);
  useEffect(() => {
    if (!loading && renderedImages.some(Boolean) && !renderedImages[active.current]) {
      const first = renderedImages.findIndex(Boolean); active.current = first; setActivePanel(first);
    }
  }, [loading, images.original, images.bw, images.improved]);
  modal.current = { crop: cropOpen, help: helpOpen };

  function focusReview() {
    if (alive.current && !modal.current.crop && !modal.current.help) reviewRoot.current?.focus({ preventScroll: true });
  }
  function activate(index: number) {
    if (actionBusy.current) return;
    active.current = index; setActivePanel(index);
  }
  function openCrop() { modal.current.crop = true; setCropOpen(true); }
  function closeCrop() { modal.current.crop = false; setCropOpen(false); }
  function markVisible(context?: ReviewContext) {
    if (!context || !review.isContextCurrent(context)) return;
    visible.current = frameId(context); setVisibleFrame(visible.current);
  }
  function inspectable() {
    const current = review.getSnapshot();
    return current && review.isReady() && visible.current === frameId(current.context) ? current : null;
  }

  async function execute(id: LightboxCommandId, desired?: boolean) {
    if (!alive.current || modal.current.crop || modal.current.help || actionBusy.current) return;
    if (id === "help") { modal.current.help = true; setHelpOpen(true); return; }
    const selectionCommand = id.startsWith("select-") || id.startsWith("favourite-");
    const inspection = id.startsWith("panel-") || id.startsWith("zoom-") || id.startsWith("pan-") || id === "fit";
    if (curation.hasPending() && !selectionCommand && !inspection) {
      setFeedback("Wait for the pending selections to finish saving before changing photos or files."); return;
    }
    if (id === "previous" || id === "next") {
      setFeedback("");
      if (await review.navigate(id === "previous" ? -1 : 1)) focusReview();
      return;
    }
    if (id === "first" || id === "last") {
      setFeedback(""); if (await review.navigateToEdge(id)) focusReview(); return;
    }
    if (id === "refresh") {
      setFeedback("");
      if (await review.refreshTree()) { void curation.refresh(); focusReview(); }
      return;
    }
    const current = inspectable();
    if (!current) { setFeedback("Wait for this photo to finish loading before reviewing it."); return; }
    const { context, photo } = current;
    const currentVersion = context.cropped && photo.crop ? photo.crop : photo;
    const nodes = [currentVersion.original, currentVersion.bw, currentVersion.improved];

    if (id === "panel-previous" || id === "panel-next") {
      const step = id === "panel-next" ? 1 : -1;
      let index = active.current;
      for (let attempt = 0; attempt < 3; attempt++) {
        index = (index + step + 3) % 3;
        if (nodes[index] && renderedImages[index]) { activate(index); break; }
      }
      return;
    }
    if (id === "zoom-in" || id === "zoom-out") {
      review.setZoom(value => Math.max(.25, Math.min(5, value + (id === "zoom-in" ? .25 : -.25)))); return;
    }
    if (id === "fit") {
      review.setZoom(1); const next = { frame: frameId(context), offsets: emptyPan() };
      panRef.current = next; setPan(next); setResetKey(value => value + 1); return;
    }
    if (id.startsWith("pan-")) {
      if (zoom <= 1) return;
      const next = { frame: frameId(context), offsets: (panRef.current.frame === frameId(context) ? panRef.current.offsets : emptyPan()).map(offset => ({ ...offset })) };
      const amount = 48;
      next.offsets[active.current].x += id === "pan-left" ? -amount : id === "pan-right" ? amount : 0;
      next.offsets[active.current].y += id === "pan-up" ? -amount : id === "pan-down" ? amount : 0;
      panRef.current = next; setPan(next); return;
    }
    if (id === "crop") { if (editable) openCrop(); else setFeedback("Cropping supports JPEG originals; this photo is not editable here."); return; }
    if (id === "crop-version") {
      if (photo.crop && await review.setCropVersion(!context.cropped)) focusReview();
      else if (!photo.crop) setFeedback("This original does not have a cropped version.");
      return;
    }

    const mutating = id.startsWith("rate-") || id === "clear-rating" || id === "trash" || id === "trash-next"
      || id.startsWith("select-") || id.startsWith("favourite-");
    if (!mutating) return;
    const sequential = !selectionCommand || id === "select-active-next";
    if (sequential) { actionBusy.current = true; setBusy(true); }
    setFeedback("");
    try {
      let saved = false;
      if (id.startsWith("rate-")) saved = await review.handleStars(Number(id.split("-")[1]), id.endsWith("-next"));
      else if (id === "clear-rating") saved = await review.handleStars(0);
      else if (id === "trash" || id === "trash-next") saved = await review.handleTrash(id === "trash-next" ? true : undefined, id === "trash-next");
      else {
        const index = id.includes("active") ? active.current : id.endsWith("original") ? 0 : id.endsWith("bw") ? 1 : 2;
        const node = nodes[index];
        if (!node || curation.loading) {
          setFeedback(node ? "Wait for this version's saved selections to load." : "That version is unavailable for this photo."); return;
        }
        const asset = curation.assetForPath(node.path);
        if (!asset) { setFeedback("Saved selections are unavailable for that exact version. Retry selections."); return; }
        activateDuringSave(index);
        saved = await curation.update(asset, id.startsWith("favourite-")
          ? { favourite: desired ?? !asset.favourite }
          : { selected: id === "select-active-next" ? true : desired ?? !asset.selected });
        if (saved && id === "select-active-next") saved = await review.advanceFromContext(context);
      }
      if (sequential && alive.current && review.isContextCurrent(context)) {
        setFeedback(saved ? "Saved" : "Review did not advance. Check the error or reload this photo before retrying.");
      }
    } catch (reason) {
      if (alive.current && review.getSnapshot()?.context.root === context.root) setFeedback("Review was not completed: " + String(reason));
    } finally {
      if (sequential) {
        actionBusy.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }
  function activateDuringSave(index: number) { active.current = index; setActivePanel(index); }
  const executeLatest = useRef(execute); executeLatest.current = execute;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || modal.current.crop || modal.current.help) return;
      const command = matchLightboxCommand(event);
      if (!command) return;
      if (lightboxTypingTarget(event.target) && event.key !== "F1") return;
      if (event.target instanceof HTMLElement && event.target.closest('[role="tree"]') && command.id !== "help") return;
      event.preventDefault();
      if (event.repeat && !command.repeat) return;
      void executeLatest.current(command.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const button = (id: LightboxCommandId, label: string, unavailable = false) => <button type="button" className="btn-secondary min-h-11 px-3 text-xs" title={lightboxCommands.find(command => command.id === id)?.label + " (" + shortcutFor(id) + ")"}
    disabled={busy || renaming || unavailable} onClick={() => void execute(id)}>{label}</button>;
  function controls(index: number) {
    const node = [version?.original, version?.bw, version?.improved][index];
    if (!node) return undefined;
    const label = index === 0 && cropped ? "Cropped" : index === 1 && cropped ? "Cropped B&W" : index === 2 && cropped ? "Cropped Enhanced" : panelNames[index];
    const selectIds = ["select-original", "select-bw", "select-enhanced"] as const;
    const favouriteIds = ["favourite-original", "favourite-bw", "favourite-enhanced"] as const;
    const asset = curation.assetForPath(node.path);
    return <LightboxVersionControls label={label} shortcut={shortcutFor(selectIds[index])} favouriteShortcut={shortcutFor(favouriteIds[index])}
      asset={asset ?? null} loading={curation.loading} disabled={busy || renaming || !ready}
      saving={curation.pendingFor(asset?.id)} error={curation.errorFor(asset?.id)}
      onSelected={value => void execute(selectIds[index], value)} onFavourite={() => void execute(favouriteIds[index])} />;
  }

  return <div className="review-layout flex h-full min-w-0">
    <div className="review-file-tree w-56 min-h-0 flex-shrink-0 bg-surface-800 border-r border-surface-600 flex flex-col">
      <div className="px-3 py-2 border-b border-surface-600 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-gray-300" title="Originals only; generated versions appear in comparison panels">Original photos</span>
        <button className="min-h-11 min-w-11 text-gray-400" disabled={busy || renaming} onClick={() => void execute("refresh")} title="Refresh photos (R)" aria-label="Refresh photos">↺</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <FileTree nodes={tree} keyboardNavigation disabled={busy || renaming || curation.saving} selected={selected?.path}
          onSelect={node => { if (!actionBusy.current && !curation.hasPending()) void review.selectNode(node).then(shown => { if (shown) focusReview(); }); }} />
      </div>
    </div>
    <div ref={reviewRoot} tabIndex={-1} aria-label="Photo Lightbox review" className="flex-1 flex flex-col min-w-0 outline-none">
      <div className="flex-shrink-0 bg-surface-800 border-b border-surface-600 px-3 py-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <button className="btn-secondary min-h-11 min-w-11 text-sm" aria-label="Previous original photo" disabled={busy || renaming || curation.saving || siblingIdx <= 0} onClick={() => void execute("previous")} title="Previous original (←)">←</button>
          <span className="text-xs text-gray-400 tabular-nums">{siblings.length ? String(siblingIdx + 1) + " / " + siblings.length : "—"}</span>
          <button className="btn-secondary min-h-11 min-w-11 text-sm" aria-label="Next original photo" disabled={busy || renaming || curation.saving || !siblings.length || siblingIdx >= siblings.length - 1} onClick={() => void execute("next")} title="Next original (→)">→</button>
        </div>
        <div className="flex items-center gap-1">
          {button("zoom-out", "−", !ready)}<span className="text-xs text-gray-400 w-10 text-center">{Math.round(zoom * 100)}%</span>{button("zoom-in", "+", !ready)}{button("fit", "Fit", !ready)}
        </div>
        {selected && <>
          {button("crop", "Crop", disabled || !editable)}
          {selectedPhoto?.crop && <div role="group" aria-label="Photo version" className="flex gap-1">
            <button type="button" className="btn-secondary min-h-11 px-3 text-xs" disabled={disabled} aria-pressed={!cropped} onClick={() => { if (cropped) void execute("crop-version"); }}>Original</button>
            <button type="button" className="btn-secondary min-h-11 px-3 text-xs" disabled={disabled} aria-pressed={cropped} onClick={() => { if (!cropped) void execute("crop-version"); }}>Cropped</button>
          </div>}
          <StarRating value={stars} comfortable readonly={disabled} onChange={value => void execute(value === 0 ? "clear-rating" : value === 1 ? "rate-1" : value === 2 ? "rate-2" : "rate-3")} />
          <button className={"min-h-11 px-3 text-xs rounded-lg font-medium " + (trashed ? "bg-red-700 text-white" : "btn-secondary")} disabled={disabled} onClick={() => void execute("trash")} title="Toggle trash tag only; no files are deleted (Delete)">{trashed ? "✗ Trashed" : "🗑 Trash"}</button>
        </>}
        <button type="button" className="btn-secondary min-h-11 px-3 text-xs ml-auto" disabled={busy} onClick={() => void execute("help")} aria-label="Keyboard and controller help" title="Keyboard & Controller Help (F1 / ?)">⌨ Keys & controller</button>
      </div>
      {selected && <div className="px-3 py-1.5 bg-surface-800 text-xs text-gray-400 flex flex-wrap items-center gap-2 border-b border-surface-700">
        <span className="truncate flex-1 min-w-0" title={selected.name}>{selected.name}</span>
        <span className="text-cyan-200">Active: {activePanel === 0 && cropped ? "Cropped" : panelNames[activePanel]}</span>
        <span role="status" aria-live="polite" className={busy ? "text-amber-200" : "text-cyan-200"}>{busy ? "Saving decision…" : curation.saving ? "Saving selections… wait before closing" : feedback || (ready ? "Ready to review" : "Loading photo…")}</span>
      </div>}
      {error && <div role="status" className="px-4 py-2 text-xs text-amber-200 bg-surface-800">{error}</div>}
      {curation.error && <div role="status" className="px-4 py-2 text-xs text-amber-200 bg-surface-800 flex items-center justify-between gap-3"><span>{curation.error} Photos remain available for review.</span><button className="btn-secondary min-h-11 px-2 text-xs" disabled={busy} onClick={() => void curation.refresh(true)}>Reload selections</button></div>}
      {curation.warnings.length > 0 && <details className="px-4 py-2 text-xs text-amber-200 bg-surface-800"><summary className="cursor-pointer">Upload selection notes ({curation.warnings.length})</summary><ul className="mt-1 ml-4 list-disc">{curation.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      {cropMessage && <div role="status" className="px-4 py-2 text-xs text-cyan-100 bg-surface-800 flex gap-3 justify-between"><span>{cropMessage}</span><button type="button" aria-label="Dismiss crop result" onClick={() => setCropMessage("")}>×</button></div>}
      <div className="review-images flex-1 flex min-h-0">
        {loading ? <div className="flex-1 flex items-center justify-center text-gray-500">Loading...</div> : renderedImages.map((src, index) => {
          const offset = pan.frame === renderFrame ? pan.offsets[index] : { x: 0, y: 0 };
          return <div key={index} className={"flex-1 min-w-0 " + (index < 2 ? "border-r border-surface-700" : "")}>
            <ImagePanel key={renderFrame + "-" + index} src={src} label={index === 0 && cropped ? "Cropped" : panelNames[index]} zoom={zoom}
              panX={offset.x} panY={offset.y} resetKey={resetKey} active={activePanel === index}
              onActivate={() => activate(index)} onReady={() => markVisible(renderContext)} headerAction={controls(index)} />
          </div>;
        })}
      </div>
      <div className="flex-shrink-0 bg-surface-800 border-t border-surface-600 px-3 py-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-400">
        <span>← → browse originals</span><span>1 / 2 / 3 rate · Shift: save & next</span><span>Q / W / E select versions</span>
        <span>[ ] active panel · A toggle · G select & next</span><span>C crop · 0 fit · F1 help</span>
        <span>Selections are saved locally · publish from Transfer</span>
      </div>
    </div>
    {helpOpen && <LightboxHelp onClose={() => { modal.current.help = false; setHelpOpen(false); }} />}
    {cropOpen && selectedPhoto && <LightboxCropEditor stagingDir={stagingDir} photo={selectedPhoto}
      onClose={() => { closeCrop(); void review.refreshTree(); }}
      onSaved={result => {
        closeCrop(); void review.refreshTree(undefined, true);
        setCropMessage("Saved crop (" + result.width.toLocaleString() + " × " + result.height.toLocaleString() + " pixels). Original unchanged." + (result.errors.length ? " Regeneration needs attention: " + result.errors.join("; ") : " Cropped view is ready."));
      }} />}
  </div>;
}
