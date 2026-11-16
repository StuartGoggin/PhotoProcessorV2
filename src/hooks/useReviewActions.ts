import {useCallback,useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {ReviewActionReceipt,ReviewActionRequest,ReviewHistory,ReviewReplayRequest} from "../types/reviewActions";
import {reviewActionToken,reviewActionWriter as writer} from "../utils/reviewActionPersistence";
import {neutralPhotoPath} from "../utils/lightboxBrowse";

export function useReviewActions(root:string,folder:string,onConfirmed:(receipt:ReviewActionReceipt,replay:boolean)=>void){
  const [,render]=useState(0),[history,setHistory]=useState<ReviewHistory|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(false);
  const alive=useRef(true),epoch=useRef(0),latest=useRef(onConfirmed),scope=useRef({root,folder});latest.current=onConfirmed;scope.current={root,folder};
  const replayPending=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
  useEffect(()=>writer.subscribe(()=>{if(alive.current)render(n=>n+1);}),[]);
  const refresh=useCallback(async(append=false)=>{
    if(!root)return;
    const generation=++epoch.current;setLoading(true);setError("");
    try{
      await writer.settled();
      const result=await invoke<ReviewHistory>("read_lightbox_review_history",{stagingDir:root,relativeDir:folder,offset:append?history?.nextOffset??0:0,limit:50});
      if(!result||!Array.isArray(result.entries)||!Array.isArray(result.warnings))throw Error("Invalid history response");
      if(alive.current&&generation===epoch.current)setHistory(previous=>append&&previous?{...result,entries:[...previous.entries,...result.entries]}:result);
    }catch(reason){if(alive.current&&generation===epoch.current)setError(String(reason));}
    finally{if(alive.current&&generation===epoch.current)setLoading(false);}
  },[root,folder,history?.nextOffset]);
  const refreshLatest=useRef(refresh);refreshLatest.current=refresh;
  useEffect(()=>{setHistory(null);void refreshLatest.current();},[root,folder]);
  const status=writer.snapshot(root);
  useEffect(()=>{
    const prevent=(event:BeforeUnloadEvent)=>{if(writer.hasPending()){event.preventDefault();event.returnValue="";}};
    window.addEventListener("beforeunload",prevent);return()=>window.removeEventListener("beforeunload",prevent);
  },[]);
  function confirmed(receipt:ReviewActionReceipt,replay:boolean){
    if(alive.current&&scope.current.root===root){
      ++epoch.current;setLoading(false);
      setHistory(previous=>({...previous,revision:receipt.revision,entries:previous?.entries??[],total:previous?.total??0,nextOffset:previous?.nextOffset??null,warnings:previous?.warnings??[],canUndo:receipt.canUndo,canRedo:receipt.canRedo}));
      latest.current(receipt,replay);
      // The last native result may arrive before React paints a pending state.
      // Read history after the queue removes that result, including on Retry
      // from a different mounted view than the one that submitted the action.
      void Promise.resolve().then(()=>{if(alive.current&&scope.current.root===root&&!writer.hasPending(root))void refreshLatest.current();});
    }
  }
  const confirmedLatest=useRef(confirmed);confirmedLatest.current=confirmed;
  useEffect(()=>writer.subscribeReceipts((request,receipt)=>{
    if(request.stagingDir===scope.current.root)confirmedLatest.current(receipt,"direction" in request);
  }),[]);
  function trash(request:Omit<ReviewActionRequest,"actionId"|"stagingDir">){
    const current=writer.snapshot(root);
    if(current.blocked||current.full||replayPending.current)return false;
    void writer.enqueue({...request,stagingDir:root,actionId:reviewActionToken()}).catch(()=>{});
    return true;
  }
  function replay(direction:ReviewReplayRequest["direction"]){
    const current=writer.snapshot(root);
    if(current.blocked||current.full||replayPending.current)return false;
    const pending=writer.hasPending(root);
    if(!pending&&!(direction==="undo"?history?.canUndo:history?.canRedo))return false;
    replayPending.current=true;
    void writer.enqueue({stagingDir:root,direction,actionId:reviewActionToken(),...(!pending?{expectedRevision:history?.revision}:{})}).catch(()=>{}).finally(()=>{replayPending.current=false;if(alive.current)render(n=>n+1);});
    return true;
  }
  return {...status,failures:writer.allFailures(),history,error,loading,refresh,trash,replay,replaying:replayPending.current,
    discardedNotices:writer.discardedNotices(),canDiscardRejected:(id:string)=>writer.canDiscardRejected(id),discardRejected:(id:string)=>writer.discardRejected(id),queuedCount:()=>writer.requests().length,
    canUndo:!status.blocked&&!replayPending.current&&(!!history?.canUndo||status.pending>0),canRedo:!status.blocked&&!replayPending.current&&!!history?.canRedo,
    hasPending:()=>writer.hasPending(root),settled:()=>writer.settled(),
    pendingFor:(path:string)=>writer.requests().some(request=>request.stagingDir===root&&("direction" in request||neutralPhotoPath(request.relativePath)===neutralPhotoPath(path))),
    retry:async(id:string)=>{try{await writer.retry(id);}catch{}},
  };
}
