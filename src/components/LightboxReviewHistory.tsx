import type {ReviewHistory} from "../types/reviewActions";

export default function LightboxReviewHistory({history,error,loading,onMore,onRefresh}:{history:ReviewHistory|null;error:string;loading:boolean;onMore:()=>void;onRefresh:()=>void}){
  return <section aria-label="Trash and Restore history" className="border-b border-surface-600 bg-surface-800 px-3 py-3 text-xs text-gray-300">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-white">Trash and Restore history</h2><p className="mt-1 text-gray-400">Retained with this staging folder. Undo covers Trash / Restore and its Reviewed flag.</p></div><button type="button" className="btn-secondary min-h-11 text-xs" disabled={loading} onClick={onRefresh}>Refresh history</button></div>
    {error&&<p role="status" className="text-amber-200 mt-2">History unavailable: {error}</p>}
    {history?.warnings.map((warning,index)=><p key={index} role="status" className="text-amber-200 mt-2">{warning}</p>)}
    <ol className="max-h-52 overflow-auto mt-2 divide-y divide-surface-600">{history?.entries.map(entry=><li key={entry.id} className="py-2 flex flex-wrap justify-between gap-2"><span className="break-all">{entry.label||entry.capturePath}</span><span className={entry.outcome==="saved"?"text-cyan-200":"text-amber-200"}>{entry.outcome==="permanently_removed"?"Files permanently removed · Undo unavailable":entry.outcome==="blocked"?"Replay blocked · source changed":entry.afterTrashed?"Trashed":"Restored"}{entry.canUndo?" · can Undo":entry.canRedo?" · can Redo":""}</span></li>)}</ol>
    {loading&&<p role="status">Loading history…</p>}
    {history&&!history.total&&!loading&&<p className="mt-2 text-gray-400">No saved Trash or Restore decisions in this folder yet.</p>}
    {history?.nextOffset!=null&&<button type="button" className="btn-secondary min-h-11 text-xs mt-2" disabled={loading} onClick={onMore}>Load older decisions ({history.entries.length} of {history.total})</button>}
  </section>;
}
