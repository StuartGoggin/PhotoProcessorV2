import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ImportOptions } from "../types";
import { useSettings } from "../hooks";
import LightboxTrashRemoval from "../components/LightboxTrashRemoval";

export default function Cleanup({onOpenJobs}:{onOpenJobs?:(id:string)=>void}={}) {
  const { settings } = useSettings();
  const [starting, setStarting] = useState(false);
  const [removalOpen,setRemovalOpen]=useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function queueReprocess() {
    const staging = settings?.staging_dir || "";
    if (!staging) {
      setError("Please configure Staging Directory in Settings first.");
      return;
    }

    setStarting(true);
    setError(null);
    setMessage(null);

    try {
      const options: ImportOptions = { reprocessExisting: true };
      const jobId = await invoke<string>("start_import_job", {
        sourceDir: staging,
        stagingDir: staging,
        options,
      });
      // Reprocessing does not start optional motion-preview generation.
      setMessage(`Queued cleanup job: ${jobId}. Track it in Jobs tab.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h2 className="text-2xl font-semibold text-white mb-2">Cleanup</h2>
      <p className="text-gray-400 text-sm mb-6">
        Maintenance operations for already imported staging files.
      </p>

      <div className="card mb-6 space-y-3">
        <h3 className="text-white font-medium">Reprocess Staging Tree</h3>
        <p className="text-xs text-gray-400">
          Re-check existing files in staging, correct naming/timestamps, and ensure `.md5` sidecars exist.
        </p>
        <div className="text-xs text-gray-400 break-all">
          <span className="text-gray-500">Staging:</span> {settings?.staging_dir || "(not set)"}
        </div>
        <button className="btn-primary" onClick={queueReprocess} disabled={starting}>
          {starting ? "Queueing..." : "Queue Reprocess Job"}
        </button>
      </div>

      <div className="card mb-6 space-y-3">
        <h3 className="text-white font-medium">Take out the trash</h3>
        <p className="text-xs text-gray-400">
          Preview permanent removal of trashed captures, including Camera JPEG and paired CR3 originals and verified generated versions. Protected files remain in staging. The preview starts at the staging root; including subfolders is an explicit choice.
        </p>
        <button className="btn-secondary" onClick={()=>setRemovalOpen(true)} disabled={!settings?.staging_dir}>
          Review permanent trash removal
        </button>
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 mb-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {message && (
        <div className="bg-green-900/40 border border-green-700 rounded-lg px-4 py-3 mb-4 text-green-300 text-sm">
          {message}
        </div>
      )}
      {removalOpen&&settings?.staging_dir&&<LightboxTrashRemoval root={settings.staging_dir} folder="" onClose={()=>setRemovalOpen(false)} onStarted={job=>{setRemovalOpen(false);setMessage(`Queued permanent removal job: ${job.id}. Track it in Jobs.`);onOpenJobs?.(job.id);}}/>}
    </div>
  );
}
