import { useEffect, useRef, useState } from "react";
import type { StudioFinishingSettings, StudioColourGrade, StudioSubjectAnchor, StudioSubjectSelection } from "../../types/studioFinishing";
import type { StudioPreparedSubjectBase, StudioSubjectFrame, StudioSubjectMaskFrame,StudioSubjectTracking } from "../../types/studioSubjectPreparation";
import {StudioSubjectMaskReview} from "./StudioSubjectMaskReview";
import { effectiveFinishing, selectionRecipe } from "../../utils/studioFinishing";
import { subjectDisplayPoint, subjectFrameMatches } from "../../utils/studioSubjectPreparation";

const ranges = [
  ["lightEv", "Midtone light", -1.5, 1.5, 0.05],
  ["contrast", "Contrast", 0.75, 1.25, 0.01],
  ["saturation", "Colour", 0, 1.4, 0.01],
  ["warmth", "Warmth", -0.25, 0.25, 0.01],
] as const;
function ColourControls({value,onChange,prefix}:{value:StudioColourGrade;onChange:(v:StudioColourGrade)=>void;prefix:string}) {
  return <div className="studio-finishing-sliders">{ranges.map(([key,label,min,max,step])=><label key={key}>
    <span>{label}<output>{value[key].toFixed(2)}</output></span>
    <input type="range" aria-label={`${prefix} ${label}`} min={min} max={max} step={step} value={value[key]}
      onChange={event=>onChange({...value,[key]:Number(event.target.value)})}/>
  </label>)}</div>;
}

export function StudioFinishingSettings({value,busy,available,exportQualified=false,onChange,onConfirmClean}:{
  value?:StudioFinishingSettings;busy:boolean;available:boolean;exportQualified?:boolean;
  onChange:(value:StudioFinishingSettings)=>void;onConfirmClean:()=>Promise<boolean>;
}) {
  const settings=effectiveFinishing(value);const [confirming,setConfirming]=useState(false);
  const [policyError,setPolicyError]=useState("");
  const mounted=useRef(true);const current=useRef(JSON.stringify(settings));current.current=JSON.stringify(settings);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  async function policy(next:"reuse"|"clean") {
    if(next===settings.basePolicy)return;
    setPolicyError("");
    if(next==="clean") {
      const expected=current.current;
      setConfirming(true);let accepted=false;
      try{accepted=await onConfirmClean();}
      catch(error){if(mounted.current)setPolicyError(`Clean-base confirmation failed: ${String(error)}. No settings changed.`);}
      finally{if(mounted.current)setConfirming(false);}
      if(!accepted||!mounted.current||current.current!==expected)return;
    }
    onChange({...settings,basePolicy:next});
  }
  return <section className="studio-finishing-settings" aria-label="Subject finishing settings">
    <header><div><h3>Subject finishing</h3><p>Sharpen the horse and rider. Keep the bokeh soft.</p></div>
      <label><input type="checkbox" checked={settings.enabled} disabled={busy||confirming||(!available&&!settings.enabled)}
        onChange={event=>onChange({...settings,enabled:event.target.checked})}/> Enable</label></header>
    {!exportQualified&&<p role="status">Preview configuration only: subject finishing is not export-qualified in this development checkpoint. Turn it off to use the existing export workflow.</p>}
    {policyError&&<p role="alert">{policyError}</p>}
    <fieldset disabled={busy||!available||!settings.enabled||confirming}>
      <label>Stabilized base<select value={settings.basePolicy} onChange={event=>void policy(event.target.value as "reuse"|"clean")}>
        <option value="reuse">Reuse existing stabilized footage</option>
        <option value="clean">Clean base · explicit regeneration</option>
      </select></label>
      <p>Reuse avoids another stabilization pass. Quality bases may already contain whole-frame sharpening; subject finishing cannot undo that. Clean regeneration preserves old files and makes a separate base without that sharpening.</p>
      <label className="studio-finishing-slider"><span>Subject detail<output>{Math.round(settings.sharpening.amount*100)}%</output></span>
        <input type="range" aria-label="Subject sharpening" min="0" max="1" step="0.01" value={settings.sharpening.amount}
          onChange={event=>onChange({...settings,sharpening:{...settings.sharpening,amount:Number(event.target.value)}})}/></label>
      <label className="studio-finishing-slider"><span>Noise protection<output>{Math.round(settings.sharpening.noiseThreshold*255)}/255</output></span>
        <input type="range" aria-label="Subject sharpening noise protection" min="2" max="8" step="1" value={settings.sharpening.noiseThreshold*255}
          onChange={event=>onChange({...settings,sharpening:{...settings.sharpening,noiseThreshold:Number(event.target.value)/255}})}/></label>
      <ColourControls prefix="Subject" value={settings.colour} onChange={colour=>onChange({...settings,colour})}/>
      <p>Light is a gentle midtone trim, not recovery of clipped highlights. No generated detail or background sharpening. Prepare and review horse/rider masks in each clip’s Finishing step.</p>
      <details><summary>Optional whole-frame colour</summary>
        <label><input type="checkbox" checked={settings.wholeFrame.enabled}
          onChange={event=>onChange({...settings,wholeFrame:{...settings.wholeFrame,enabled:event.target.checked}})}/> Apply colour/light to the background too</label>
        <fieldset disabled={!settings.wholeFrame.enabled}><ColourControls prefix="Whole frame" value={settings.wholeFrame.colour}
          onChange={colour=>onChange({...settings,wholeFrame:{...settings.wholeFrame,colour}})}/></fieldset>
        <p>This deliberately changes background colour/light. Sharpening still stays subject-only.</p>
      </details>
    </fieldset>
  </section>;
}

