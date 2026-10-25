import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {StudioFinishingSettings} from "../types/studioFinishing";
import type {StudioPreparedSubjectBase,StudioSubjectTracking,StudioSubjectFinishedFrame} from "../types/studioSubjectPreparation";
import {effectiveFinishing} from "../utils/studioFinishing";
import {subjectFrameMatches} from "../utils/studioSubjectPreparation";

/** Explicit full-resolution updates, one request per controller. Never fake a
 * sharpened thumbnail; generation tickets cover cancellation before admission. */
export function useStudioSubjectPreview(base:StudioPreparedSubjectBase|undefined,tracking:StudioSubjectTracking|undefined,
  frame:number,value:StudioFinishingSettings|undefined,active=true) {
  const settings=effectiveFinishing(value),recipe=JSON.stringify(settings);
  const scope=JSON.stringify([base?.id,tracking?.id,tracking?.maskIdentity,frame,recipe,active]);
  const current=useRef(scope);current.current=scope;
  const owner=useRef<{scope:string;closed:boolean;pending:boolean;revision:number;trackingId?:string}>({scope,closed:false,pending:false,revision:0});
  const cancellation=useRef<{id:string;pending:boolean;promise:Promise<void>}|null>(null);
  const [state,setState]=useState<{scope:string;pending:boolean;response?:StudioSubjectFinishedFrame;error:string}>({scope,pending:false,error:""});
  const cancelNative=(id:string)=>{
    const previous=cancellation.current;if(previous?.id===id)return previous.promise;
    const barrier={id,pending:true,promise:Promise.resolve()};cancellation.current=barrier;
    barrier.promise=invoke<void>("studio_subject_finish_cancel",{trackingId:id}).then(()=>{if(cancellation.current===barrier)cancellation.current=null;})
      .catch(error=>{throw new Error(`Cannot confirm preview cancellation: ${String(error)}. Release this tracking review before retrying; cached media is preserved.`);})
      .finally(()=>{barrier.pending=false;});return barrier.promise;
  };
  useEffect(()=>{const session={scope,closed:false,pending:false,revision:0,trackingId:tracking?.id};owner.current=session;setState({scope,pending:false,error:""});
    return()=>{session.closed=true;session.revision++;if(session.pending&&session.trackingId)void cancelNative(session.trackingId).catch(()=>{/* A same-track replacement observes the rejection before admission. */});};},[scope]);
  async function generate(){
    const session=owner.current;if(!active||!base||!tracking||!settings.enabled||session.scope!==scope||session.closed||session.pending)return;
    const revision=++session.revision;session.pending=true;setState({scope,pending:true,error:""});
    const owns=()=>current.current===scope&&owner.current===session&&!session.closed&&session.revision===revision;
    try {
      const barrier=cancellation.current;if(barrier?.id===tracking.id)await barrier.promise;
      if(!owns())return;
      const previewEpoch=await invoke<number>("studio_subject_finish_epoch",{trackingId:tracking.id});
      if(!owns())return;
      if(!Number.isSafeInteger(previewEpoch)||previewEpoch<0||previewEpoch>0xffffffff)throw new Error("Invalid native finishing-preview generation.");
      const response=await invoke<StudioSubjectFinishedFrame>("studio_subject_finish_frame",{trackingId:tracking.id,frameIndex:frame,settings,previewEpoch});
      if(!owns())return;
      if(!subjectFrameMatches(base,frame,response)||response.trackingId!==tracking.id||response.maskIdentity!==tracking.maskIdentity
        ||response.width!==base.width||response.height!==base.height||response.engine!=="subject-rgb709-q4-v2"||response.exportQualified!==false
        ||!/^[a-f0-9]{64}$/.test(response.settingsIdentity)||JSON.stringify(effectiveFinishing(response.settings))!==recipe
        ||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(response.beforeDataUrl)
        ||response.beforeDataUrl.length>45*1024*1024||response.dataUrl.length>45*1024*1024)throw new Error("Finishing preview did not match this exact frame, mask and filter recipe.");
      setState({scope,pending:false,response,error:""});
    }catch(error){if(owns())setState({scope,pending:false,error:String(error)});}
    finally{session.pending=false;if(current.current===scope&&owner.current===session&&!session.closed)setState(previous=>previous.scope===scope?{...previous,pending:false}:previous);}
  }
  function cancel(){const session=owner.current;if(session.scope!==scope)return;session.revision++;if(session.pending&&session.trackingId)void cancelNative(session.trackingId).catch(()=>{/* Generation admission fails closed until this tracking is released. */});
    // Keep the single in-flight guard until its native reply drains.
    setState({scope,pending:session.pending,error:session.pending?"Cancelling this frame preview; cached footage and masks are unchanged.":""});}
  const visible=state.scope===scope?state:{scope,pending:false,error:""};
  return {...visible,generate,cancel};
}
