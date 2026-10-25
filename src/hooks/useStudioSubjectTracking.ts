import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {StudioJob} from "../types/videoStudio";
import type {StudioSubjectSelection} from "../types/studioFinishing";
import type {StudioPreparedSubjectBase,StudioSubjectTracking,StudioSubjectMaskFrame} from "../types/studioSubjectPreparation";
import {selectionRecipe} from "../utils/studioFinishing";
import {SubjectFrameReader} from "../utils/studioSubjectPreparation";
import {subjectReviewMatches} from "../utils/studioSubjectReview";

/** Mask scope excludes grade/title edits. Prompt/base edits invalidate handles,
 * not stored media; the native parent ID also tombstones every child operation. */
export function useStudioSubjectTracking(base:StudioPreparedSubjectBase|undefined,selection:StudioSubjectSelection|undefined,frame:number,jobs:StudioJob[]) {
  let recipe:string|undefined;try{if(selection)recipe=JSON.stringify(selectionRecipe(selection));}catch{/* Incomplete prompt drafts are not requests. */}
  const valid=!!base&&!!selection&&!!recipe&&selection.baseIdentity===base.identity&&selection.frameCount===base.frameCount;
  const scope=JSON.stringify([base?.id,recipe]);const current=useRef(scope);current.current=scope;
  const latestFrame=useRef(frame);latestFrame.current=frame;
  const owner=useRef<{scope:string;id?:string;pending:boolean;closed:boolean;revision:number;loading?:string;reader?:SubjectFrameReader}>({scope,pending:false,closed:false,revision:0});
  const [state,setState]=useState<{scope:string;id?:string;pending:boolean;metadata?:StudioSubjectTracking;mask?:StudioSubjectMaskFrame;reading?:boolean;error:string}>({scope,pending:false,error:""});
  const forget=(id:string)=>{void invoke("studio_subject_tracking_forget",{trackingId:id}).catch(()=>{/* Never delete caches to compensate for a cleanup error. */});};
  useEffect(()=>{const session={scope,pending:false,closed:false,revision:0}as typeof owner.current;owner.current=session;setState({scope,pending:false,error:""});
    return()=>{session.closed=true;session.reader?.stop();if(session.id)forget(session.id);};},[scope]);
  async function start(){
    const session=owner.current;if(!valid||!base||!selection||session.closed||session.scope!==scope||session.pending||session.id)return;
    const revision=++session.revision;session.pending=true;setState({scope,pending:true,error:""});
    try{const id=await invoke<string>("studio_subject_track",{preparationId:base.id,selection});
      if(current.current!==scope||owner.current!==session||session.closed||revision!==session.revision){forget(id);return;}
      session.id=id;setState({scope,id,pending:true,error:""});
    }catch(error){if(current.current===scope&&!session.closed&&session.revision===revision)setState({scope,pending:false,error:String(error)});}
    finally{session.pending=false;}
  }
  const visible=state.scope===scope?state:{scope,pending:false,error:""};const id=visible.id,job=jobs.find(j=>j.id===id);
  useEffect(()=>{
    const session=owner.current;if(!base||!selection||!id||!job||session.closed||session.id!==id||session.loading===id||session.reader)return;
    if(["failed","cancelled","interrupted"].includes(job.status)){forget(id);session.id=undefined;setState({scope,pending:false,error:job.error||`Subject tracking ${job.status}. Base and cached masks were preserved.`});return;}
    if(job.status!=="completed")return;session.loading=id;
    void invoke<StudioSubjectTracking>("studio_subject_tracked",{trackingId:id}).then(metadata=>{
      if(current.current!==scope||owner.current!==session||session.closed||session.id!==id)return;
      if(metadata.version!==1||metadata.id!==id||metadata.preparationId!==base.id||metadata.baseIdentity!==base.identity||metadata.frames!==base.frameCount
        ||!/^[a-f0-9]{64}$/.test(metadata.maskIdentity)||!/^[a-f0-9]{64}$/.test(metadata.maskSha256)
        ||!["cpu","cuda"].includes(metadata.device)||!Number.isFinite(metadata.secondsIncludingLoad)||metadata.secondsIncludingLoad<0
        ||metadata.exportQualified!==false||metadata.reviewed!==false||JSON.stringify(selectionRecipe(metadata.selection))!==recipe
        ||metadata.review!=null&&!subjectReviewMatches(base,metadata,metadata.review))throw new Error("Tracking metadata did not match the saved exact-base prompts.");
      const reader=new SubjectFrameReader(base,async f=>{const response=await invoke<StudioSubjectMaskFrame>("studio_subject_mask_frame",{trackingId:id,frame:f});
        if(response.trackingId!==id||response.maskIdentity!==metadata.maskIdentity)throw new Error("Mask frame belongs to different subject tracking.");return response;},
        value=>{if(current.current===scope&&owner.current===session&&!session.closed&&session.id===id)setState({scope,id,pending:false,metadata,reading:value.reading,
          mask:value.response?{...value.response,trackingId:id,maskIdentity:metadata.maskIdentity}:undefined,error:value.error});});
      session.reader=reader;reader.request(latestFrame.current);
    }).catch(error=>{if(current.current===scope&&owner.current===session&&!session.closed&&session.id===id){forget(id);session.id=undefined;setState({scope,pending:false,error:String(error)});}})
      .finally(()=>{if(session.loading===id)session.loading=undefined;});
  },[scope,id,job?.status,job?.error]);
  useEffect(()=>{if(owner.current.scope===scope)owner.current.reader?.request(frame);},[scope,frame]);
  function release(){const session=owner.current;if(session.scope!==scope)return;session.revision++;session.loading=undefined;session.reader?.stop();session.reader=undefined;
    if(session.id)forget(session.id);session.id=undefined;setState({scope,pending:false,error:""});}
  return {...visible,valid,job,start,release};
}