/** Frame/operation ownership is supplied by the parent controller. This editor
 * never uses original-media thumbnails or a separately stabilized excerpt. */
export function StudioSubjectSelectionEditor({base,frame,response,selection,mask,tracking,active=true,busy,onFrame,onSelection}:{
  base:StudioPreparedSubjectBase;frame:number;response?:StudioSubjectFrame;selection?:StudioSubjectSelection;mask?:StudioSubjectMaskFrame;
  tracking?:StudioSubjectTracking;active?:boolean;busy:boolean;onFrame:(frame:number)=>void;onSelection:(selection:StudioSubjectSelection)=>void;
}) {
  const same=selection?.baseIdentity===base.identity&&selection.frameCount===base.frameCount;
  const [anchors,setAnchors]=useState<StudioSubjectAnchor[]>(()=>same?selection!.anchors:[]);
  const [reference,setReference]=useState(()=>same?selection!.referenceFrame:undefined);
  const [object,setObject]=useState<"horse"|"rider">("horse");
  const [mode,setMode]=useState<"box"|"include"|"exclude">("box");
  const [start,setStart]=useState<{x:number;y:number}|null>(null);
  const [end,setEnd]=useState<{x:number;y:number}|null>(null);
  const [box,setBox]=useState<[number,number,number,number]>([.1,.1,.9,.9]);
  const [error,setError]=useState("");
  const [showMask,setShowMask]=useState(true);
  const image=response&&subjectFrameMatches(base,frame,response)?response.dataUrl:null;
  const imageKey=JSON.stringify([base.id,base.identity,frame,image]);
  const overlay=showMask&&mask&&subjectFrameMatches(base,frame,mask)?mask.dataUrl:null;
  const maskKey=JSON.stringify([base.id,base.identity,frame,mask?.trackingId,mask?.maskIdentity,overlay]);
  const [loadedBase,setLoadedBase]=useState<string|null>(null),[loadedMask,setLoadedMask]=useState<string|null>(null);
  const baseLoad=useRef({key:imageKey,version:0}),maskLoad=useRef({key:maskKey,version:0});
  if(baseLoad.current.key!==imageKey)baseLoad.current={key:imageKey,version:baseLoad.current.version+1};
  const gesture=useRef<{pointerId:number;baseId:string;identity:string;frame:number;object:typeof object;mode:typeof mode;image:string;start:{x:number;y:number}}|null>(null);
  function cancelGesture(){gesture.current=null;setStart(null);setEnd(null);}
  function ownsGesture(pointerId:number){const g=gesture.current;return !!g&&g.pointerId===pointerId&&g.baseId===base.id
    &&g.identity===base.identity&&g.frame===frame&&g.object===object&&g.mode===mode&&g.image===image&&!busy;}
  useEffect(()=>{cancelGesture();},[base.id,base.identity,frame,object,mode,image,busy]);
  const draft:StudioSubjectSelection={version:1,baseIdentity:base.identity,frameCount:base.frameCount,referenceFrame:reference,anchors};
  let valid=false,unchanged=false;try{const recipe=selectionRecipe(draft);valid=true;unchanged=!!selection&&JSON.stringify(recipe)===JSON.stringify(selectionRecipe(selection));}catch{/* A two-object draft is allowed; no invalid selection is saved. */}
  let trackedSelection=false;try{trackedSelection=!!tracking&&!!selection&&JSON.stringify(selectionRecipe(tracking.selection))===JSON.stringify(selectionRecipe(selection));}catch{/* A stale tracking record cannot authorize a decision. */}
  const maskLoadKey=JSON.stringify([maskKey,unchanged]);
  if(maskLoad.current.key!==maskLoadKey)maskLoad.current={key:maskLoadKey,version:maskLoad.current.version+1};
  const baseTicket=JSON.stringify([imageKey,baseLoad.current.version]),maskTicket=JSON.stringify([maskLoadKey,maskLoad.current.version]);
  function anchor(change:Partial<StudioSubjectAnchor>) {
    setError("");if(reference===undefined)setReference(frame);
    setAnchors(previous=> {
      const existing=previous.find(value=>value.frame===frame&&value.object===object);
      if(!existing&&previous.length>=128){setError("Anchor limit reached. Remove an old correction before adding another.");return previous;}
      const next:StudioSubjectAnchor={...(existing??{frame,object}),...change};
      return [...previous.filter(value=>value!==existing),next];
    });
  }
  function position(event:React.PointerEvent<SVGSVGElement>) {
    return subjectDisplayPoint(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect(),base.width,base.height);
  }
  function pointerDown(event:React.PointerEvent<SVGSVGElement>) {
    if(busy||!image||event.button!==0||gesture.current)return;const point=position(event);if(!point)return;
    if(mode!=="box") {
      const existing=anchors.find(value=>value.frame===frame&&value.object===object);
      if(mode==="exclude"&&!existing?.box&&!existing?.points?.some(point=>point.include)) {
        setError("On a new correction frame, add a subject box or include point before an exclude point.");return;
      }
      if((existing?.points?.length??0)>=32){setError("Point limit reached for this frame/object.");return;}
      anchor({points:[...(existing?.points??[]),{...point,include:mode==="include"}]});
    }else{gesture.current={pointerId:event.pointerId,baseId:base.id,identity:base.identity,frame,object,mode,image,start:point};
      event.currentTarget.setPointerCapture(event.pointerId);setStart(point);setEnd(point);}
  }
  function pointerUp(event:React.PointerEvent<SVGSVGElement>) {
    if(gesture.current?.pointerId!==event.pointerId)return;
    const point=position(event),origin=gesture.current.start;if(point&&ownsGesture(event.pointerId)) {
      const next:[number,number,number,number]=[Math.min(origin.x,point.x),Math.min(origin.y,point.y),Math.max(origin.x,point.x),Math.max(origin.y,point.y)];
      if(next[2]-next[0]>.002&&next[3]-next[1]>.002){setBox(next);anchor({box:next});}
    }
    cancelGesture();if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <section className="studio-subject-editor" aria-label="Horse and rider selection">
    <div className="studio-subject-status"><strong>Full stabilized base</strong><span>{base.width}×{base.height} · {base.fps} fps · {base.frameCount} frames</span></div>
    {base.warnings.map(warning=><p key={warning} className="studio-subject-warning">{warning}</p>)}
    <fieldset disabled={busy} className="studio-subject-toolbar">
      <label>Frame<input type="number" min="0" max={base.frameCount-1} step="1" value={frame}
        onChange={event=>{const next=Number(event.target.value);if(Number.isSafeInteger(next)&&next>=0&&next<base.frameCount)onFrame(next);}}/></label>
      <button type="button" disabled={frame===0} onClick={()=>onFrame(frame-1)}>Previous frame</button>
      <button type="button" disabled={frame+1>=base.frameCount} onClick={()=>onFrame(frame+1)}>Next frame</button>
      <label>Subject<select value={object} onChange={event=>setObject(event.target.value as "horse"|"rider")}><option value="horse">Horse</option><option value="rider">Rider</option></select></label>
      <label>Tool<select value={mode} onChange={event=>setMode(event.target.value as typeof mode)}><option value="box">Draw box</option><option value="include">Include point</option><option value="exclude">Exclude point</option></select></label>
      {mask&&<label><input type="checkbox" checked={showMask} onChange={event=>setShowMask(event.target.checked)}/> Show tracked mask</label>}
    </fieldset>
    <div className="studio-subject-viewport" style={{aspectRatio:`${base.width}/${base.height}`}}>
      {image?<svg viewBox={`0 0 ${base.width} ${base.height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Stabilized frame ${frame} with horse and rider prompts`}
        onPointerDown={pointerDown} onPointerMove={event=>{if(ownsGesture(event.pointerId))setEnd(position(event));}} onPointerUp={pointerUp}
        onPointerCancel={event=>{if(gesture.current?.pointerId===event.pointerId)cancelGesture();}}
        onLostPointerCapture={event=>{if(gesture.current?.pointerId===event.pointerId)cancelGesture();}}>
        <image key={baseTicket} href={image} width={base.width} height={base.height} preserveAspectRatio="xMidYMid meet"
          onLoad={()=>setLoadedBase(baseTicket)} onError={()=>setLoadedBase(null)}/>
        {unchanged&&overlay&&<image key={maskTicket} href={overlay} width={base.width} height={base.height} preserveAspectRatio="xMidYMid meet" style={{imageRendering:"pixelated"}}
          onLoad={()=>setLoadedMask(maskTicket)} onError={()=>setLoadedMask(null)}/>}
        {anchors.filter(value=>value.frame===frame).map(value=><g key={value.object} stroke={value.object==="horse"?"#facc15":"#67e8f9"} fill="none" strokeWidth={Math.max(2,base.width/500)}>
          {value.box&&<rect x={value.box[0]*base.width} y={value.box[1]*base.height} width={(value.box[2]-value.box[0])*base.width} height={(value.box[3]-value.box[1])*base.height}/>}
          {value.points?.map((point,index)=><circle key={index} cx={point.x*base.width} cy={point.y*base.height} r={Math.max(4,base.width/150)} fill={point.include?"#4ade80":"#f87171"}/>)}</g>)}
        {start&&end&&<rect x={Math.min(start.x,end.x)*base.width} y={Math.min(start.y,end.y)*base.height} width={Math.abs(start.x-end.x)*base.width} height={Math.abs(start.y-end.y)*base.height} fill="none" stroke="white" strokeWidth={Math.max(2,base.width/500)} strokeDasharray="8 5"/>}
      </svg>:<p role="status">Reading the exact stabilized frame…</p>}
    </div>
    <p>Choose a clear reference frame and box the horse and rider separately. Yellow is horse; cyan is rider. Add corrections on later or earlier frames if the mask drifts. Background bars are never selection pixels.</p>
    {mask&&!unchanged&&<p role="status">Prompts have unsaved changes. The old mask is hidden; save the prompts, then track them again. The stabilized base is preserved.</p>}
    {tracking&&<StudioSubjectMaskReview key={`${tracking.id}:${tracking.maskIdentity}`} base={base} tracking={tracking} frame={frame}
      imageKey={JSON.stringify([baseTicket,maskTicket])} eligible={active&&!busy&&unchanged&&trackedSelection&&!!image&&!!overlay&&loadedBase===baseTicket&&loadedMask===maskTicket
        &&tracking.preparationId===base.id&&tracking.baseIdentity===base.identity&&tracking.frames===base.frameCount
        &&mask?.trackingId===tracking.id&&mask.maskIdentity===tracking.maskIdentity}/>}
    <fieldset disabled={busy||!image} className="studio-subject-box-entry"><legend>Or enter a box · keyboard controls</legend>
      {(["Left","Top","Right","Bottom"] as const).map((label,index)=><label key={label}>{label} %<input type="number" min="0" max="100" step="0.1" value={Number((box[index]*100).toFixed(1))}
        onChange={event=>{const next=Number(event.target.value);if(Number.isFinite(next)&&next>=0&&next<=100)setBox(previous=>previous.map((value,i)=>i===index?next/100:value) as typeof box);}}/></label>)}
      <button type="button" disabled={box[0]>=box[2]||box[1]>=box[3]} onClick={()=>anchor({box})}>Add {object} box</button>
    </fieldset>
    <div className="studio-subject-toolbar"><span>{anchors.length} anchors · reference {reference??"not selected"}</span>
      <button type="button" disabled={busy||!anchors.some(value=>value.frame===frame&&value.object===object)}
        onClick={()=>{setAnchors(previous=>previous.filter(value=>value.frame!==frame||value.object!==object));setError("");}}>Clear {object} prompt on this frame</button>
      <button type="button" disabled={busy} onClick={()=>{setAnchors([]);setReference(frame);setError("");}}>Start a new selection at this frame</button>
      <button type="button" disabled={busy||!valid} onClick={()=>{try{selectionRecipe(draft);onSelection(draft);}catch(error){setError(String(error));}}}>Save horse & rider selection</button></div>
    {!valid&&<p>Both subjects need an anchor on the same reference frame before saving. Saving new prompts makes old masks/review stale, but preserves the stabilized base.</p>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
