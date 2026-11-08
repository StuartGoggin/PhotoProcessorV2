import { useEffect, useRef, useState } from "react";
import RawDevelopment from "./RawDevelopment";

/** A pinned, one-photo entry into the existing developer and core Jobs. */
export default function LightboxRawEditor({ root, path, cameraJpeg, onClose, onOpenJobs }: {
  root: string; path: string; cameraJpeg?: string; onClose: (refresh: boolean) => void; onOpenJobs?: (id: string) => void;
}) {
  const [block, setBlock] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const busy = !!block && !block.includes("unsaved");
  function close(refresh: boolean) {
    if (busy) return false;
    if (block && !window.confirm("Discard this photo's unsaved RAW recipe edits? Queued jobs and saved recipes are kept.")) return false;
    onClose(refresh);
    return true;
  }
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);
  return <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3" onClick={event => event.stopPropagation()}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="Develop RAW alternative" className="w-full max-w-6xl max-h-[94vh] overflow-auto bg-surface-900 border border-surface-600 rounded-xl shadow-2xl p-4" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(false); }
      if (event.key === "Tab") {
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') ?? [])].filter(node => node.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="flex gap-3 items-center mb-3"><div className="mr-auto"><h2 className="font-semibold text-lg text-white">Develop RAW alternative</h2><p className="text-xs text-gray-400 break-all">{path.split(/[\\/]/).pop()} · Camera JPEG and existing review decisions are kept</p></div><button className="btn-secondary min-h-11 text-xs" disabled={busy} onClick={() => close(false)}>Return to Lightbox</button></div>
      <RawDevelopment stagingDir={root} scopeDir={path.replace(/[\\/][^\\/]+$/, "")} scopeMode="folderOnly" singlePhoto initialPath={path} cameraJpegPath={cameraJpeg} onNamingBlockChange={setBlock} onQueued={setJob} />
      {job && <div role="status" className="text-sm text-cyan-200 rounded border border-surface-600 p-3">Queued in Jobs. Wait for completion, then refresh the Lightbox to compare the result. Developing does not automatically choose a finish or upload it.{onOpenJobs && <button className="btn-secondary min-h-11 text-xs ml-3" disabled={busy} onClick={() => { if (close(false)) onOpenJobs(job); }}>Open Jobs</button>}<button className="btn-secondary min-h-11 text-xs ml-3" disabled={busy} onClick={() => close(true)}>Refresh finished outputs</button></div>}
    </div>
  </div>;
}
