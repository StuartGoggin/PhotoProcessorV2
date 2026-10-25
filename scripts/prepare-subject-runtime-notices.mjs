// Offline evidence staging, not runtime execution or redistribution approval.
import {mkdir} from 'node:fs/promises';
import {resolve, join, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {describePackageEvidence} from './subject-finishing/runtime/notice-evidence.mjs';
import {assertEvidenceAncestry, readEvidenceFile, storeEvidenceFile, writeEvidenceArtifact,
  evidenceDigest, validateEvidencePath, verifyEvidence, requirePackageMetadataDirectories} from './subject-finishing/runtime/evidence-files.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const seal = '3305693bb725b3d003c25381d3c02e381646fec5ee7dbad483f21e36448b2c78';
const previousReceiptSha256 = '52af6cd69cf935d3c4ff2f869c7a3e73adf832fc55d8d701b4e47f62657e5680';
const pythonWindowsFiles = [
  {sourcePath:'runtime/vcruntime140.dll',bytes:178616,sha256:'d1f4225df2cd877dbf130d5668a021dce3f94118455ff5ec952061c30afc9ce7'},
  {sourcePath:'runtime/vcruntime140_1.dll',bytes:50112,sha256:'a7146c08f89fe5b04541ab507cdb59ff7b44534d4ba3c668a426c6450a03434e'},
];
const pythonWindowsGuide = `Python Windows runtime conditions guide

This is a PhotoGoGo explanatory evidence guide, not a replacement licence, legal approval or recipient assent.
It concerns only the exact Python 3.13.16 packaged vcruntime140.dll and vcruntime140_1.dll identified in notice-index.json.
Read the complete python-3.13.16-LICENSE.txt, especially "Additional Conditions for this Windows binary build".
Publisher reference: https://raw.githubusercontent.com/python/cpython/v3.13.16/PC/crtlicense.txt

The publisher's conditional Python Windows binary-build route is not a standalone CRT grant.
Before distribution, provide protective downstream terms for distributors and external end users covering Microsoft's Distributable Code.
Preserve Microsoft's copyright, trademark and patent notices; do not imply Microsoft endorsement.
Respect the restriction to Microsoft platforms and do not include the Microsoft component in malicious, deceptive or unlawful programs.
These Microsoft restrictions do not relicense Python generally or programs running on the interpreter.

Staging these files is not recipient assent. Appropriate distribution/installer terms and extracted-payload availability still require verification.
No Visual Studio entitlement is asserted. NumPy's separately bundled Microsoft CRT and both Intel OpenMP grants remain unresolved.
Model/source rights and LGPL/MPL source obligations are separate and are not overridden by this guide.
No runtime DLLs are included in this evidence stage; no redistribution, installer or video-quality approval is granted.
`;
const supplementals = [
  {path:'ANTLR4-4.9.3-LICENSE.txt',sourceUrl:'https://raw.githubusercontent.com/antlr/antlr4/4.9.3/LICENSE.txt',bytes:2699,sha256:'b1b379fcaf3219593a4c433feb1b35c780bed23fafaae440b1ae2771a9521e3a',role:'licence-notice'},
  {path:'Inter-66647c0bb-OFL.txt',sourceUrl:'https://raw.githubusercontent.com/rsms/inter/66647c0bb/LICENSE.txt',bytes:4380,sha256:'262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a',role:'licence-notice'},
  {path:'distlib-0.4.2-LICENSE.txt',sourceUrl:'https://raw.githubusercontent.com/pypa/distlib/0.4.2/LICENSE.txt',bytes:14531,sha256:'808e10c8a6ab8deb149ff9b3fb19f447a808094606d712a9ca57fead3552599d',role:'licence-notice'},
  {path:'distlib-0.4.2-launcher.c',sourceUrl:'https://raw.githubusercontent.com/pypa/distlib/0.4.2/PC/launcher.c',bytes:33362,sha256:'a0e60a3e9717a2e519120ae19d9c81564f934f38aa322062c26dc21e6c10c0fd',role:'publisher-source-evidence'},
];
const decoder = new TextDecoder('utf-8', {fatal:true});
const relativeToPack = (pack, path) => relative(pack, path).replaceAll('\\','/');

export async function prepareNoticeEvidence(previousStage = join(repo,'.build-cache/subject-finishing-notices-1791600763642')) {
  const cache = join(repo,'.build-cache');
  previousStage = resolve(previousStage);
  const oldRelative = relative(cache, previousStage).replaceAll('\\','/');
  validateEvidencePath(oldRelative);
  if (oldRelative.includes('/') || !oldRelative.startsWith('subject-finishing-notices-')) throw new Error('Prior notice stage must be an owned cache stage');
  await assertEvidenceAncestry(previousStage);
  const oldBytes = await readEvidenceFile(join(previousStage,'notice-index.json'),4*1024*1024);
  if (evidenceDigest(oldBytes) !== previousReceiptSha256) throw new Error('Prior notice receipt identity mismatch');
  const old = JSON.parse(decoder.decode(oldBytes));
  if (old.schema !== 2 || old.redistributionApproved !== false || old.packSeal !== seal || old.supplementals.length !== 4) throw new Error('Unexpected prior evidence receipt');
  for (const expected of supplementals) {
    const matches = old.supplementals.filter(record => record.path === expected.path);
    if (matches.length !== 1 || ['path','sourceUrl','bytes','sha256'].some(key => matches[0][key] !== expected[key])) throw new Error('Prior supplemental declaration mismatch');
    verifyEvidence(await readEvidenceFile(join(previousStage,expected.path),512*1024),expected);
  }
  const pack = join(cache,'subject-finishing-manual-cpu-v1');
  const manifestBytes = await readEvidenceFile(join(pack,'runtime-manifest.json'),8*1024*1024);
  if (evidenceDigest(manifestBytes) !== seal) throw new Error('Referenced runtime inventory identity mismatch');
  const manifest = JSON.parse(decoder.decode(manifestBytes));
  const expectedFiles = new Map(manifest.files.map(record => [record.path,record]));
  const pythonWindowsComponents=[];
  for (const expected of pythonWindowsFiles) {
    const record=expectedFiles.get(expected.sourcePath);
    if (!record || record.origin!=='python-embed' || record.bytes!==expected.bytes || record.sha256!==expected.sha256) throw new Error('Python Windows component inventory mismatch');
    verifyEvidence(await readEvidenceFile(join(pack,expected.sourcePath),512*1024),expected);
    pythonWindowsComponents.push({...expected,origin:record.origin,retainedBytesVerified:true,binaryStaged:false,
      noticePath:'python-3.13.16-LICENSE.txt'});
  }
  const pythonNotice=expectedFiles.get('runtime/LICENSE.txt');
  if (!pythonNotice || pythonNotice.origin!=='python-embed' || pythonNotice.bytes!==33861 || pythonNotice.sha256!=='62bec384df47b0328307db41455ff6ea2559e5546b394ac69148561b21703120') throw new Error('Python Windows notice inventory mismatch');
  const site=join(pack,'runtime/Lib/site-packages'), components=[];
  const inventories=[{directory:site,prefix:'packages'},{directory:join(site,'setuptools/_vendor'),prefix:'vendored/setuptools'}];
  for (const inventory of inventories) {
    const prefix=relativeToPack(pack,inventory.directory)+'/';
    const expectedNames=manifest.files.filter(record=>record.path.startsWith(prefix)&&record.path.endsWith('/METADATA'))
      .map(record=>record.path.slice(prefix.length)).filter(path=>path.split('/').length===2&&path.split('/')[0].endsWith('.dist-info'))
      .map(path=>path.split('/')[0]);
    inventory.names=await requirePackageMetadataDirectories(inventory.directory,expectedNames);
  }
  // This checks the pinned inventory identity, not every runtime/model byte.
  const staging = join(cache,`subject-finishing-notices-${randomUUID()}`);
  await assertEvidenceAncestry(cache); await mkdir(staging);
  let stagedBytes=0, stagedFiles=0;
  async function store(source,target,expected=null) {
    if (!expected) expected=expectedFiles.get(relativeToPack(pack,source));
    if (!expected) throw new Error('Source missing from pinned runtime inventory');
    if (++stagedFiles>256 || (stagedBytes+=expected.bytes)>64*1024*1024) throw new Error('Evidence stage exceeds aggregate bound');
    return storeEvidenceFile(source,staging,target,expected);
  }
  for (const {directory,prefix,names} of inventories) {
    for (const name of names) {
      validateEvidencePath(name);
      const info=join(directory,name), metadataPath=join(info,'METADATA');
      const bytes=await readEvidenceFile(metadataPath,8*1024*1024);
      verifyEvidence(bytes,expectedFiles.get(relativeToPack(pack,metadataPath)) || {bytes:-1,sha256:''});
      const metadata=decoder.decode(bytes), header=metadata.split(/\r?\n\r?\n/,1)[0];
      const fields=key=>[...header.matchAll(new RegExp(`^${key}: (.+)$`,'gm'))].map(match=>match[1].trim());
      const notices=[];
      for (const filename of fields('License-File')) {
        validateEvidencePath(filename);
        let source=join(info,'licenses',filename);
        // Fallback only for an absent file, never a denied/redirected file.
        try { await readEvidenceFile(source); } catch(error) { if (error.code!=='ENOENT') throw error; source=join(info,filename); }
        notices.push({...await store(source,`${prefix}/${name}/${filename}`),sourcePath:relativeToPack(pack,source)});
      }
      const sourceHeaderDigest=fields('Name')[0]==='autocommand' ? evidenceDigest(await readEvidenceFile(join(site,'setuptools/_vendor/autocommand/__init__.py'))) : null;
      let description;
      try { description=describePackageEvidence(metadata,{componentPath:relativeToPack(pack,info),noticeDigests:notices.map(notice=>notice.sha256),sourceHeaderDigest}); }
      catch(error) { throw new Error('Package evidence refused for '+name+': '+error.message); }
      components.push({...description,sourcePath:relativeToPack(pack,info),vendored:prefix!=='packages',notices,
        completeness:description.declaredLicenseFiles.length ? 'Declared notices retained; distribution conditions remain separately reviewed' : 'Supplemental version-specific notice required'});
    }
  }
  const retainedSupplementals=[];
  for (const expected of supplementals) retainedSupplementals.push({...await store(join(previousStage,expected.path),expected.path,expected),
    sourceUrl:expected.sourceUrl,role:expected.role,provenance:'offline-reuse-of-retained-primary-evidence'});
  const python=await store(join(pack,'runtime/LICENSE.txt'),'python-3.13.16-LICENSE.txt');
  const guideBytes=Buffer.from(pythonWindowsGuide,'utf8');
  if (++stagedFiles>256 || (stagedBytes+=guideBytes.length)>64*1024*1024) throw new Error('Evidence stage exceeds aggregate bound');
  const recipientGuide={...await writeEvidenceArtifact(staging,'python-windows-conditions-guide.txt',guideBytes),kind:'generated-explanatory-guide'};
  const pythonWindowsRuntime={
    route:'cpython-windows-binary-build',status:'conditional-evidence-only',pythonVersion:'3.13.16',
    referencedEvaluationPackSeal:seal,components:pythonWindowsComponents,
    originArchive:{filename:'python-3.13.16-embed-amd64.zip',sha256:'97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297',
      membershipEvidence:'docs/subject-finishing-runtime-provenance-2026-10-10.md',membershipReverifiedThisRun:false},
    notice:{...python,sourcePath:'runtime/LICENSE.txt'},recipientGuide,section:'Additional Conditions for this Windows binary build',
    sourceUrl:'https://raw.githubusercontent.com/python/cpython/v3.13.16/PC/crtlicense.txt',
    recipientTermsVerified:false,installedAvailabilityVerified:false,redistributionApproved:false,
    scope:'Association based on exact retained bytes and previously verified intentional CPython archive packaging. Publisher conditions address the Python Windows binary build, not hash-named DLLs. This is not a standalone CRT grant or approval for separately bundled NumPy/Intel components.',
  };
  const coveredSource=[];
  for (const {name,root,count,wheel} of [
    {name:'autocommand',root:'runtime/Lib/site-packages/setuptools/_vendor/autocommand',count:6,wheel:'51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670'},
    {name:'tqdm',root:'runtime/Lib/site-packages/tqdm',count:31,wheel:'c293e525e6fef9c20e8728fd4612df02a0aa31bb5fe91ecd93e123b1b7bffa73'},
  ]) {
    const selected=manifest.files.filter(record=>record.path.startsWith(root+'/')&&record.path.endsWith('.py')).sort((a,b)=>a.path.localeCompare(b.path));
    if (selected.length!==count || selected.some(record=>record.origin!=='wheel:'+wheel)) throw new Error('Covered source inventory mismatch');
    const records=[];
    for (const record of selected) {
      const source=join(pack,record.path), bytes=await readEvidenceFile(source);
      verifyEvidence(bytes,record); decoder.decode(bytes);
      records.push({...await store(source,'covered-source/'+name+'/'+record.path.slice(root.length+1),record),sourcePath:record.path,readableUtf8:true});
    }
    coveredSource.push({name,sourceRoot:root,sourceFileCount:count,originWheelSha256:wheel,files:records,
      scope:'Selected shipped Python module source matches pinned inventory; not complete upstream build source, installed availability or replacement compliance'});
  }
  const receipt={schema:3,qualificationCandidate:true,redistributionApproved:false,installerQualified:false,subjectQualityAccepted:false,
    installedSourceAvailabilityVerified:false,lgplReplacementRouteVerified:false,
    referencedEvaluationPackSeal:seal,inventoryIdentityVerified:true,entireRuntimeReverified:false,
    previousStage:relative(repo,previousStage).replaceAll('\\','/'),previousReceiptSha256,
    networkUsed:false,components,supplementals:retainedSupplementals,python,pythonWindowsRuntime,coveredSource,
    remainingGates:[
      'Exact Intel OpenMP and independently bundled CRT grants plus applicable downstream conditions',
      'Include verified SAM source subset and correct model/notice records in the actual installed payload',
      'Covered source/notice availability and rights in the installer; applicable LGPL combined-work route remains unverified',
      'Unused generated CLI launcher provenance/removal in a new production profile, never the sealed evaluation pack',
      'Verify extracted installer contents, continuous footage quality and NVIDIA throughput'],
    limitations:'Evidence-only offline staging; reviewed legacy classifications preserve original declarations. Selected source and notices are hash-verified, not the entire runtime or model. No grant, replacement, GPU quality or release approval.'};
  const report=await writeEvidenceArtifact(staging,'notice-index.json',Buffer.from(JSON.stringify(receipt,null,2)));
  const readBack=JSON.parse(decoder.decode(await readEvidenceFile(join(staging,'notice-index.json'))));
  if (readBack.redistributionApproved!==false || readBack.installerQualified!==false || readBack.networkUsed!==false || readBack.coveredSource.length!==2 ||
      JSON.stringify(readBack.pythonWindowsRuntime)!==JSON.stringify(pythonWindowsRuntime)) throw new Error('Notice receipt read-back mismatch');
  return {staging,components:components.length,notices:components.reduce((sum,component)=>sum+component.notices.length,0),
    supplementals:retainedSupplementals.length,coveredSourceFiles:coveredSource.reduce((sum,source)=>sum+source.sourceFileCount,0),
    pythonWindowsRuntimeComponents:pythonWindowsComponents.length,
    receiptSha256:report.sha256,redistributionApproved:false,networkUsed:false};
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length>3 || (process.argv[2]&&!process.argv[2].startsWith('--previous-stage='))) throw new Error('Only --previous-stage is supported');
  console.log(JSON.stringify(await prepareNoticeEvidence(process.argv[2]?.slice('--previous-stage='.length))));
}
