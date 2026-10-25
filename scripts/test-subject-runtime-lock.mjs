import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
test('the manual profile is a fully hash-locked local-wheel closure, not an index or URL requirement',()=>{
  const lock=readFileSync('scripts/subject-finishing/runtime/requirements-manual-cpu.lock','utf8')
    .split(/\r?\n/).filter(line=>line&&!line.startsWith('#'));
  const manifest=JSON.parse(readFileSync('scripts/subject-finishing/runtime/wheels-manual-cpu.json','utf8'));
  assert.equal(lock.length,21);assert.equal(manifest.wheels.length,21);
  assert.equal(new Set(manifest.wheels.map(w=>w.name.toLowerCase())).size,21);
  for(const wheel of manifest.wheels){
    assert.match(wheel.file,/^[A-Za-z0-9_.+-]+\.whl$/);assert.match(wheel.sha256,/^[a-f0-9]{64}$/);
    assert.ok(lock.includes(`${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`));
    if(wheel.url){const url=new URL(wheel.url);assert.equal(url.protocol,'https:');assert.ok(['files.pythonhosted.org','download.pytorch.org'].includes(url.hostname));}
    else assert.match(wheel.localArtifact,/^subject-finishing-evaluation-cpu\/wheelhouse\/[A-Za-z0-9_.+-]+\.whl$/);
  }
  for(const line of lock)assert.match(line,/^[A-Za-z0-9_.-]+==[A-Za-z0-9.+-]+ --hash=sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.qualificationCandidate,true,'An artifact lock is not a licence, security or footage acceptance receipt');
});
