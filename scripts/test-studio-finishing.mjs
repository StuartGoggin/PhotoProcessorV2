import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";

// Exercise the settings interface used by saved projects and the editor.
const bundle = await build({ entryPoints: ["src/utils/studioFinishing.ts"], bundle: true,
  write: false, format: "esm", platform: "node" });
const finishing = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const moduleAt = async (path) => {
  const built = await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node'});
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
};
const workflow = await moduleAt('src/utils/studioWorkflow.ts');
const {newProject} = await moduleAt('src/types/videoStudio.ts');
const selection = () => ({version:1,baseIdentity:'a'.repeat(32),frameCount:100,referenceFrame:10,anchors:[
  {frame:10,object:'horse',box:[.2,.3,.8,.9]}, {frame:10,object:'rider',box:[.4,.1,.6,.5]},
  {frame:2,object:'horse',points:[{x:.5,y:.6,include:true}]},
]});

test("a project without finishing settings keeps its existing picture untouched", () => {
  const effective = finishing.effectiveFinishing(undefined);
  assert.equal(effective.enabled, false);
  assert.equal(finishing.finishingRecipe(undefined), null);
  assert.equal(effective.colourScope, "subject");
  assert.equal(effective.subject, "horseRider");
});

test("enabling subject finishing creates a stable, independently cacheable recipe", () => {
  const effective = finishing.effectiveFinishing({ enabled: true });
  assert.equal(effective.enabled, true);
  assert.equal(effective.basePolicy, "reuse");
  assert.equal(effective.sharpening.amount, 0.2);
  assert.equal(effective.wholeFrame.enabled, false);
  const recipe = finishing.finishingRecipe({ enabled: true });
  assert.ok(recipe);
  assert.deepEqual(recipe, finishing.finishingRecipe(effective));
  assert.notDeepEqual(recipe, finishing.finishingRecipe({
    enabled: true, sharpening: { amount: 0.4 },
  }));
});

test('object reacquisition checks stale older finishing recipes without changing prompts',()=>{
  const settings=finishing.effectiveFinishing({enabled:true});
  const current=finishing.clipFinishingRecipe(settings,selection());
  assert.equal(current[2][7],'fixed-two-id-object-reacquisition-seam-v3');
  for(const policy of ['fixed-two-id-held-out-seam-v1','fixed-two-id-object-corrections-seam-v2']) {
    const legacy=structuredClone(current);legacy[2][7]=policy;
    assert.notDeepEqual(current,legacy);
    assert.deepEqual(current[3],legacy[3],'Existing user selection is preserved');
    assert.deepEqual(current[1],legacy[1],'Effect settings are not changed');
  }
  assert.equal(finishing.clipFinishingRecipe({enabled:false},selection()),null);
});

test("invalid saved recipes fail before rendering instead of widening the effect", () => {
  for (const value of [
    { version: 2, enabled: true },
    { enabled: "yes" },
    { subject: "everything" },
    { basePolicy: "discard" },
    { sharpening: { amount: -1 } },
    { sharpening: { amount: Infinity } },
    { sharpening: { noiseThreshold: 0 } },
    { colour: { lightEv: 4 } },
    { colour: { exposureEv: 0.3 } },
    { sharpening: { noiseThresholdd: 0 } },
    { wholeFrame: { enabled: "true" } },
  ]) {
    assert.throws(() => finishing.effectiveFinishing(value), /finishing/i);
  }
  assert.equal(finishing.finishingRecipe({ enabled: false, colour: { lightEv: 1 } }), null);
});

test('selection identity uses explicit reference, protects corrections and rejects unknown fields', () => {
  const saved = selection(), recipe = finishing.selectionRecipe(saved);
  const identity = JSON.stringify(recipe); saved.anchors[0].box[0] = .1;
  assert.equal(JSON.stringify(recipe), identity, 'Recipe is an immutable prompt snapshot');
  assert.notDeepEqual(finishing.selectionRecipe(saved), recipe);
  for(const mutate of [v=>v.referenceFrame=2,v=>v.referenceFrame=true,v=>v.frameCount=0,
    v=>v.baseIdentity='unknown',v=>v.extra='ignored',v=>v.anchors[0].extra='ignored',
    v=>v.anchors[2].points[0].include='yes',v=>v.anchors[0].box=[.8,.3,.2,.9]]) {
    const bad=selection();mutate(bad);assert.throws(()=>finishing.selectionRecipe(bad), /finishing|subject/i);
  }
});

