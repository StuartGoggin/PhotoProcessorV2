// Generated evidence fixtures only; no model/package imports or media access.
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile, readFile, symlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {readEvidenceFile, storeEvidenceFile, writeEvidenceArtifact, verifyEvidence,
  evidenceDigest, validateEvidencePath, requirePackageMetadataDirectories} from './subject-finishing/runtime/evidence-files.mjs';
import {prepareNoticeEvidence} from './prepare-subject-runtime-notices.mjs';
const root = await mkdtemp(resolve('test-output/subject-evidence-files-'));
const payload = Buffer.from('Synthetic UTF-8 source evidence; never executed.');
const source = join(root,'fixture.py'), stage = join(root,'stage');
await writeFile(source,payload,{flag:'wx'}); await mkdir(stage);
const expected={bytes:payload.length,sha256:evidenceDigest(payload)};
test('exact source bytes are exclusively staged and read back', async () => {
  const record=await storeEvidenceFile(source,stage,'source/fixture.py',expected);
  assert.equal(record.sha256,expected.sha256);
  assert.deepEqual(await readEvidenceFile(join(stage,record.path)),payload);
  assert.deepEqual(await readFile(source),payload);
});
test('existing output refuses overwrite', async () => {
  await assert.rejects(storeEvidenceFile(source,stage,'source/fixture.py',expected),{code:'EEXIST'});
  assert.deepEqual(await readFile(join(stage,'source/fixture.py')),payload);
});
test('wrong source identity refuses output creation', async () => {
  await assert.rejects(storeEvidenceFile(source,stage,'wrong.py',{...expected,sha256:'0'.repeat(64)}),/identity mismatch/);
  await assert.rejects(readFile(join(stage,'wrong.py')),{code:'ENOENT'});
});
test('oversized source fails before allocation/copy', async () => {
  await assert.rejects(readEvidenceFile(source,1),/regular-file bound/);
});
test('missing and non-regular sources fail', async () => {
  await assert.rejects(readEvidenceFile(join(root,'missing.py')),{code:'ENOENT'});
  await assert.rejects(readEvidenceFile(stage),/regular-file bound/);
});
test('independent readback verifier detects changed bytes and size', () => {
  assert.throws(()=>verifyEvidence(Buffer.from('changed'),expected),/identity mismatch/);
  assert.throws(()=>verifyEvidence(payload,{...expected,bytes:payload.length+1}),/identity mismatch/);
});
test('redirected source ancestry refuses read', async () => {
  const linked=join(root,'redirected-source');
  await symlink(root,linked,'junction');
  await assert.rejects(readEvidenceFile(join(linked,'fixture.py')),/Redirected evidence ancestry/);
});
test('redirected target ancestry refuses write', async () => {
  const linked=join(root,'redirected-stage');
  await symlink(stage,linked,'junction');
  await assert.rejects(writeEvidenceArtifact(linked,'refused.py',payload),/Redirected evidence ancestry/);
  await assert.rejects(readFile(join(stage,'refused.py')),{code:'ENOENT'});
});
test('existing descendant junction refuses before creating an external subdirectory',async()=>{
  const external=join(root,'external-target'); await mkdir(external);
  await symlink(external,join(stage,'redirected-descendant'),'junction');
  await assert.rejects(writeEvidenceArtifact(stage,'redirected-descendant/new/notice.txt',payload),/target ancestry/);
  await assert.rejects(readFile(join(external,'new','notice.txt')),{code:'ENOENT'});
  await assert.rejects(readEvidenceFile(join(external,'new')),{code:'ENOENT'});
});
test('complete package metadata directory set passes',async()=>{
  const directory=join(root,'complete-packages');
  await mkdir(join(directory,'a-1.dist-info'),{recursive:true}); await mkdir(join(directory,'b-1.dist-info'));
  assert.deepEqual(await requirePackageMetadataDirectories(directory,['b-1.dist-info','a-1.dist-info']),['a-1.dist-info','b-1.dist-info']);
});
test('entire missing metadata tree refuses inventory, not a smaller successful index',async()=>{
  const directory=join(root,'missing-package'); await mkdir(join(directory,'a-1.dist-info'),{recursive:true});
  await assert.rejects(requirePackageMetadataDirectories(directory,['a-1.dist-info','b-1.dist-info']),/inventory mismatch/);
});
test('unexpected metadata tree refuses inventory',async()=>{
  const directory=join(root,'extra-package'); await mkdir(join(directory,'a-1.dist-info'),{recursive:true}); await mkdir(join(directory,'extra-1.dist-info'));
  await assert.rejects(requirePackageMetadataDirectories(directory,['a-1.dist-info']),/inventory mismatch/);
});
test('metadata-named regular file refuses directory inventory',async()=>{
  const directory=join(root,'file-package'); await mkdir(directory); await writeFile(join(directory,'a-1.dist-info'),payload,{flag:'wx'});
  await assert.rejects(requirePackageMetadataDirectories(directory,['a-1.dist-info']),/Unexpected package metadata directory/);
});
for (const path of ['../escape','/absolute','C:/absolute','a\\b','a/../b','NUL.py','a./b','a /b','a//b','a:stream','a?b']) {
  test('unsafe target '+JSON.stringify(path)+' refuses',()=>assert.throws(()=>validateEvidencePath(path),/Unsafe evidence path/));
}
test('prior evidence outside owned cache refuses before reads/writes', async () => {
  await assert.rejects(prepareNoticeEvidence(root),/Unsafe evidence path|owned cache stage/);
});
test('missing prior stage refuses without network fallback', async () => {
  const oldFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('Network must never be used');};
  try { await assert.rejects(prepareNoticeEvidence(resolve('.build-cache/subject-finishing-notices-missing-fixture')),{code:'ENOENT'}); }
  finally {globalThis.fetch=oldFetch;}
});
const prior=resolve('.build-cache/subject-finishing-notices-1791600763642');
async function priorFixture(mode) {
  const fixture=await mkdtemp(resolve('.build-cache/subject-finishing-notices-fixture-'));
  const report=await readEvidenceFile(join(prior,'notice-index.json'));
  await writeEvidenceArtifact(fixture,'notice-index.json',mode==='receipt' ? Buffer.from('Changed receipt') : report);
  if (mode!=='receipt') {
    const declared=JSON.parse(report).supplementals;
    for (let index=0;index<declared.length;index++) {
      if (mode==='missing'&&index===0) continue;
      await writeEvidenceArtifact(fixture,declared[index].path,mode==='tampered'&&index===0 ? Buffer.from('Changed notice') : await readEvidenceFile(join(prior,declared[index].path)));
    }
  }
  return fixture;
}
for (const [mode,pattern] of [['receipt',/receipt identity mismatch/],['missing',/ENOENT/],['tampered',/identity mismatch/]]) {
  test(mode+' prior evidence refuses before creating new stage',async()=>{
    const fixture=await priorFixture(mode), before=await readFile(join(fixture,'notice-index.json'));
    await assert.rejects(prepareNoticeEvidence(fixture),pattern);
    assert.deepEqual(await readFile(join(fixture,'notice-index.json')),before);
  });
}
test('offline notice stage binds only the exact Python-packaged CRTs to conditional Windows terms',async()=>{
  const oldFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('Network must never be used');};
  let result;
  try { result=await prepareNoticeEvidence(); }
  finally {globalThis.fetch=oldFetch;}
  const receipt=JSON.parse(await readEvidenceFile(join(result.staging,'notice-index.json')));
  assert.equal(result.pythonWindowsRuntimeComponents,2);
  assert.deepEqual(receipt.pythonWindowsRuntime.components.map(({sourcePath,bytes,sha256})=>({sourcePath,bytes,sha256})),[
    {sourcePath:'runtime/vcruntime140.dll',bytes:178616,sha256:'d1f4225df2cd877dbf130d5668a021dce3f94118455ff5ec952061c30afc9ce7'},
    {sourcePath:'runtime/vcruntime140_1.dll',bytes:50112,sha256:'a7146c08f89fe5b04541ab507cdb59ff7b44534d4ba3c668a426c6450a03434e'},
  ]);
  assert.equal(receipt.pythonWindowsRuntime.route,'cpython-windows-binary-build');
  assert.equal(receipt.pythonWindowsRuntime.status,'conditional-evidence-only');
  assert.equal(receipt.pythonWindowsRuntime.recipientTermsVerified,false);
  assert.equal(receipt.pythonWindowsRuntime.installedAvailabilityVerified,false);
  assert.equal(receipt.pythonWindowsRuntime.notice.sha256,'62bec384df47b0328307db41455ff6ea2559e5546b394ac69148561b21703120');
  assert.equal(receipt.redistributionApproved,false);
  assert.equal(receipt.installerQualified,false);
  for (const component of receipt.pythonWindowsRuntime.components) {
    assert.equal(component.origin,'python-embed');
    assert.equal(component.retainedBytesVerified,true);
    assert.equal(component.binaryStaged,false);
    await assert.rejects(readEvidenceFile(join(result.staging,component.sourcePath)),{code:'ENOENT'});
  }
});
test('offline stage makes the complete Python notice and an explanatory recipient guide readable without approving terms',async()=>{
  const result=await prepareNoticeEvidence();
  const receipt=JSON.parse(await readEvidenceFile(join(result.staging,'notice-index.json')));
  const binding=receipt.pythonWindowsRuntime;
  const noticeBytes=await readEvidenceFile(join(result.staging,binding.notice.path));
  assert.deepEqual(noticeBytes,await readEvidenceFile(resolve('.build-cache/subject-finishing-manual-cpu-v1/runtime/LICENSE.txt')));
  const guideBytes=await readEvidenceFile(join(result.staging,binding.recipientGuide.path));
  verifyEvidence(guideBytes,binding.recipientGuide);
  const guide=guideBytes.toString('utf8');
  for (const required of ['vcruntime140.dll','vcruntime140_1.dll','python-3.13.16-LICENSE.txt',
    'protective downstream terms','Microsoft platforms','not recipient assent','not a standalone CRT grant',
    'NumPy','Intel OpenMP','LGPL/MPL']) assert.ok(guide.includes(required),required+' is required in the recipient guide');
  assert.equal(binding.recipientGuide.kind,'generated-explanatory-guide');
  assert.equal(binding.recipientTermsVerified,false);
  assert.equal(binding.installedAvailabilityVerified,false);
  assert.equal(receipt.supplementals.length,4);
  assert.equal(receipt.redistributionApproved,false);
  assert.equal(receipt.installerQualified,false);
});
console.log(JSON.stringify({fixtureRoot:root,fixturesPreserved:true,originalRuntimeTouched:false}));
