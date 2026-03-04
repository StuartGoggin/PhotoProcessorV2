import { useEffect } from "react";
import { useReview } from "../hooks";
import { FileTree, ImagePanel, StarRating } from "../components";

export default function Review() {
  const {
    tree, selected, siblings, siblingIdx, images,
    zoom, loading, trashed, stars, stagingDir,
    refreshTree, selectNode, handleStars, handleTrash, navigate, setZoom,
  } = useReview();

  // Keyboard navigation — stable handlers via the hook
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight") navigate(1);
      else if (e.key === "ArrowLeft") navigate(-1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(5, z + 0.25));
      else if (e.key === "-") setZoom((z) => Math.max(0.25, z - 0.25));
      else if (e.key === "0") setZoom(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, setZoom]);

  // Separate effect for state-dependent key handlers (stars/trash)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Delete") handleTrash();
      else if (e.key === "1") handleStars(1);
      else if (e.key === "2") handleStars(2);
      else if (e.key === "3") handleStars(3);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // intentionally no deps — needs latest handler each render

  return (
    <div className="flex h-full">
      {/* File tree panel */}
      <div className="w-56 flex-shrink-0 bg-surface-800 border-r border-surface-600 flex flex-col">
        <div className="px-3 py-2 border-b border-surface-600 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-300">Files</span>
          <button
            className="text-xs text-gray-500 hover:text-gray-300"
            onClick={() => refreshTree()}
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
        <div className="flex-shrink-0 bg-surface-800 border-b border-surface-600 px-4 py-2 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <button
              className="btn-secondary py-1 px-2 text-xs"
              onClick={() => navigate(-1)}
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
              <div className="ml-2">
                <StarRating value={stars} onChange={handleStars} />
              </div>
              <button
                className={`py-1 px-3 text-xs rounded-lg font-medium transition-colors ${
                  trashed ? "bg-red-700 text-white hover:bg-red-600" : "btn-secondary"
                }`}
                onClick={handleTrash}
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

        {/* 3-panel image display */}
        <div className="flex-1 flex min-h-0">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-gray-500">Loading...</div>
          ) : (
            <>
              <div className="flex-1 border-r border-surface-700 min-w-0">
                <ImagePanel src={images.original} label="Original" zoom={zoom} />
              </div>
              <div className="flex-1 border-r border-surface-700 min-w-0">
                <ImagePanel src={images.bw} label="B&W" zoom={zoom} />
              </div>
              <div className="flex-1 min-w-0">
                <ImagePanel src={images.improved} label="Enhanced" zoom={zoom} />
              </div>
            </>
          )}
        </div>

        {/* Status bar */}
        <div className="flex-shrink-0 bg-surface-800 border-t border-surface-600 px-4 py-1.5 flex items-center gap-6 text-xs text-gray-500">
          <span>← → navigate</span>
          <span>+ − zoom</span>
          <span>0 reset zoom</span>
          <span>Del trash</span>
          <span>1/2/3 stars</span>
        </div>
      </div>
    </div>
  );
}
