import { useEffect, useState } from "react";
import { useReview } from "../hooks";
import { FileTree, ImagePanel, StarRating } from "../components";
import LightboxCropEditor from "../components/LightboxCropEditor";
import { useGooglePhotoCuration } from "../hooks/useGooglePhotoCuration";
import { googlePhotoAssetForPath } from "../utils/googlePhotos";
import type { GooglePhotoAsset } from "../types/googlePhotos";

export default function Review() {
  const {
    tree, selected, siblings, siblingIdx, images,
    zoom, loading, trashed, stars, error, renaming,
    stagingDir, cropped, selectedPhoto, catalogueRevision, setCropVersion,
    refreshTree, selectNode, handleStars, handleTrash, navigate, setZoom,
  } = useReview();
  const [cropOpen, setCropOpen] = useState(false);
  const [cropMessage, setCropMessage] = useState("");
  const curation = useGooglePhotoCuration(catalogueRevision ? stagingDir : "", catalogueRevision);
  const version = cropped && selectedPhoto?.crop ? selectedPhoto.crop : selectedPhoto;
  function uploadControls(path: string | undefined, label: string) {
    if (!path) return undefined;
    const asset = googlePhotoAssetForPath(curation.assets, path);
    if (!asset) return <span title={curation.error || "Loading this version's saved upload selection"} className="text-[10px] text-gray-500">{curation.loading ? "Loading selection…" : "Selection unavailable"}</span>;
    return <div className="flex items-center gap-2 text-[10px]">
      <label className="flex items-center gap-1 cursor-pointer" title="Select this exact version for the Google Photos publish review. This does not upload it.">
        <input type="checkbox" checked={asset.selected} disabled={curation.saving || renaming} aria-label={`Upload ${label} to Google Photos`} onChange={event => void curation.update(asset, { selected: event.target.checked })} />
        Google Photos
      </label>
      <button type="button" aria-label={`Favourite ${label}`} aria-pressed={asset.favourite} disabled={curation.saving || renaming} title="Favourite this version for the Google Photos favourites filter" className={asset.favourite ? "text-amber-300" : "text-gray-500"} onClick={() => void curation.update(asset as GooglePhotoAsset, { favourite: !asset.favourite })}>{asset.favourite ? "★" : "☆"}</button>
      {asset.uploadStatus && <span title="Previously uploaded to the connected account. Review a publish plan to recheck current bytes and metadata; this badge alone does not prove the file is unchanged." className="text-cyan-200">{asset.uploadStatus === "uploaded_previously" ? "Uploaded previously" : asset.uploadStatus.replace(/_/g, " ")}</span>}
    </div>;
  }
  const editable = !!selected && /\.jpe?g$/i.test(selected.name) && !/_(crop|bw|improved)(?:\{[^}]+\})*\.jpe?g$/i.test(selected.name);
  const shortcutsBlocked = (event: KeyboardEvent) => cropOpen || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof HTMLElement && !!event.target.closest("input, select, textarea, [contenteditable=true]"));

  // Keyboard navigation — stable handlers via the hook
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (shortcutsBlocked(e)) return;
      if (e.key.toLowerCase() === "c" && editable && !loading && !renaming) { e.preventDefault(); setCropOpen(true); return; }
      if (e.key === "ArrowRight") navigate(1);
      else if (e.key === "ArrowLeft") navigate(-1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(5, z + 0.25));
      else if (e.key === "-") setZoom((z) => Math.max(0.25, z - 0.25));
      else if (e.key === "0") setZoom(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, setZoom, cropOpen, editable, loading, renaming]);

  // Separate effect for state-dependent key handlers (stars/trash)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (shortcutsBlocked(e)) return;
      if (e.key === "Delete") handleTrash();
      else if (e.key === "1") handleStars(1);
      else if (e.key === "2") handleStars(2);
      else if (e.key === "3") handleStars(3);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // intentionally no deps — needs latest handler each render

  return (
    <div className="review-layout flex h-full min-w-0">
      {/* File tree panel */}
      <div className="review-file-tree w-56 min-h-0 flex-shrink-0 bg-surface-800 border-r border-surface-600 flex flex-col">
        <div className="px-3 py-2 border-b border-surface-600 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-300" title="Original photos only; processed versions appear in the comparison panels">Original photos</span>
          <button
            className="text-xs text-gray-500 hover:text-gray-300"
            onClick={() => refreshTree()}
            title="Refresh photos and reload comparison versions"
            aria-label="Refresh photos"
          >
            ↺
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <FileTree nodes={tree} onSelect={selectNode} selected={selected?.path} />
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="flex-shrink-0 bg-surface-800 border-b border-surface-600 px-4 py-2 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <button
              className="btn-secondary py-1 px-2 text-xs"
              onClick={() => navigate(-1)}
              aria-label="Previous original photo"
              disabled={siblingIdx <= 0}
            >
              ←
            </button>
            <span className="text-xs text-gray-400">
              {siblings.length > 0 ? `${siblingIdx + 1} / ${siblings.length}` : "—"}
            </span>
            <button
              className="btn-secondary py-1 px-2 text-xs"
              onClick={() => navigate(1)}
              aria-label="Next original photo"
              disabled={siblingIdx >= siblings.length - 1}
            >
              →
            </button>
          </div>

          <div className="flex items-center gap-2 ml-2">
            <button className="btn-secondary py-1 px-2 text-xs" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>−</button>
            <span className="text-xs text-gray-400 w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button className="btn-secondary py-1 px-2 text-xs" onClick={() => setZoom((z) => Math.min(5, z + 0.25))}>+</button>
            <button className="btn-secondary py-1 px-2 text-xs" onClick={() => setZoom(1)}>1:1</button>
          </div>

          {selected && (
            <>
              <button type="button" className="btn-secondary py-1 px-3 text-xs" disabled={!editable || loading || renaming} onClick={() => setCropOpen(true)} title={editable ? "Crop from the untouched original (C)" : "Cropping supports JPEG originals, not RAW/PNG or generated variants"}>Crop</button>
              {selectedPhoto?.crop && <div role="group" aria-label="Photo version" className="flex gap-1">
                <button type="button" className={`py-1 px-2 text-xs rounded ${!cropped ? "bg-cyan-900 text-cyan-100" : "btn-secondary"}`} aria-pressed={!cropped} onClick={() => setCropVersion(false)}>Original</button>
                <button type="button" className={`py-1 px-2 text-xs rounded ${cropped ? "bg-cyan-900 text-cyan-100" : "btn-secondary"}`} aria-pressed={cropped} onClick={() => setCropVersion(true)}>Cropped</button>
              </div>}
              <div className="ml-2" style={{ pointerEvents: renaming ? "none" : undefined }}>
                <StarRating value={stars} onChange={handleStars} />
              </div>
              <button
                className={`py-1 px-3 text-xs rounded-lg font-medium transition-colors ${
                  trashed ? "bg-red-700 text-white hover:bg-red-600" : "btn-secondary"
                }`}
                onClick={handleTrash}
                disabled={renaming}
              >
                {trashed ? "✗ Trashed" : "🗑 Trash"}
              </button>
            </>
          )}

          {selected && (
            <span className="ml-auto text-xs text-gray-500 truncate max-w-xs">
              {selected.name}
            </span>
          )}
        </div>

        {error && <div role="status" className="px-4 py-2 text-xs text-amber-200 bg-surface-800">{error}</div>}
        {curation.error && <div role="status" className="px-4 py-2 text-xs text-amber-200 bg-surface-800 flex items-center justify-between gap-3"><span>{curation.error} Photos remain available for review.</span><button className="btn-secondary py-1 px-2 text-xs" onClick={() => void curation.refresh()}>Retry selections</button></div>}
        {curation.warnings.length > 0 && <details className="px-4 py-2 text-xs text-amber-200 bg-surface-800"><summary className="cursor-pointer">Upload selection notes ({curation.warnings.length})</summary><ul className="mt-1 ml-4 list-disc">{curation.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
        {cropMessage && <div role="status" className="px-4 py-2 text-xs text-cyan-100 bg-surface-800 flex gap-3 justify-between"><span>{cropMessage}</span><button type="button" aria-label="Dismiss crop result" onClick={() => setCropMessage("")}>×</button></div>}
        {/* 3-panel image display */}
        <div className="review-images flex-1 flex min-h-0">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-gray-500">Loading...</div>
          ) : (
            <>
              <div className="flex-1 border-r border-surface-700 min-w-0">
                <ImagePanel src={images.original} label={cropped ? "Cropped" : "Original"} zoom={zoom} headerAction={uploadControls(version?.original.path, cropped ? "Cropped" : "Original")} />
              </div>
              <div className="flex-1 border-r border-surface-700 min-w-0">
                <ImagePanel src={images.bw} label="B&W" zoom={zoom} headerAction={uploadControls(version?.bw?.path, cropped ? "Cropped B&W" : "B&W")} />
              </div>
              <div className="flex-1 min-w-0">
                <ImagePanel src={images.improved} label="Enhanced" zoom={zoom} headerAction={uploadControls(version?.improved?.path, cropped ? "Cropped Enhanced" : "Enhanced")} />
              </div>
            </>
          )}
        </div>

        {/* Status bar */}
        <div className="flex-shrink-0 bg-surface-800 border-t border-surface-600 px-4 py-1.5 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-500">
          <span>← → navigate</span>
          <span>Originals only · bounded read-ahead</span>
          <span>+ − zoom</span>
          <span>0 reset zoom</span>
          <span>Del trash</span>
          <span>1/2/3 stars</span>
          <span>C crop · original untouched</span>
          <span>Google Photos checks are saved · publish from Transfer</span>
        </div>
      </div>
      {cropOpen && selectedPhoto && <LightboxCropEditor stagingDir={stagingDir} photo={selectedPhoto} onClose={() => { setCropOpen(false); refreshTree(); }} onSaved={result => {
        setCropOpen(false); refreshTree(undefined, true);
        setCropMessage(`Saved crop (${result.width.toLocaleString()} × ${result.height.toLocaleString()} pixels). Original unchanged.${result.errors.length ? ` Regeneration needs attention: ${result.errors.join("; ")}` : " Cropped view is ready."}`);
      }} />}
    </div>
  );
}
