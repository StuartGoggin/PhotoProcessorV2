import { useEffect, useRef, useState } from "react";

interface ImagePanelProps {
  src: string | null; // data URL or blob URL
  label?: string;
  zoom?: number;
  onPan?: (dx: number, dy: number) => void;
  panX?: number;
  panY?: number;
  /** Actions are separate from the image so selecting a version never starts a pan. */
  headerAction?: React.ReactNode;
  active?: boolean;
  onActivate?: () => void;
  resetKey?: number;
  onReady?: () => void;
}

export default function ImagePanel({ src, label, zoom = 1, panX = 0, panY = 0, headerAction, active, onActivate, resetKey, onReady }: ImagePanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [localPanX, setLocalPanX] = useState(0);
  const [localPanY, setLocalPanY] = useState(0);
  const dragStart = useRef({ x: 0, y: 0, px: 0, py: 0 });

  // Reset pan when src changes
  useEffect(() => {
    setLocalPanX(0);
    setLocalPanY(0);
    setDragging(false);
  }, [src, resetKey]);

  const effectivePanX = panX + localPanX;
  const effectivePanY = panY + localPanY;

  function onMouseDown(e: React.MouseEvent) {
    if (zoom <= 1) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, px: localPanX, py: localPanY };
    e.preventDefault();
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!dragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setLocalPanX(dragStart.current.px + dx);
    setLocalPanY(dragStart.current.py + dy);
  }

  function onMouseUp() {
    setDragging(false);
  }

  return (
    <div className="relative flex flex-col h-full min-h-0"
      role={active === undefined ? undefined : "group"} aria-label={active === undefined ? undefined : `${label ?? "Photo"} image panel`}
      tabIndex={active === undefined ? undefined : 0} onFocusCapture={onActivate} onPointerDownCapture={onActivate}
      data-active={active === undefined ? undefined : active}>
      {active && <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 border-2 border-cyan-400" />}
      {label && (
        <div className="flex-shrink-0 flex flex-wrap items-center justify-between gap-1 text-xs text-gray-400 px-2 py-1 border-b border-surface-600 bg-surface-800">
          <span className={active ? "font-semibold text-cyan-200" : undefined}>{label}{active && <span className="ml-2 text-[10px] font-normal uppercase tracking-wide">Active</span>}</span>
          {headerAction}
        </div>
      )}
      <div
        ref={containerRef}
        className={`flex-1 overflow-hidden relative bg-black flex items-center justify-center ${
          zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default"
        }`}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        {src ? (
          <img
            src={src}
            alt={label}
            draggable={false}
            onLoad={onReady}
            style={{
              transform: `scale(${zoom}) translate(${effectivePanX / zoom}px, ${effectivePanY / zoom}px)`,
              transformOrigin: "center center",
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              userSelect: "none",
              transition: dragging ? "none" : "transform 0.1s ease",
            }}
          />
        ) : (
          <div className="text-gray-600 text-sm flex flex-col items-center gap-2">
            <span className="text-4xl">🖼️</span>
            <span>No image</span>
          </div>
        )}
      </div>
    </div>
  );
}
