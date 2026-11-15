import {useEffect,useMemo,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";

type Action="remove"|"dismiss";
type Entry={kind:string;id:string;title:string;status:string;createdAt:string;revision:string;canRemove:boolean;canDismiss:boolean;reason:string};
type Preview={entries:Entry[];warnings:string[]};
type Summary={removed:number;dismissed:number;protected:number;failed:number;messages:string[]};
const key=(entry:Entry)=>`${entry.kind}:${entry.id}`;

/** Review/apply delegates safety to each existing native executor. */
export default function JobCleanup({onChanged}:{onChanged:()=>Promise<void>}){
  const [open,setOpen]=useState(false),[preview,setPreview]=useState<Preview|null>(null);
  const [age,setAge]=useState("all"),[kind,setKind]=useState("all");
  const [selected,setSelected]=useState<Set<string>>(new Set()),[actions,setActions]=useState<Record<string,Action>>({});
  const [statusFilter,setStatusFilter]=useState("all");
  const [ack,setAck]=useState(false),[phase,setPhase]=useState<""|"loading"|"applying">("");
  const [error,setError]=useState(""),[result,setResult]=useState<Summary|null>(null);
  const dialog=useRef<HTMLDialogElement>(null),epoch=useRef(0),pending=useRef(false);
  useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal();},[open]);
  useEffect(()=>()=>{epoch.current++;},[]);
  const visible=useMemo(()=>{const cutoff=Date.now()-Number(age)*86400000;return (preview?.entries??[]).filter(e=>
    (kind==="all"||e.kind===kind)&&(statusFilter==="all"||(statusFilter==="attention"&&["needs_attention","failed","aborted","cancelled","interrupted","protected"].includes(e.status))||(statusFilter==="finished"&&["completed","completed_with_warnings","retried","archived"].includes(e.status))||(statusFilter==="paused"&&e.status==="paused")||(statusFilter==="dismissed"&&e.status==="dismissed"))&&(age==="all"||!Date.parse(e.createdAt)||Date.parse(e.createdAt)<=cutoff));},[preview,age,kind,statusFilter]);
  const choices=visible.filter(e=>selected.has(key(e))).map(e=>({kind:e.kind,id:e.id,revision:e.revision,action:actions[key(e)]??(e.canRemove?"remove":"dismiss")}));
  const removable=choices.filter(c=>c.action==="remove").length;
  function clearSelection(){setSelected(new Set());setActions({});setAck(false);}
  function close(){if(phase==="applying")return;epoch.current++;pending.current=false;setPhase("");setOpen(false);setPreview(null);clearSelection();setResult(null);setError("");}
  async function refresh(){
    if(pending.current)return;pending.current=true;const run=++epoch.current;setPhase("loading");setError("");clearSelection();
    try{const next=await invoke<Preview>("job_cleanup_preview");if(!next||!Array.isArray(next.entries)||!Array.isArray(next.warnings))throw new Error("Cleanup preview was unavailable.");if(run===epoch.current)setPreview(next);}
    catch(reason){if(run===epoch.current)setError(String(reason));}
    finally{if(run===epoch.current){pending.current=false;setPhase("");}}
  }
  async function apply(){
    if(pending.current||!ack||!choices.length)return;pending.current=true;const run=++epoch.current;setPhase("applying");setError("");setResult(null);
    try{const report=await invoke<Summary>("job_cleanup_apply",{choices,acknowledged:true});if(run!==epoch.current)return;if(!report||![report.removed,report.dismissed,report.protected,report.failed].every(n=>Number.isInteger(n)&&n>=0)||!Array.isArray(report.messages))throw new Error("Cleanup result was unavailable; refresh to inspect the saved state.");setResult(report);clearSelection();await onChanged();
      const next=await invoke<Preview>("job_cleanup_preview");if(run===epoch.current)setPreview(next);
    }catch(reason){if(run===epoch.current){clearSelection();setPreview(null);setError(String(reason));}}
    finally{if(run===epoch.current){pending.current=false;setPhase("");}}
  }
  return <><button type="button" className="btn-secondary" onClick={()=>{setOpen(true);setResult(null);void refresh();}}>Clean up jobs</button>
    {open&&<dialog ref={dialog} aria-labelledby="job-cleanup-title" className="bg-surface-900 text-gray-100 rounded-xl border border-surface-600 p-5 w-[min(1100px,94vw)] max-h-[90vh] backdrop:bg-black/70" onCancel={event=>{event.preventDefault();close();}}>
      <div className="flex justify-between gap-4"><div><h2 id="job-cleanup-title" className="text-xl font-semibold">Clean up old jobs</h2><p className="text-sm text-gray-300 mt-2">Remove selected job details and owned temporary data. Photos, projects, reusable renders, portable import manifests and protected upload receipts are kept.</p></div><button type="button" className="btn-secondary self-start" disabled={phase==="applying"} onClick={close}>Close</button></div>
      <p className="text-sm text-amber-200 my-3">Removal cannot be undone or resumed. Dismiss hides an inactive Google job in Archived while preserving its recovery details. Uncertain remote outcomes and active workers remain protected.</p>
      <div className="flex flex-wrap items-end gap-3 my-3">
        <label className="text-sm">Job age<select aria-label="Job age" className="input-field block" value={age} disabled={!!phase} onChange={e=>{setAge(e.target.value);clearSelection();}}><option value="30">Older than 30 days</option><option value="7">Older than 7 days</option><option value="all">All ages</option></select></label>
        <label className="text-sm">Job type<select aria-label="Job type" className="input-field block" value={kind} disabled={!!phase} onChange={e=>{setKind(e.target.value);clearSelection();}}><option value="all">All job types</option><option value="google">Google Photos</option><option value="import">Photo import</option><option value="process">Photo Process / Transfer</option><option value="studio">Video Studio</option></select></label>
        <label className="text-sm">Job status<select aria-label="Job status" className="input-field block" value={statusFilter} disabled={!!phase} onChange={e=>{setStatusFilter(e.target.value);clearSelection();}}><option value="all">All statuses</option><option value="attention">Needs attention / failed</option><option value="finished">Finished</option><option value="paused">Paused</option><option value="dismissed">Dismissed</option></select></label>
        <button type="button" className="btn-secondary" disabled={!!phase} onClick={()=>void refresh()}>Refresh cleanup preview</button>
        <button type="button" className="btn-secondary" disabled={!!phase} onClick={()=>{setSelected(new Set(visible.filter(e=>e.canRemove||e.canDismiss).slice(0,1000).map(key)));setAck(false);}}>Select eligible shown</button>
        <button type="button" className="btn-secondary" disabled={!!phase} onClick={clearSelection}>Clear selection</button>
      </div>
      {phase==="loading"&&<p role="status">Inspecting saved jobs…</p>}
      {preview?.warnings.map((warning,i)=><p role="status" className="text-amber-200 text-sm" key={i}>{warning}</p>)}
      {error&&<p role="alert" className="text-red-300 my-3">{error} Refresh before retrying; no automatic retry was made.</p>}
      {result&&<div role={result.failed||result.protected?"alert":"status"} className="my-3 p-3 border border-surface-600 rounded"><strong>Removed {result.removed} jobs · Dismissed {result.dismissed} jobs · Protected {result.protected} · Failed {result.failed}</strong>{result.messages.map((m,i)=><p className="text-sm mt-1" key={i}>{m}</p>)}</div>}
      <div className="max-h-[42vh] overflow-auto border border-surface-600 rounded">
        <table className="w-full text-sm text-left"><thead><tr className="bg-surface-800"><th className="p-2">Select</th><th className="p-2">Job</th><th className="p-2">Status / date</th><th className="p-2">Action and retained evidence</th></tr></thead><tbody>{visible.map(e=><tr key={key(e)} className="border-t border-surface-700 align-top">
          <td className="p-3"><input type="checkbox" aria-label={`Select ${e.title} ${e.id}`} className="w-5 h-5" checked={selected.has(key(e))} disabled={!!phase||(!e.canRemove&&!e.canDismiss)||(selected.size>=1000&&!selected.has(key(e)))} onChange={event=>{const next=new Set(selected);event.target.checked?next.add(key(e)):next.delete(key(e));setSelected(next);setAck(false);}}/></td>
          <td className="p-2"><strong>{e.title}</strong><span className="block text-xs text-gray-400">{e.kind} · {e.id.slice(-12)}</span></td>
          <td className="p-2">{e.status.replace(/_/g," ")}<span className="block text-xs text-gray-400">{e.createdAt?new Date(e.createdAt).toLocaleString():"Date unavailable"}</span></td>
          <td className="p-2">{(e.canRemove||e.canDismiss)&&<select aria-label={`Cleanup action ${e.id}`} className="input-field mb-1" disabled={!!phase} value={actions[key(e)]??(e.canRemove?"remove":"dismiss")} onChange={event=>{setActions({...actions,[key(e)]:event.target.value as Action});setAck(false);}}>{e.canRemove&&<option value="remove">Remove details permanently</option>}{e.canDismiss&&<option value="dismiss">Dismiss to Archived</option>}</select>}<p className="text-xs text-gray-300">{e.reason}</p></td>
        </tr>)}</tbody></table>{preview&&!visible.length&&<p className="p-4 text-gray-400">No jobs match these filters.</p>}
      </div>
      <div className="flex flex-wrap justify-between items-center gap-3 mt-4"><label className="text-sm flex gap-2 items-center"><input type="checkbox" aria-label="I understand removal cannot be undone" className="w-5 h-5" checked={ack} disabled={!!phase||!choices.length} onChange={e=>setAck(e.target.checked)}/>I understand removal cannot be undone; retained safeguards stay protected.</label><button type="button" className="btn-danger" disabled={!!phase||!ack||!choices.length} onClick={()=>void apply()}>{phase==="applying"?"Cleaning selected jobs…":"Clean selected jobs"}</button></div>
      <p className="text-xs text-gray-400 mt-2">{choices.length} selected: {removable} remove, {choices.length-removable} dismiss. Up to 1,000 jobs per cleanup. Changing filters clears the selection. Active jobs must be stopped through their normal controls first.</p>
    </dialog>}
  </>;
}
