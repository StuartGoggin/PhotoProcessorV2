import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {ProcessJob} from "../types";
import type {TrashPreview} from "../types/reviewActions";
import {googlePhotoSize} from "../utils/googlePhotos";
import {reviewActionWriter} from "../utils/reviewActionPersistence";

export default function LightboxTrashRemoval({root,folder,onClose,onStarted}:{root:string;folder:string;onClose:()=>void;onStarted:(job:ProcessJob)=>void}){
  const [recursive,setRecursive]=useState(false),[preview,setPreview]=useState<TrashPreview|null>(null),[loading,setLoading]=useState(true),[starting,setStarting]=useState(false),[acknowledged,setAcknowledged]=useState(false),[error,setError]=useState("");
  const dialog=useRef<HTMLDivElement>(null),close=useRef<HTMLButtonElement>(null),generation=useRef(0),alive=useRef(true),latest=useRef(onClose);latest.current=onClose;
  useEffect(()=>{alive.current=true;const before=document.activeElement;close.current?.focus();const key=(event:KeyboardEvent)=>{
    if(event.key==="Escape"){event.preventDefault();event.stopPropagation();if(!starting&&!event.repeat)latest.current();}
    if(event.key==="Tab"){
      const controls=[...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')??[])].filter(node=>node.getClientRects().length>0);
      const first=controls[0],last=controls[controls.length-1];
      if(event.shiftKey&&(document.activeElement===first||!dialog.current?.contains(document.activeElement))){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||!dialog.current?.contains(document.activeElement))){event.preventDefault();first?.focus();}
    }
  };window.addEventListener("keydown",key,true);return()=>{alive.current=false;generation.current++;window.removeEventListener("keydown",key,true);if(before instanceof HTMLElement&&before.isConnected)before.focus();};},[starting]);
  useEffect(()=>{
    const request=++generation.current;setLoading(true);setPreview(null);setAcknowledged(false);setError("");
    void (async()=>{
      try{await reviewActionWriter.settled();const value=await invoke<TrashPreview>("preview_lightbox_trash",{stagingDir:root,relativeDir:folder,recursive});
        if(!value||value.stagingDir!==root||value.relativeDir!==folder||value.recursive!==recursive||!Array.isArray(value.items))throw Error("The removal preview did not match this folder.");
        if(alive.current&&generation.current===request)setPreview(value);
      }catch(reason){if(alive.current&&generation.current===request)setError(String(reason));}
      finally{if(alive.current&&generation.current===request)setLoading(false);}
    })();
  },[root,folder,recursive]);
  async function start(){
    if(!preview?.canStart||preview.stagingDir!==root||preview.relativeDir!==folder||preview.recursive!==recursive||!acknowledged||starting||loading)return;
    setStarting(true);setError("");
    try{await reviewActionWriter.settled();const job=await invoke<ProcessJob>("start_lightbox_trash_job",{previewId:preview.id,acknowledged:true});if(!job?.id)throw Error("The removal job was not confirmed.");onStarted(job);}
    catch(reason){if(alive.current){setError(String(reason));setStarting(false);setAcknowledged(false);}}
  }
  return <div className="fixed inset-0 z-[75] bg-black/70 flex items-center justify-center p-3 sm:p-6"><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="trash-removal-title" className="bg-surface-900 border border-surface-500 rounded-xl w-full max-w-4xl max-h-full flex flex-col text-sm text-gray-200">
    <header className="px-4 py-3 border-b border-surface-600 flex justify-between gap-4 items-start"><div><h2 id="trash-removal-title" className="text-xl font-semibold text-white">Take out the trash</h2><p className="text-xs text-gray-400 mt-1 break-all">{root}{folder?" / "+folder:" · staging root"}</p></div><button ref={close} type="button" className="btn-secondary min-h-11" disabled={starting} onClick={onClose}>Cancel</button></header>
    <div className="overflow-auto px-4 py-4 space-y-4"><p className="text-amber-200">This permanently removes the listed Camera JPEG and paired CR3 originals, plus their verified generated versions. Decision Undo cannot recover deleted files. Google Photos, SD cards and archive copies stay outside this job.</p>
      <label className="flex gap-3 items-center min-h-11"><input type="checkbox" className="w-6 h-6" disabled={starting} checked={recursive} onChange={event=>setRecursive(event.target.checked)}/>Include subfolders</label>
      {loading&&<p role="status">Waiting for saved decisions and preparing the exact file list…</p>}
      {error&&<p role="alert" className="text-amber-200">Could not prepare or start removal: {error}</p>}
      {preview&&<><p className="font-medium text-white">{preview.captureCount.toLocaleString()} capture{preview.captureCount===1?"":"s"} · {preview.fileCount.toLocaleString()} included file{preview.fileCount===1?"":"s"} · {googlePhotoSize(preview.totalBytes)} confirmed file bytes</p>
        {preview.warnings.map((warning,index)=><p key={index} className="text-amber-200">{warning}</p>)}
        <p className="text-xs text-gray-400">Protected files remain in staging. Jobs reports removed, already absent, protected and failed files separately; actual free space may differ.</p>
        <ul aria-label="Exact removal file list" className="divide-y divide-surface-600 border border-surface-600 rounded-lg max-h-72 overflow-auto">{preview.items.map((item,index)=><li key={item.relativePath+index} className="px-3 py-2 text-xs"><div className="flex gap-3 justify-between"><span className="break-all">{item.relativePath}</span><span className="shrink-0">{googlePhotoSize(item.bytes)}</span></div><p className={"mt-1 "+(item.included?"text-red-200":"text-amber-200")}>{item.included?"Will permanently remove":"Protected"} · {item.kind}</p>{item.reason&&<p className="mt-1 text-amber-200">{item.reason}</p>}</li>)}</ul>
      </>}
    </div>
    <footer className="border-t border-surface-600 px-4 py-3 space-y-3"><label className="flex gap-3 items-center text-xs"><input type="checkbox" className="w-6 h-6 shrink-0" checked={acknowledged} disabled={!preview?.canStart||loading||starting} onChange={event=>setAcknowledged(event.target.checked)}/>I permanently remove these listed originals and versions. I understand that Undo cannot recover their files.</label><div className="flex justify-end"><button type="button" className="btn-secondary min-h-11 text-red-200 border border-red-700" disabled={!preview?.canStart||!acknowledged||loading||starting} onClick={()=>void start()}>{starting?"Creating removal job…":"Permanently remove listed files"}</button></div></footer>
  </div></div>;
}
