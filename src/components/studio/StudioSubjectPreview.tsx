import {useState} from "react";
import type {StudioFinishingSettings} from "../../types/studioFinishing";
import type {StudioPreparedSubjectBase,StudioSubjectTracking} from "../../types/studioSubjectPreparation";
import {useStudioSubjectPreview} from "../../hooks/useStudioSubjectPreview";

export default function StudioSubjectPreview({base,tracking,frame,settings,busy,active}:{
  base:StudioPreparedSubjectBase;tracking:StudioSubjectTracking;frame:number;settings?:StudioFinishingSettings;busy:boolean;active:boolean;
}) {
  const preview=useStudioSubjectPreview(base,tracking,frame,settings,active);
  const [view,setView]=useState<"before"|"after">("after"),[actual,setActual]=useState(false);
  const image=preview.response&&(view==="before"?preview.response.beforeDataUrl:preview.response.dataUrl);
  return <section className="studio-subject-preview" aria-label="Full-resolution finishing comparison">
    <header><h4>Finishing comparison</h4><span>{base.width}×{base.height} · frame {frame}</span></header>
    <p>Render this frame through the real picture filter. Changing filters, prompts or frames clears the comparison; update it when ready. Cached stabilization and masks are reused.</p>
    <div className="studio-subject-toolbar">
      <button type="button" className="btn-secondary" disabled={busy||preview.pending||!settings?.enabled} onClick={()=>void preview.generate()}>
        {preview.pending?"Rendering full-resolution frame…":"Update full-resolution comparison"}</button>
      {preview.pending&&<button type="button" className="btn-secondary" onClick={preview.cancel}>Cancel frame preview</button>}
      {preview.response&&<><div role="group" aria-label="Comparison image">
        <button type="button" aria-pressed={view==="before"} onClick={()=>setView("before")}>Before</button>
        <button type="button" aria-pressed={view==="after"} onClick={()=>setView("after")}>After</button>
      </div><label><input type="checkbox" checked={actual} onChange={event=>setActual(event.target.checked)}/> Inspect at 100% pixels</label></>}
    </div>
    {!settings?.enabled&&<p>Enable Subject finishing in Project settings → Filters to compare its effect.</p>}
    {preview.error&&<p role="alert">{preview.error}</p>}
    {image&&<figure><div className={`studio-subject-comparison-image${actual?" actual-pixels":""}`} tabIndex={actual?0:undefined}
      aria-label={actual?"Full-resolution comparison; scroll to inspect details":undefined}>
      <img src={image} width={base.width} height={base.height} alt={`${view==="before"?"Stabilized base before finishing":"Horse and rider after subject finishing"}, exact frame ${frame}`}/>
      </div><figcaption>{view==="before"?"Before · stabilized base":"After · subject finishing"} · {base.width}×{base.height}. Before final video encoding, titles and scorecards. This still-frame check is not temporal or export qualification.</figcaption></figure>}
  </section>;
}
