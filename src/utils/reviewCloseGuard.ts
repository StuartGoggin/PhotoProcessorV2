interface ClosableWindow {onCloseRequested:(callback:(event:{preventDefault:()=>void})=>void)=>Promise<()=>void>}

/** Do not close the native window over queued decisions. A failed save also
 * remains pending until its durable result is reconciled by Retry. */
export function installReviewCloseGuard(window:ClosableWindow,hasPending:()=>boolean,onBlocked:()=>void){
  return window.onCloseRequested(event=>{if(hasPending()){event.preventDefault();onBlocked();}});
}
