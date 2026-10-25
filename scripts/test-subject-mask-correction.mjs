// Public owned mask-job request/result seam; unshipped scripted external model.
// This does not qualify the real model, runtime distribution or picture quality.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {test} from 'node:test';

const runtime=resolve('.build-cache/subject-finishing-manual-cpu-v1');
const python=join(runtime,'runtime/python.exe');
const owner=resolve('src-tauri/tools/subject-finishing/photogogo-subject-finishing.exe');
const fixture=resolve('scripts/subject-finishing/mask-correction-fixture.py');
const ff='C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe';
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(digest(owner),'db0e3b20e52cfad9d4e3eceafab2c347631c570e40fc4a5a14d6cc5628e4417d');
assert.equal(digest(ff),'898c1ea98f42755b57f1ef845ab50fc7cb1840fc6c1d64f2f0d150727fbc5630');

function runCase(mode,{seam=false,both=false,reacquisition=false,reverse=false,correctedObject='horse'}={}) {
  const folder=mkdtempSync(resolve('test-output/subject-mask-correction-'));
  const source=join(folder,'base.mp4'),frames=seam?9:4;
  const video=spawnSync(ff,['-v','error','-nostdin','-n','-f','lavfi','-i',
    'color=c=0x707c80:size=160x96:rate=5','-frames:v',String(frames),'-c:v','libx264',
    '-threads','1','-pix_fmt','yuv420p','-color_range','tv','-color_primaries','bt709',
    '-color_trc','bt709','-colorspace','bt709',
    '-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709',source],
    {timeout:10000,windowsHide:true,maxBuffer:65536});
  assert.equal(video.status,0,video.stderr?.toString());
  const identity=createHash('md5').update(readFileSync(source)).digest('hex');
  const before=digest(source),destination=join(folder,'mask-cache.partial'),reference=reverse?2:0;
  const corrected=reverse?0:reacquisition?3:seam?4:2;
  const anchors=[{frame:reference,object:'horse',box:[.125,.3125,.4375,.8333]},
    {frame:reference,object:'rider',box:[.5,.052,.75,.3125]},
    {frame:corrected,object:correctedObject,points:[{x:.25,y:.5,include:true}]}];
  if(both)anchors.push({frame:corrected,object:correctedObject==='horse'?'rider':'horse',points:[{x:.875,y:.2,include:true}]});
  const request={version:1,sourcePath:source,baseChecksum:identity,width:160,height:96,fps:5,
    frameCount:frames,windowFrames:seam?6:4,overlapFrames:seam?3:2,destinationPath:destination,
    selection:{version:1,baseIdentity:identity,frameCount:frames,referenceFrame:reference,anchors}};
  const requestFile=join(folder,`${mode}.json`);
  writeFileSync(requestFile,JSON.stringify(request),{flag:'wx'});
  const child=spawnSync(owner,['--mask-job',python,fixture,requestFile,runtime,ff,'30','1'],
    {timeout:35000,windowsHide:true,maxBuffer:65536});
  writeFileSync(join(folder,'stdout.txt'),child.stdout??Buffer.alloc(0),{flag:'wx'});
  writeFileSync(join(folder,'stderr.txt'),child.stderr??Buffer.alloc(0),{flag:'wx'});
  assert.equal(child.error,undefined);
  assert.equal(digest(source),before,'The real source fixture must remain immutable');
  return {folder,destination,child,frames};
}

test('a horse-only correction cannot waive an abrupt uncorrected rider change',()=>{
  const {folder,destination,child}=runCase('adjacent-horse-only');
  assert.notEqual(child.status,0,`Uncorrected rider change was accepted; retained ${folder}`);
  assert.match(child.stderr.toString(),/Abrupt subject-mask change at frame 2/);
  assert.match(child.stderr.toString(),/Abrupt subject-mask change at frame 2 \(rider, forward, IoU 0\.0000\)/,
    'The user must know which uncorrected object caused the refusal');
  assert.equal(existsSync(join(destination,'manifest.json')),false,'No completed mask manifest may be published');
  assert.doesNotMatch(child.stdout.toString(),/progress=end/);
});

test('a horse-only correction cannot waive independent rider overlap disagreement',()=>{
  const {folder,destination,child}=runCase('seam-horse-only',{seam:true});
  assert.notEqual(child.status,0,`Uncorrected rider seam was accepted; retained ${folder}`);
  assert.match(child.stderr.toString(),/Subject identity is uncertain at held-out seam frame 4/);
  assert.equal(existsSync(join(destination,'manifest.json')),false);
  assert.doesNotMatch(child.stdout.toString(),/progress=end/);
});

test('an absent rider cannot be silently reacquired by a horse-only reference',()=>{
  const {folder,destination,child}=runCase('absence-horse-only',{reacquisition:true});
  assert.notEqual(child.status,0,`Unreferenced rider reacquisition was accepted; retained ${folder}`);
  assert.match(child.stderr.toString(),/Object 2 needs a reference correction after absence at frame 3/);
  assert.equal(existsSync(join(destination,'manifest.json')),false,'Uncertain identity cannot publish completed masks');
  assert.doesNotMatch(child.stdout.toString(),/progress=end/);
});

for(const [mode,options,error] of [
  ['absence-horse-dropout',{reacquisition:true,correctedObject:'rider'},/Object 1 needs a reference correction after absence at frame 3/],
  ['reverse-absence-horse-only',{reverse:true},/Object 2 needs a reference correction after absence at frame 0/],
  ['overlap-absence-horse-only',{seam:true},/Object 2 needs a reference correction after absence at frame 4/],
  ['handoff-remains-absent',{seam:true},/Object 2 needs a visible reference at frame 3; empty window handoff cannot prove identity/],
]) {
  test(`${mode}: uncertain object identity cannot publish completed masks`,()=>{
    const {folder,destination,child}=runCase(mode,options);
    assert.notEqual(child.status,0,`Uncertain identity was accepted; retained ${folder}`);
    assert.match(child.stderr.toString(),error);
    assert.equal(existsSync(join(destination,'manifest.json')),false);
    assert.doesNotMatch(child.stdout.toString(),/progress=end/);
  });
}

for(const [mode,options] of [['adjacent-both',{both:true}],['adjacent-stable',{}],
  ['absence-both',{both:true,reacquisition:true}],['absence-stays-absent',{}],
  ['reverse-absence-both',{both:true,reverse:true}],
  ['absence-rider-only',{reacquisition:true,correctedObject:'rider'}],['absence-horse-dropout',{reacquisition:true}]]) {
  test(`${mode}: deliberate correction and stable uncorrected objects remain usable`,()=>{
    const {destination,child,frames}=runCase(mode,options);
    assert.equal(child.status,0,child.stderr.toString());
    const manifest=JSON.parse(readFileSync(join(destination,'manifest.json'),'utf8'));
    assert.equal(manifest.complete,true);
    assert.equal(manifest.frames,frames);
    assert.equal(manifest.subjectQualityAccepted,false);
    assert.equal(manifest.generationProfile[5],'fixed-two-id-object-reacquisition-seam-v3');
    if(mode==='absence-both')assert.equal(manifest.emptyObjectFrameObservations,1);
    if(mode==='absence-rider-only'||mode==='absence-horse-dropout')assert.equal(manifest.emptyObjectFrameObservations,1);
    if(mode==='absence-stays-absent')assert.equal(manifest.emptyObjectFrameObservations,2);
    assert.match(child.stdout.toString(),/progress=end/);
  });
}
