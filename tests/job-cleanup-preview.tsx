// Actual cleanup component, deterministic local metadata. No real jobs/files/accounts.
import React from "react";
import { createRoot } from "react-dom/client";
import JobCleanup from "../src/components/JobCleanup";
import "../src/styles.css";
const fixture=window as any;
fixture.__cleanupCalls=[];fixture.__cleanupChanged=0;fixture.__cleanupErrors=[];
window.addEventListener("error",event=>fixture.__cleanupErrors.push(event.message));
const ago=(days:number)=>new Date(Date.now()-days*86400000).toISOString();
fixture.__cleanupPreview ??= {entries:[
 {kind:"google",id:"G".repeat(43),title:"Old verified Google upload",status:"completed",createdAt:ago(60),revision:"google-verified-r1",canRemove:true,canDismiss:true,reason:"Compact receipt is retained; full job details can be removed."},
 {kind:"google",id:"U".repeat(43),title:"Unresolved Google upload",status:"needs_attention",createdAt:ago(60),revision:"google-unresolved-r1",canRemove:false,canDismiss:true,reason:"Accepted upload evidence is uncertain; dismiss preserves its protected receipt."},
 {kind:"google",id:"R".repeat(43),title:"Running Google upload",status:"running",createdAt:ago(60),revision:"google-running-r1",canRemove:false,canDismiss:false,reason:"The active worker must finish or stop before cleanup."},
 {kind:"import",id:"old-import",title:"Old failed import",status:"failed",createdAt:ago(60),revision:"import-r1",canRemove:true,canDismiss:false,reason:"Only saved job details are removed; imported photos remain."},
 {kind:"process",id:"recent-process",title:"Recent photo process",status:"completed",createdAt:ago(2),revision:"process-r1",canRemove:true,canDismiss:false,reason:"Only job details are removed."},
 {kind:"studio",id:"old-studio",title:"Old studio render",status:"completed",createdAt:ago(60),revision:"studio-r1",canRemove:true,canDismiss:false,reason:"Project and rendered video remain."},
],warnings:["Synthetic preview: cleanup does not delete photos or Google albums."]};
fixture.__cleanupPreviewResolvers=[];
fixture.__TAURI_INTERNALS__={invoke:async(command:string,args:any={})=>{
 fixture.__cleanupCalls.push({command,args:structuredClone(args)});
 if(command==="job_cleanup_preview"){
  const value=structuredClone(fixture.__cleanupPreview);
  if(fixture.__cleanupHoldPreview)await new Promise<void>(resolve=>fixture.__cleanupPreviewResolvers.push(resolve));
  if(fixture.__cleanupPreviewError)throw new Error(fixture.__cleanupPreviewError);
  return value;
 }
 if(command==="job_cleanup_apply"){
  if(fixture.__cleanupHoldApply)await new Promise<void>(resolve=>{fixture.__cleanupResolveApply=resolve;});
  if(fixture.__cleanupApplyError)throw new Error(fixture.__cleanupApplyError);
  if(fixture.__cleanupResult)return structuredClone(fixture.__cleanupResult);
  const choices=args.choices??[];
  return {removed:choices.filter((c:any)=>c.action==="remove").length,dismissed:choices.filter((c:any)=>c.action==="dismiss").length,protected:0,failed:0,messages:["Synthetic cleanup completed; photo files and compact receipts preserved."]};
 }
 throw new Error(`Unexpected cleanup IPC: ${command}`);
}};
const root=createRoot(document.getElementById("root")!);
fixture.__cleanupUnmount=()=>root.unmount();
root.render(<div style={{minHeight:"100vh",padding:24,background:"#0f172a",color:"#e2e8f0"}}><h1>Job cleanup fixture</h1><JobCleanup onChanged={async()=>{fixture.__cleanupChanged++;}}/></div>);
