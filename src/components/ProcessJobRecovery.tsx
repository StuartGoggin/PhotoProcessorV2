import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";

/** A read-only lookup in the existing job service; no worker or alternate tracker. */
export default function ProcessJobRecovery({jobId,onRefresh}:{jobId:string;onRefresh:()=>Promise<void>}) {
  const [report,setReport]=useState<{id:string;text?:string;error?:string}|null>(null);
  const [busy,setBusy]=useState(false);
  const generation=useRef(0),pending=useRef(false);
  useEffect(()=>{generation.current++;pending.current=false;setReport(null);setBusy(false);return()=>{generation.current++;};},[jobId]);
  const current=report?.id===jobId?report:null;
  async function readDiagnostics(){
    if(pending.current)return;
    const epoch=++generation.current;pending.current=true;setBusy(true);setReport(null);
    try{
      const text=await invoke<string>("process_job_diagnostics",{jobId});
      if(typeof text!=="string")throw new Error("The saved diagnostics response was unavailable.");
      if(epoch===generation.current)setReport({id:jobId,text});
    }catch(reason){if(epoch===generation.current)setReport({id:jobId,error:String(reason)});}
    finally{if(epoch===generation.current){pending.current=false;setBusy(false);}}
  }
  return <section role="region" aria-label="Saved job recovery" className="card mb-4 border border-amber-700 space-y-3">
    <h3 className="font-semibold text-amber-200">Find the selected job</h3>
    <p className="text-sm text-gray-300">This job is not in the current list. Refresh or read any available diagnostics for the same job; these actions do not start or resume work.</p>
    <p className="text-xs text-gray-400">Job reference: <code className="break-all">{jobId}</code></p>
    <div className="flex flex-wrap gap-2"><button type="button" className="btn-secondary" disabled={busy} onClick={()=>void onRefresh()}>Refresh saved jobs</button><button type="button" className="btn-primary" disabled={busy} onClick={()=>void readDiagnostics()}>{busy?"Reading saved diagnostics…":"Read saved diagnostics"}</button></div>
    {current?.error&&<p role="status" className="text-sm text-amber-200">Saved diagnostics could not be read: {current.error} Existing records and selections were not reset.</p>}
    {current?.text&&<><p className="text-xs text-gray-400">Read-only diagnostic report. Review before sharing.</p><textarea className="input-field w-full min-h-48 font-mono text-xs" readOnly aria-label={`Saved diagnostics for ${jobId}`} value={current.text}/></>}
  </section>;
}
