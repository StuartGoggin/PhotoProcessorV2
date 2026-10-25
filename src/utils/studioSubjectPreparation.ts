import type { StudioClip, StudioProject } from "../types/videoStudio";
import type { StudioPreparedSubjectBase, StudioSubjectFrame } from "../types/studioSubjectPreparation";
import { effectiveFinishing } from "./studioFinishing";
import { effectivePreventRotation } from "./studioStabilization";

/** UI stale-response guard only; native byte leases/provenance are authoritative. */
export function subjectBaseRecipe(p:StudioProject,c:StudioClip):string {
  const finishing=effectiveFinishing(p.finishing);
  return JSON.stringify([1,c.id,c.path,c.duration,c.stabilization,c.stabilizationMethod,
    c.stabilizationMethod==="fast"&&c.stabilization==="custom"?c.customStabilization:null,
    effectivePreventRotation(p,c),c.framing,p.width,p.height,p.fps,p.bitrateMbps,
    p.encoderPreference,finishing.enabled?finishing.basePolicy:"reuse"]);
}

/** object-fit:contain coordinates; exclude letterbox bars, never clamp them into
 * a subject. Actual image and overlay must share this exact display transform. */
export function subjectDisplayPoint(clientX:number,clientY:number,
  rect:{left:number;top:number;width:number;height:number},width:number,height:number):{x:number;y:number}|null {
  if (![clientX,clientY,rect.left,rect.top,rect.width,rect.height,width,height].every(Number.isFinite)
      ||rect.width<=0||rect.height<=0||width<=0||height<=0)return null;
  const scale=Math.min(rect.width/width,rect.height/height);
  const w=width*scale,h=height*scale,left=rect.left+(rect.width-w)/2,top=rect.top+(rect.height-h)/2;
  const x=(clientX-left)/w,y=(clientY-top)/h;
  return x<0||x>1||y<0||y>1?null:{x,y};
}

export function subjectFrameMatches(base:StudioPreparedSubjectBase,frame:number,response:StudioSubjectFrame):boolean {
  return Number.isSafeInteger(frame)&&frame>=0&&frame<base.frameCount
    &&response.preparationId===base.id&&response.baseIdentity===base.identity&&response.frame===frame
    &&/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(response.dataUrl);
}

export function subjectBaseMatches(value:StudioPreparedSubjectBase,clipId:string):boolean {
  return value.version===1&&value.clipId===clipId&&typeof value.id==="string"&&value.id.length>0
    &&/^[a-f0-9]{32}$/.test(value.identity)&&[value.width,value.height,value.fps,value.frameCount].every(Number.isSafeInteger)
    &&value.width>0&&value.width<=7680&&value.height>0&&value.height<=4320
    &&[25,30,50,60].includes(value.fps)&&value.frameCount>0&&value.frameCount<=1_800_000
    &&["reuse","clean"].includes(value.basePolicy)&&Array.isArray(value.warnings)
    &&value.warnings.every(warning=>typeof warning==="string");
}

export interface SubjectReadState { frame:number; response?:StudioSubjectFrame; reading:boolean; error:string }
/** One live RPC plus one latest intent. A stopped reader never publishes late
 * replies; busy admission has one bounded retry, not an unbounded request queue. */
export class SubjectFrameReader {
  private closed=false;
  private running=false;
  private latest:number|null=null;
  private revision=0;
  private retry:ReturnType<typeof setTimeout>|null=null;
  private retryCount=0;
  private state:SubjectReadState={frame:0,reading:false,error:""};
  constructor(private base:StudioPreparedSubjectBase,
    private read:(frame:number)=>Promise<StudioSubjectFrame>,private changed:(state:SubjectReadState)=>void) {}
  request(frame:number):void {
    if(this.closed)return;
    if(!Number.isSafeInteger(frame)||frame<0||frame>=this.base.frameCount)throw new Error("Choose an integer frame in this stabilized base.");
    this.revision++;this.retryCount=0;this.latest=frame;
    if(this.retry){clearTimeout(this.retry);this.retry=null;}
    this.publish({frame,reading:true,error:""});void this.pump();
  }
  stop():void {this.closed=true;this.latest=null;if(this.retry)clearTimeout(this.retry);this.retry=null;}
  private publish(state:SubjectReadState):void {this.state=state;if(!this.closed)this.changed(state);}
  private async pump():Promise<void> {
    if(this.closed||this.running||this.latest===null||this.retry)return;
    const frame=this.latest,revision=this.revision;this.latest=null;this.running=true;
    try {
      const response=await this.read(frame);
      if(!this.closed&&revision===this.revision) {
        if(!subjectFrameMatches(this.base,frame,response))throw new Error("Frame response did not match this exact stabilized base.");
        this.publish({frame,response,reading:false,error:""});
      }
    }catch(error) {
      if(!this.closed&&revision===this.revision) {
        const text=String(error);
        if(text.includes("Subject frame reader is busy")&&this.retryCount<1) {
          this.retryCount++;this.latest=frame;
          this.retry=setTimeout(()=>{this.retry=null;void this.pump();},350);
        }else this.publish({frame,reading:false,error:text});
      }
    }finally {this.running=false;if(!this.closed&&!this.retry)void this.pump();}
  }
}
