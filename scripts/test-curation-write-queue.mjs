import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
const code=ts.transpileModule(readFileSync(new URL("../src/utils/curationWriteQueue.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {CurationWriteQueue}=await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
const request={root:"synthetic-root",assetId:"original",relativePath:"shot.jpg",selected:true};
const receipt=r=>({assetId:r.assetId,relativePath:r.relativePath,selected:r.selected??false,favourite:r.favourite??false,revision:1});
let release;const seen=[];
const queue=new CurationWriteQueue(async r=>{seen.push(r);if(seen.length===1)await new Promise(resolve=>release=resolve);return receipt(r);});
const first=queue.enqueue(request);const second=queue.enqueue({...request,selected:false});await Promise.resolve();assert.equal(seen.length,1);request.relativePath="changed-after-enqueue.jpg";release();await Promise.all([first,second]);assert.equal(seen[0].relativePath,"shot.jpg");assert.equal(seen[1].selected,false);await queue.settled();console.log("PASS serial writes capture immutable exact identities and retain submission order");
let fail=true;const recovery=new CurationWriteQueue(async r=>{if(fail)throw Error("synthetic write failure");return receipt(r);});
await assert.rejects(recovery.enqueue({...request,selected:true}));fail=false;await recovery.enqueue({...request,selected:undefined,favourite:true});assert.match(recovery.error(request.root),/checkbox/);await recovery.enqueue({...request,selected:false});assert.equal(recovery.error(request.root),"");console.log("PASS unrelated favourite success retains failed-checkbox recovery until a checkbox retry succeeds");
for(const mismatch of [{assetId:"wrong-photo"},{relativePath:"different.jpg"},{selected:"yes"},{revision:NaN}]) {
 const bad=new CurationWriteQueue(async r=>({...receipt(r),...mismatch}));await assert.rejects(bad.enqueue(request),/acknowledgement/);assert.match(bad.error(request.root),/not confirmed/);assert.equal(bad.error("different-root"),"");
}
console.log("PASS malformed or wrong-identity acknowledgements never confirm a save; failures remain root-scoped");
const bounded=new CurationWriteQueue(async()=>{throw Error("synthetic dual-field failure");});
for(let n=0;n<65;n++)await assert.rejects(bounded.enqueue({...request,root:`root-${n}`,selected:true,favourite:true}));
let retained=0;for(let n=0;n<65;n++)if(bounded.error(`root-${n}`))retained++;
assert.ok(retained<=32,"Dual-field failures must remain within the64-field recovery bound");
console.log("PASS repeated dual-field failures retain a bounded recovery history");
console.log("PASS 4 curation persistence boundary checks");
