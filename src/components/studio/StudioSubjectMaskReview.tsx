import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {StudioPreparedSubjectBase,StudioSubjectTracking,StudioSubjectReviewReply,StudioSubjectReviewReceipt} from "../../types/studioSubjectPreparation";
import {subjectReviewMatches} from "../../utils/studioSubjectReview";

/** Eligibility comes from the editor's exact, loaded, saved, visible overlay.
 * Scrubbing never records review. Frame/prompt/visibility changes revoke replies. */
export function StudioSubjectMaskReview({base,tracking,frame,eligible,imageKey}:{
  base:StudioPreparedSubjectBase;tracking:StudioSubjectTracking;frame:number;eligible:boolean;imageKey:string;
}) {
  const scope=JSON.stringify([base.id,base.identity,tracking.id,tracking.maskIdentity,tracking.maskSha256]);
  const artifact=useRef(scope);artifact.current=scope;
  const stamp=JSON.stringify([scope,frame,eligible,imageKey]);
  const current=useRef({stamp,revision:0});if(current.current.stamp!==stamp)current.current={stamp,revision:current.current.revision+1};
  const mounted=useRef(true);const inflight=useRef(false);
  const [state,setState]=useState<{scope:string;review?:StudioSubjectReviewReceipt;pending:boolean;error:string}>(()=>({scope,
    review:tracking.review&&subjectReviewMatches(base,tracking,tracking.review)?tracking.review:undefined,pending:false,error:""}));
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;current.current.revision++;};},[]);
  useEffect(()=>{setState({scope,review:tracking.review&&subjectReviewMatches(base,tracking,tracking.review)?tracking.review:undefined,pending:false,error:""});},[scope]);
  const visible=state.scope===scope?state:{scope,pending:false,error:"",review:undefined};
  async function record(decision:"approve"|"reject") {
    if(!eligible||inflight.current)return;const revision=current.current.revision;
    // Once a mutation starts, an old decision is no longer reliable: the native
    // write may commit even when its reply is stale or delivery fails.
    inflight.current=true;setState({scope,review:undefined,pending:true,error:""});
    try {
      const response=await invoke<StudioSubjectReviewReply>("studio_subject_mask_review",{trackingId:tracking.id,request:{decision,coverage:"sampledFrames",frames:[frame]}});
      if(!mounted.current||artifact.current!==scope)return;
      if(response.trackingId!==tracking.id||response.preparationId!==base.id||response.baseIdentity!==base.identity
        ||response.maskIdentity!==tracking.maskIdentity||response.maskSha256!==tracking.maskSha256||response.reviewed!==false
        ||response.exportQualified!==false||response.subjectQualityAccepted!==false||!subjectReviewMatches(base,tracking,response.review)
        ||response.review.decision!==decision||response.review.frames.length!==1||response.review.frames[0]!==frame) {
        throw new Error("Review receipt did not match the exact displayed frame/mask. No approval was shown.");
      }
      if(current.current.revision===revision)setState({scope,review:response.review,pending:false,error:""});
      else {
        // Navigation cannot turn a frame-9 decision into frame-20 approval.
        // Read durable latest after drain so a late flag cannot leave an older
        // acknowledgment visible on returning to that frame.
        const latest=await invoke<StudioSubjectTracking>("studio_subject_tracked",{trackingId:tracking.id});
        if(!mounted.current||artifact.current!==scope)return;
        if(latest.id!==tracking.id||latest.preparationId!==base.id||latest.baseIdentity!==base.identity||latest.maskIdentity!==tracking.maskIdentity
          ||latest.maskSha256!==tracking.maskSha256||latest.frames!==base.frameCount||latest.reviewed!==false||latest.exportQualified!==false
          ||latest.review==null||!subjectReviewMatches(base,tracking,latest.review))throw new Error("Review read-back did not match this exact mask. No approval was shown.");
        setState({scope,review:latest.review,pending:false,error:""});
      }
    }catch(error){if(mounted.current&&artifact.current===scope)setState(previous=>({...previous,review:undefined,pending:false,error:String(error)}));}
    finally{inflight.current=false;if(mounted.current)setState(previous=>({...previous,pending:false}));}
  }
  const review=visible.review,listed=review?.frames.includes(frame);
  return <section className="studio-subject-review" aria-label="Exact mask frame review">
    <strong>Review this mask frame</strong>
    <p>Check the horse and rider silhouette, blurred background and frame edges. Your decision records only this frame—not the whole clip, model quality or permission to export.</p>
    <p role="status">{listed?`User ${review!.decision==="approve"?"acknowledged":"flagged"} frame ${frame}.`: `No verified decision loaded for frame ${frame}.`}
      {review&&!listed&&` Latest user decision: ${review.decision==="approve"?"acknowledged":"flagged"} frame${review.frames.length===1?"":"s"} ${review.frames.join(", ")}.`}</p>
    {!eligible&&<p role="status">Load the exact frame and visible mask with saved prompts to record a decision.</p>}
    <div className="studio-subject-toolbar">
      <button type="button" disabled={!eligible||visible.pending} onClick={()=>void record("approve")}>Acknowledge this mask frame</button>
      <button type="button" disabled={!eligible||visible.pending} onClick={()=>void record("reject")}>Flag this mask frame</button>
    </div>
    {visible.pending&&<p role="status">Recording this exact-frame decision…</p>}
    {visible.error&&<p role="alert">{visible.error}</p>}
  </section>;
}
