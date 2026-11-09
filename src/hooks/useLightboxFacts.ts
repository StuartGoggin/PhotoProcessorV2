import {useCallback,useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {TreeNode} from "../types";
import {photoFolder} from "../utils/lightboxCatalogue";
import {reviewKey,type FolderFacts} from "../utils/lightboxBrowse";
import {curationWriter} from "../utils/curationPersistence";
import {reviewWriter} from "../utils/reviewPersistence";

const modelFor=(root:string,folder:string)=>({root,folder,data:null as FolderFacts|null,version:0,loading:!!root,saving:false,pending:0,error:"",generation:0});

/** Only two tiny sidecars are read. Accepted decisions finish independently of
 * this view, while refresh waits for their primary and Reviewed outcomes. */
export function useLightboxFacts(root:string,folder:string,refreshKey:unknown){
  const model=useRef(modelFor(root,folder)),alive=useRef(true),[,render]=useState(0);
  if(model.current.root!==root||model.current.folder!==folder)model.current=modelFor(root,folder);
  const notify=(target:ReturnType<typeof modelFor>)=>{if(alive.current&&model.current===target)render(n=>n+1);};
  const refreshLatest=useRef<()=>Promise<void>>(async()=>{});
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;model.current.generation++;};},[]);
  const refresh=useCallback(async()=>{
    const target=model.current;if(target.root!==root||target.folder!==folder||!root||target.saving)return;
    const generation=++target.generation;target.loading=true;target.error="";notify(target);
    try{
      await reviewWriter.settled();await curationWriter.settled();await reviewWriter.settled();
      if(!alive.current||model.current!==target||target.generation!==generation)return;
      const data=await invoke<FolderFacts>("lightbox_review_catalogue",{root,relativeFolder:folder});
      if(!alive.current||model.current!==target||target.generation!==generation)return;
      if(!data||!("review" in data)||!("selections" in data))throw Error("The folder filter data was incomplete.");
      target.data=data;target.version++;
    }catch(error){if(model.current===target&&target.generation===generation){target.data=null;target.error="Folder review/filter information is unavailable: "+String(error);target.version++;}}
    finally{if(model.current===target&&target.generation===generation){target.loading=false;notify(target);}}
  },[root,folder]);
  refreshLatest.current=refresh;
  useEffect(()=>{void refresh();},[refresh,refreshKey]);

  function prepare(node:TreeNode,reviewed:boolean){
    const target=model.current;
    const request={root,relativePath:node.path.replace(/\\/g,"/"),key:reviewKey(node),sourceStamp:node.sourceStamp??"",reviewed};
    const ticket=reviewWriter.defer(request);
    target.pending++;target.saving=true;target.loading=false;target.error="";++target.generation;notify(target);
    let completion:Promise<boolean>|undefined;
    return {complete:(primarySaved:boolean,replacement?:TreeNode)=>{
      if(!completion){
        const next=replacement?{...request,relativePath:replacement.path.replace(/\\/g,"/"),key:reviewKey(replacement),sourceStamp:replacement.sourceStamp??""}:undefined;
        completion=ticket.complete(primarySaved,next).then(receipt=>{
          if(!receipt)return false;
          if(target.data?.review){const review=target.data.review;target.data={...target.data,review:{...review,revision:receipt.revision,entries:{...review.entries,[receipt.key]:{reviewed:receipt.reviewed,sourceStamp:receipt.sourceStamp}}}};target.version++;}
          return true;
        }).catch(error=>{target.error="Reviewed status was not saved: "+String(error);return false;}).finally(()=>{
          target.pending--;target.saving=target.pending>0;notify(target);
          if(!target.saving&&alive.current&&model.current===target)void refreshLatest.current();
        });
      }
      return completion;
    }};
  }
  async function mark(node:TreeNode,reviewed:boolean):Promise<boolean>{
    const target=model.current;
    if(!root||target.root!==root||target.folder!==photoFolder(node.path)||target.loading||target.saving||!target.data?.review||!node.sourceStamp)return false;
    try{return await prepare(node,reviewed).complete(true);}catch(error){target.error=String(error);notify(target);return false;}
  }
  const current=model.current;
  return {data:current.data,version:current.version,loading:current.loading,saving:current.saving,error:current.error||reviewWriter.error(root),refresh,mark,
    prepareAutomatic:(node:TreeNode)=>prepare(node,true),
    failedValue:(node:TreeNode)=>reviewWriter.failedValue(root,node.path),
    failedFor:(node?:TreeNode)=>!!node&&reviewWriter.failedFor(root,node.path),getData:()=>model.current.data};
}
