export interface ReviewQueueFailure<T> { request:T; message:string }
export const REVIEW_ADMISSION_REJECTION="[Review rejected before acceptance] ";
interface Item<T,R> {
  request:T; status:"pending"|"saving"|"failed"; message:string;
  resolve:(receipt:R)=>void;reject:(error:unknown)=>void;confirmed?:(receipt:R)=>void;
}

/** In-memory ordered transport, shared by mounted and reopened views. The
 * native action journal is the durable authority; tokens make retries safe.
 * A failed head is retained, and later actions never overtake it. */
export class ReviewActionQueue<T extends {stagingDir:string;actionId:string},R> {
  private items:Item<T,R>[]=[];
  private listeners=new Set<()=>void>();
  private receiptListeners=new Set<(request:T,receipt:R)=>void>();
  private discarded:{actionId:string;requests:T[];message:string;count:number}[]=[];
  private running:Promise<void>|null=null;
  constructor(private persist:(request:T)=>Promise<R>,private limit=128){}
  subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  subscribeReceipts(listener:(request:T,receipt:R)=>void){this.receiptListeners.add(listener);return()=>{this.receiptListeners.delete(listener);};}
  private notify(){for(const listener of this.listeners)listener();}
  snapshot(root:string){
    const items=this.items.filter(item=>item.request.stagingDir===root);
    return {pending:items.filter(item=>item.status!=="failed").length,
      failures:items.filter(item=>item.status==="failed").map(item=>({request:item.request,message:item.message})),
      blocked:this.items.some(item=>item.status==="failed"),full:this.items.length>=this.limit};
  }
  hasPending(root?:string){return this.items.some(item=>!root||item.request.stagingDir===root);}
  requests(){return this.items.map(item=>({...item.request}));}
  allFailures(){return this.items.filter(item=>item.status==="failed").map(item=>({request:{...item.request},message:item.message}));}
  discardedNotices(){return [...this.discarded];}
  canDiscardRejected(actionId:string){const head=this.items[0];return !!head&&head.request.actionId===actionId&&head.status==="failed"&&head.message.startsWith(REVIEW_ADMISSION_REJECTION)&&!this.running;}
  discardRejected(actionId:string):T[]{
    if(!this.canDiscardRejected(actionId))throw Error("This uncertain action cannot be discarded. Retry its exact saved outcome.");
    const items=this.items.splice(0),requests=items.map(item=>({...item.request}));
    this.discarded.push({actionId,requests,message:items[0].message,count:items.length});
    // These are recent, explicitly cancelled unsaved requests. Confirmed audit
    // history remains in the native journal and is never truncated here.
    if(this.discarded.length>64)this.discarded.shift();
    for(const item of items)item.reject(Error("Unsaved action deliberately discarded after a confirmed admission rejection."));
    this.notify();return requests;
  }
  enqueue(request:T,confirmed?:(receipt:R)=>void):Promise<R>{
    if(this.items.length>=this.limit)return Promise.reject(Error("Wait for the pending photo decisions to finish saving."));
    const result=new Promise<R>((resolve,reject)=>this.items.push({request:{...request},status:"pending",message:"",resolve,reject,confirmed}));
    this.notify();this.pump();return result;
  }
  async retry(actionId:string){
    const item=this.items.find(item=>item.request.actionId===actionId&&item.status==="failed");
    if(!item)return;
    item.status="pending";item.message="";
    const result=new Promise<R>((resolve,reject)=>{item.resolve=resolve;item.reject=reject;});
    this.notify();this.pump();await result;
  }
  async settled(){
    while(this.items.length){
      const failed=this.items.find(item=>item.status==="failed");
      if(failed)throw Error(failed.message);
      this.pump();await this.running;
    }
  }
  private pump(){
    if(this.running||!this.items.length||this.items[0].status==="failed")return;
    const item=this.items[0];item.status="saving";
    this.running=(async()=>{
      try{const receipt=await this.persist(item.request);item.confirmed?.(receipt);for(const listener of this.receiptListeners)listener(item.request,receipt);this.items.shift();item.resolve(receipt);}
      catch(error){item.status="failed";item.message=error instanceof Error?error.message:String(error);item.reject(error);}
      finally{this.running=null;this.notify();this.pump();}
    })();
    this.notify();
  }
}
