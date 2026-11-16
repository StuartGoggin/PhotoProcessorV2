import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";

let createTransport;
try{
  const source=ts.transpileModule(readFileSync(new URL("../src/utils/reviewActionTransport.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  createTransport=(await import("data:text/javascript;base64,"+Buffer.from(source).toString("base64"))).createReviewActionTransport;
}catch(error){if(error.code!=="ENOENT")throw error;}
assert.equal(typeof createTransport,"function","Replay dispatch needs a per-root confirmed revision fence");
const states=new Map([["root-a",{revision:10,timeline:["prior-A"]}],["root-b",{revision:30,timeline:[]}]]),requests=[],undone=[];
const receipt=(request,state)=>({actionId:request.actionId,revision:state.revision,relativePath:"a.jpg",renamed:[],trashed:true,reviewed:true,sourceStamp:"10:1",canUndo:state.timeline.length>0,canRedo:false,entry:{id:request.actionId},review:{root:request.stagingDir,relativePath:"a.jpg",key:"a.jpg",sourceStamp:"10:1",reviewed:true,revision:state.revision,explicit:true}});
const native=async request=>{
  requests.push({...request});const state=states.get(request.stagingDir);
  if("direction" in request){
    if(request.expectedRevision!==undefined&&request.expectedRevision!==state.revision)throw "[Review rejected before acceptance] Review history changed in another window";
    undone.push(state.timeline.pop());
  }else state.timeline.push(request.actionId);
  state.revision++;return receipt(request,state);
};
const transport=createTransport(native);
const action=(root,id)=>({stagingDir:root,relativePath:"a.jpg",expectedSourceStamp:"10:1",actionId:id,trashed:true});
await transport(action("root-a","own-B"));
states.get("root-a").timeline.push("external-C");states.get("root-a").revision++;
const queuedUndo={stagingDir:"root-a",direction:"undo",actionId:"queued-undo"};
await assert.rejects(transport(queuedUndo),/another window/);
assert.equal(requests.at(-1).expectedRevision,11,"Queued Undo must use the own B receipt revision, not current native history");
assert.deepEqual(undone,[],"Another window's action C must not be undone");
assert.deepEqual(states.get("root-a").timeline,["prior-A","own-B","external-C"]);
await transport(action("root-b","other-root"));
await assert.rejects(transport(queuedUndo),/another window/);
assert.equal(requests.at(-1).expectedRevision,11,"Retry keeps a version fence and cannot inherit another root's newer revision");
await transport({stagingDir:"root-a",direction:"undo",actionId:"fresh-read-undo",expectedRevision:12});
assert.equal(requests.at(-1).expectedRevision,12,"An explicit fresh history revision takes precedence over the older own receipt");
assert.deepEqual(undone,["external-C"]);
await transport({stagingDir:"root-a",direction:"undo",actionId:"next-own-undo"});
assert.equal(requests.at(-1).expectedRevision,13);assert.deepEqual(undone,["external-C","own-B"]);
const fresh=createTransport(native),before=requests.length;
await assert.rejects(fresh({stagingDir:"root-a",direction:"undo",actionId:"no-fence"}),/revision|refresh|history/i);
assert.equal(requests.length,before,"A replay without any trusted revision cannot reach native unversioned");
assert.equal(queuedUndo.expectedRevision,undefined,"Dispatch fencing must not mutate an immutable submitted request");
console.log("PASS queued Undo revision fence, other-window rejection, safe retry, root isolation and explicit fresh history revision");
