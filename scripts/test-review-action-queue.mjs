import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const file = new URL("../src/utils/reviewActionQueue.ts", import.meta.url);
let Queue;
try {
  const source = ts.transpileModule(readFileSync(file,"utf8"), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  Queue = (await import("data:text/javascript;base64,"+Buffer.from(source).toString("base64"))).ReviewActionQueue;
} catch (error) { if(error.code!=="ENOENT")throw error; }
assert.equal(typeof Queue,"function","Fast review needs an ordered bounded persistence queue");
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const req=id=>({stagingDir:"D:/synthetic",actionId:id});
let release, calls=[];
const queue=new Queue(async request=>{calls.push(request.actionId);if(request.actionId==="trash")await new Promise(resolve=>release=resolve);return request.actionId;},2);
const first=queue.enqueue(req("trash")),undo=queue.enqueue(req("undo"));
await tick();assert.deepEqual(calls,["trash"],"Undo cannot overtake its pending Trash");
await assert.rejects(queue.enqueue(req("overflow")),/pending|wait/i);
release();assert.deepEqual(await Promise.all([first,undo]),["trash","undo"]);await queue.settled();
assert.equal(queue.snapshot("D:/synthetic").pending,0);

let failing=true, confirmations=[];calls=[];
const failed=new Queue(async request=>{calls.push(request.actionId);if(failing)throw Error("locked synthetic file");return request.actionId;});
await assert.rejects(failed.enqueue(req("a"),value=>confirmations.push(value)),/locked/);
const second=failed.enqueue(req("b"));await tick();
assert.deepEqual(calls,["a"],"A failure pauses subsequent writes instead of changing uncertain identity");
assert.equal(failed.snapshot("D:/synthetic").failures[0].request.actionId,"a");
await assert.rejects(failed.settled(),/locked/);
failing=false;await failed.retry("a");await second;await failed.settled();
assert.deepEqual(calls,["a","a","b"]);assert.deepEqual(confirmations,["a"],"Retry reconciles the original accepted visual decision");
assert.equal(failed.snapshot("D:/synthetic").failures.length,0);

let reconcileFails=true;
const reconcile=new Queue(async request=>request.actionId);
await assert.rejects(reconcile.enqueue(req("reconcile"),()=>{if(reconcileFails)throw Error("display reconciliation failed");}),/reconciliation/);
assert.equal(reconcile.snapshot("D:/synthetic").failures.length,1,"A confirmed write with uncertain local identity must remain recoverable");
reconcileFails=false;await reconcile.retry("reconcile");await reconcile.settled();

const rejectedCalls=[];
const rejected=new Queue(async request=>{rejectedCalls.push(request.actionId);if(request.actionId==="rejected")throw "[Review rejected before acceptance] Source changed";return request.actionId;});
await rejected.enqueue(req("prior-confirmed"));
const rejectedSave=rejected.enqueue(req("rejected"));const dependentUndo=rejected.enqueue(req("dependent-undo")).catch(error=>String(error));
await assert.rejects(rejectedSave,/Source changed/);
assert.equal(typeof rejected.discardRejected,"function","Only proven admission failures need a deliberate discard-and-reload escape");
const discarded=rejected.discardRejected("rejected");assert.equal(discarded.length,2);await dependentUndo;await rejected.settled();
assert.deepEqual(rejectedCalls,["prior-confirmed","rejected"],"A queued dependent Undo must never run against prior confirmed history after rejection");
const uncertain=new Queue(async()=>{throw Error("Unknown post-intent outcome");});await assert.rejects(uncertain.enqueue(req("uncertain")),/Unknown/);
assert.throws(()=>uncertain.discardRejected("uncertain"),/uncertain|cannot|not.*reject/i);assert.equal(uncertain.hasPending(),true);

calls=[];
const long=new Queue(async request=>{calls.push(request.actionId);return request.actionId;},8);
for(let i=0;i<725;i++)await long.enqueue(req(String(i)));
assert.equal(calls.length,725,"The pending limit must not truncate confirmed history");
console.log("PASS ordered Trash/Undo, queue bounds, persistent failure/retry and 725 decisions");

let install;
try{const code=ts.transpileModule(readFileSync(new URL("../src/utils/reviewCloseGuard.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;install=(await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"))).installReviewCloseGuard;}catch(error){if(error.code!=="ENOENT")throw error;}
assert.equal(typeof install,"function","Native window closure must account for pending decisions");
let close,prevented=0,blocked=0,hasPending=true;
await install({onCloseRequested:async callback=>{close=callback;return()=>{};}},()=>hasPending,()=>blocked++);
close({preventDefault:()=>prevented++});assert.equal(prevented,1);assert.equal(blocked,1);
hasPending=false;close({preventDefault:()=>prevented++});assert.equal(prevented,1,"Confirmed saves permit ordinary closure");
console.log("PASS native close guard retains pending decisions and permits closure after confirmation");