test('enabled finishing stales completed/queued pictures and final sequence but not disabled legacy recipes', () => {
  const clip={id:'one',path:'D:/synthetic/one.mp4',duration:10,include:true,chapter:'One',title:'',titleSeconds:0,
    stabilization:'balanced',stabilizationMethod:'quality',customStabilization:{radius:16,blockSize:8,contrast:125},
    framing:'edgeSafe',reviewed:true,notes:'',replays:[],revision:0};
  const p={...newProject(),clips:[clip]};
  const rendered={path:'D:/synthetic/old.mp4',width:p.width,height:p.height,fps:p.fps,bitrateMbps:p.bitrateMbps,
    revision:0,signature:'legacy',renderedAt:'2026-10-10',duration:10};
  assert.equal(workflow.isClipReady({...clip,rendered},p),true);
  const enabled={...p,finishing:finishing.effectiveFinishing({enabled:true}),clips:[{...clip,finishingSelection:selection()}]};
  assert.equal(workflow.isClipReady({...enabled.clips[0],rendered},enabled),false);
  const recipe=workflow.sequenceRecipe(enabled);assert.equal(recipe[0],6);assert.equal(recipe.length,10);
  assert.equal(workflow.sequenceStatus({sequence:recipe},enabled),'current');
  assert.equal(workflow.sequenceStatus({sequence:recipe},p),'outdated');
  const finished={...rendered,finishingRecipe:finishing.clipFinishingRecipe(enabled.finishing,enabled.clips[0].finishingSelection)};
  assert.equal(workflow.isClipReady({...enabled.clips[0],rendered:finished},enabled),true);
  const edited=workflow.editClip({...enabled.clips[0],rendered:finished},{finishingSelection:{...selection(),anchors:[...selection().anchors,
    {frame:20,object:'horse',box:[.2,.3,.7,.8]}]}});
  assert.equal(edited.revision,1);assert.equal(edited.rendered.path,finished.path);
  const job={id:'stale',kind:'clip',status:'running',width:p.width,height:p.height,fps:p.fps,bitrateMbps:p.bitrateMbps,
    targets:[{clipId:clip.id,sourcePath:clip.path,revision:0}]};
  assert.equal(workflow.clipJob(enabled.clips[0],enabled,[job]),undefined);
  const disabled={...enabled,finishing:finishing.effectiveFinishing({enabled:false})};
  assert.deepEqual(workflow.sequenceRecipe(disabled),workflow.sequenceRecipe(p));
});

test('retired engine provenance never adopts a historical render or running job as legacy work', () => {
  const clip={id:'one',path:'D:/synthetic/one.mp4',duration:10,include:true,chapter:'One',title:'',titleSeconds:0,
    stabilization:'off',stabilizationMethod:'quality',customStabilization:{radius:16,blockSize:8,contrast:125},
    framing:'edgeSafe',reviewed:true,notes:'',replays:[],revision:0};
  const p={...newProject(),clips:[clip]};
  const rendered={path:'D:/synthetic/old.mp4',width:p.width,height:p.height,fps:p.fps,bitrateMbps:p.bitrateMbps,
    revision:0,signature:'legacy',renderedAt:'2026-10-10',duration:10};
  const job={id:'retired',kind:'clip',status:'running',width:p.width,height:p.height,fps:p.fps,bitrateMbps:p.bitrateMbps,
    targets:[{clipId:clip.id,sourcePath:clip.path,revision:0,stabilizationEngine:'gpu-tripod-d3d11-v1'}]};
  assert.equal(workflow.isClipReady({...clip,rendered},p),true);
  assert.equal(workflow.isClipReady({...clip,rendered:{...rendered,stabilizationEngine:'gpu-tripod-d3d11-v1'}},p),false);
  assert.equal(workflow.clipJob(clip,p,[job]),undefined);
  const obsolete={...p,defaultStabilizationMethod:'gpuTripod',clips:[{...clip,stabilizationMethod:'gpuTripod'}]};
  const normalized=workflow.normalizeProject(obsolete);
  assert.equal(normalized.defaultStabilizationMethod,'gpuTripod','Unknown saved choices are not silently replaced');
  assert.equal(normalized.clips[0].stabilizationMethod,'gpuTripod');
});
