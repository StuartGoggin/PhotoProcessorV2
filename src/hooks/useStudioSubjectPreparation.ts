import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StudioClip, StudioJob, StudioProject } from "../types/videoStudio";
import type { StudioPreparedSubjectBase } from "../types/studioSubjectPreparation";
import { SubjectFrameReader, subjectBaseMatches, subjectBaseRecipe, type SubjectReadState } from "../utils/studioSubjectPreparation";

interface PreparationState extends SubjectReadState {
  scope:string; id?:string; preparing:boolean; base?:StudioPreparedSubjectBase;
}
const empty:Omit<PreparationState,"scope">={frame:0,reading:false,error:"",preparing:false};
/** UI scope owns IDs, never filesystem paths. Cleanup forgets native handles
 * and tombstones pending work, but deliberately never deletes cached media. */
export function useStudioSubjectPreparation(project:StudioProject,clip:StudioClip|undefined,epoch:number,
  active:boolean,jobs:StudioJob[],getStagingDir:()=>Promise<string>) {
  const scope=JSON.stringify([epoch,active,project.outputDir,clip?subjectBaseRecipe(project,clip):null]);
  const current=useRef(scope);current.current=scope;
  const owner=useRef<{scope:string;id?:string;pending:boolean;loading?:string;closed:boolean;revision:number;reader?:SubjectFrameReader}>({scope,pending:false,closed:false,revision:0});
  const [state,setState]=useState<PreparationState>({scope,...empty});
  const forget=(id:string)=>{void invoke("studio_subject_forget",{preparationId:id}).catch(()=>{/* Native IDs stay bounded; never delete caches on cleanup failure. */});};
  useEffect(()=>{
    const session={scope,pending:false,closed:false,revision:0} as typeof owner.current;owner.current=session;
    setState({scope,...empty});
    return ()=>{session.closed=true;session.reader?.stop();if(session.id)forget(session.id);};
  },[scope]);
  async function prepare() {
    const session=owner.current;
    if(!active||!clip||session.scope!==scope||session.closed||session.pending||session.id)return;
    const revision=++session.revision;
    session.pending=true;setState({scope,...empty,preparing:true});
    try {
      const stagingDir=await getStagingDir();
      if(current.current!==scope||owner.current!==session||session.closed||session.revision!==revision)return;
      const id=await invoke<string>("studio_subject_prepare",{project,stagingDir,clipId:clip.id});
      if(current.current!==scope||owner.current!==session||session.closed||session.revision!==revision){forget(id);return;}
      session.id=id;setState({scope,...empty,id,preparing:true});
    }catch(error){if(current.current===scope&&owner.current===session&&!session.closed&&session.revision===revision)setState({scope,...empty,error:String(error)});}
    finally{session.pending=false;}
  }
  const id=state.scope===scope?state.id:undefined;
  const job=jobs.find(value=>value.id===id);
  useEffect(()=>{
    const session=owner.current;
    if(!id||!job||session.scope!==scope||session.closed||session.id!==id||session.loading===id||session.reader)return;
    if(["failed","cancelled","interrupted"].includes(job.status)) {
      forget(id);session.id=undefined;
      setState({scope,...empty,error:job.error||`Base preparation ${job.status}. Cached files were preserved.`});return;
    }
    if(job.status!=="completed"||!clip)return;
    session.loading=id;
    void invoke<StudioPreparedSubjectBase>("studio_subject_prepared",{preparationId:id}).then(base=>{
      if(current.current!==scope||owner.current!==session||session.closed||session.id!==id)return;
      if(base.id!==id||!subjectBaseMatches(base,clip.id))throw new Error("Prepared base metadata did not match the selected clip.");
      const reader=new SubjectFrameReader(base,frame=>invoke("studio_subject_frame",{preparationId:id,frame}),
        value=>{if(current.current===scope&&owner.current===session&&!session.closed&&session.id===id)setState({scope,id,base,preparing:false,...value});});
      session.reader=reader;reader.request(0);
    }).catch(error=>{if(current.current===scope&&owner.current===session&&!session.closed&&session.id===id){forget(id);session.id=undefined;setState({scope,...empty,error:String(error)});}})
      .finally(()=>{if(session.loading===id)session.loading=undefined;});
  },[scope,id,job?.status,job?.error,clip?.id]);
  const visible=state.scope===scope?state:{scope,...empty};
  return {...visible,job,prepare,readFrame:(frame:number)=>owner.current.scope===scope&&owner.current.reader?.request(frame),
    release:()=>{const session=owner.current;if(session.scope!==scope)return;session.revision++;session.loading=undefined;session.reader?.stop();session.reader=undefined;
      if(session.id)forget(session.id);session.id=undefined;setState({scope,...empty});}};
}
