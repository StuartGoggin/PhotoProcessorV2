import type {ReviewActionReceipt,ReviewWriteRequest} from "../types/reviewActions";

/** Fence queued replay at dispatch, after earlier own writes have confirmed.
 * Another window's newer action must cause rejection, never become the Undo
 * target merely because native persistence was slower than the input queue. */
export function createReviewActionTransport(persist:(request:ReviewWriteRequest)=>Promise<ReviewActionReceipt>){
  const confirmedRevisions=new Map<string,number>();
  return async(request:ReviewWriteRequest):Promise<ReviewActionReceipt>=>{
    let dispatch=request;
    if("direction" in request){
      const expectedRevision=request.expectedRevision??confirmedRevisions.get(request.stagingDir);
      if(typeof expectedRevision!=="number"||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error("Refresh this folder's review history before Undo / Redo; its confirmed revision is unavailable.");
      dispatch={...request,expectedRevision};
    }
    const result=await persist(dispatch);
    if(!result||result.actionId!==request.actionId||!Number.isSafeInteger(result.revision)||result.revision<0
      ||!result.relativePath||!Array.isArray(result.renamed)||typeof result.trashed!=="boolean"||!result.sourceStamp
      ||!result.entry||!result.review||result.review.root!==request.stagingDir
      ||typeof result.canUndo!=="boolean"||typeof result.canRedo!=="boolean"
      ||typeof result.review.explicit!=="boolean"||typeof result.review.reviewed!=="boolean")
      throw Error("The save acknowledgement did not match this capture. Retry to recover its exact outcome.");
    confirmedRevisions.set(request.stagingDir,result.revision);
    return result;
  };
}
