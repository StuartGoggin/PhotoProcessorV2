import { useState } from "react";
import { useSettings } from "../hooks";
import LightboxTrashRemoval from "../components/LightboxTrashRemoval";

export default function TidyUp({onOpenJobs}:{onOpenJobs?:(id:string)=>void}={}) {
  const { settings } = useSettings();
  const [open,setOpen]=useState(false),[jobId,setJobId]=useState("");

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Tidy Up</h2>
      <p className="text-gray-400 text-sm mb-6">
        Preview permanent removal of trashed captures, including Camera JPEG and paired CR3 originals and verified generated versions. The exact file list protects ambiguous files and requires separate confirmation. Undo cannot recover removed files.
      </p>

      {settings?.staging_dir && (
        <div className="card mb-6 text-sm">
          <span className="text-gray-400">Staging: </span>
          <span className="text-gray-200">{settings.staging_dir}</span>
        </div>
      )}

      {jobId&&<p role="status" className="mb-4 text-xs text-emerald-200">Permanent removal queued in Jobs: {jobId}</p>}
      <button className="btn-secondary min-h-11" onClick={()=>setOpen(true)} disabled={!settings?.staging_dir}>
        Review permanent trash removal
      </button>
      {open&&settings?.staging_dir&&<LightboxTrashRemoval root={settings.staging_dir} folder="" onClose={()=>setOpen(false)} onStarted={job=>{setOpen(false);setJobId(job.id);onOpenJobs?.(job.id);}}/>}
    </div>
  );
}
