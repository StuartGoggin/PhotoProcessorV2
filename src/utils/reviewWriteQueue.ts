export interface ReviewWriteRequest {root:string;relativePath:string;key:string;sourceStamp:string;reviewed:boolean}
export interface ReviewWriteReceipt extends ReviewWriteRequest {revision:number}
const neutralPath=(path:string)=>{const value=path.replace(/\\/g,"/"),at=value.lastIndexOf("/");return value.slice(0,at+1).toLowerCase()+value.slice(at+1).replace(/\{(?:Like o{1,3}|trash|Out of Focus \d+)\}/gi,"").toLowerCase();};

/** A small metadata writer, shared across roots/remounts. A reserved follow-up
 * includes its primary acknowledgement in the read barrier; it is not a job. */
export class ReviewWriteQueue {
  private tail:Promise<void>=Promise.resolve();
  private pending=0;
  private failures=new Map<string,{request:ReviewWriteRequest;message:string}>();
  constructor(private persist:(request:ReviewWriteRequest)=>Promise<ReviewWriteReceipt>){}
  private key(root:string,path:string){return JSON.stringify([root,neutralPath(path)]);}
  failedValue(root:string,path:string){return this.failures.get(this.key(root,path))?.request.reviewed;}
  failedFor(root:string,path:string){return this.failures.has(this.key(root,path));}
  error(root:string,path?:string){return [...this.failures.values()].filter(f=>f.request.root===root&&(!path||neutralPath(f.request.relativePath)===neutralPath(path))).slice(-1)[0]?.message??"";}
  async settled(){let current:Promise<void>;do{current=this.tail;await current;}while(current!==this.tail);}
  enqueue(request:ReviewWriteRequest){return this.defer(request).complete(true);}
  defer(request:ReviewWriteRequest){
    if(this.pending>=64)throw Error("Wait for pending review decisions to finish saving.");
    const captured={...request};this.pending++;
    let release!:(value:ReviewWriteRequest|null)=>void,completed=false;
    const ready=new Promise<ReviewWriteRequest|null>(resolve=>{release=resolve;});
    const result=this.tail.then(async()=>{
      try{
        const chosen=await ready;if(!chosen)return null;
        if(chosen.root!==captured.root||neutralPath(chosen.relativePath)!==neutralPath(captured.relativePath)||chosen.key!==captured.key||chosen.sourceStamp!==captured.sourceStamp||chosen.reviewed!==captured.reviewed)
          throw Error("The review follow-up identity no longer matches the accepted capture.");
        const receipt=await this.persist(chosen);
        if(!receipt||receipt.root!==chosen.root||receipt.relativePath!==chosen.relativePath||receipt.key!==chosen.key||receipt.sourceStamp!==chosen.sourceStamp||receipt.reviewed!==chosen.reviewed||!Number.isSafeInteger(receipt.revision)||receipt.revision<0)
          throw Error("Review acknowledgement did not match this exact original. Refresh before retrying.");
        this.failures.delete(this.key(captured.root,captured.relativePath));return receipt;
      }catch(error){
        const key=this.key(captured.root,captured.relativePath);this.failures.delete(key);this.failures.set(key,{request:captured,message:"Reviewed status was not saved: "+String(error)});
        while(this.failures.size>64)this.failures.delete(this.failures.keys().next().value!);
        throw error;
      }finally{this.pending--;}
    });
    this.tail=result.then(()=>{},()=>{});
    return {complete:(primarySaved:boolean,replacement?:ReviewWriteRequest)=>{if(!completed){completed=true;release(primarySaved?{...(replacement??captured)}:null);}return result;}};
  }
}
