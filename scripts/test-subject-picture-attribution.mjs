// A returned report must bind to the externally retained build and fixed input pins.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {readPictureReport} from './subject-finishing/read-picture-report.mjs';
const binary=resolve(process.argv[2]??'test-output/subject-picture-handoff-v2/bin/PhotoGoGo-Cached-Picture-Test.exe');
const reportPath=resolve(process.argv[3]??'test-output/subject-picture-public-h3hXwn/private-user-and-media-path/picture-report.json');
assert.ok(process.argv.length<=4);
const build=JSON.parse(await readFile(join(dirname(dirname(binary)),'build-receipt.json')));
const report=await readPictureReport(dirname(reportPath),build);
const binarySha=createHash('sha256').update(await readFile(binary)).digest('hex');
assert.equal(build.kind,'native-cached-picture-handoff-build');assert.equal(build.executable.sha256,binarySha);
assert.equal(report.runnerSha256,binarySha);
assert.equal(report.buildProfile,'cached-picture-fixed35-sdr709-rgbq4-v1');
for(const [key,name] of [['baseSha256','base.mp4'],['maskSha256','masks.pgmask'],['maskManifestSha256','manifest.json']])
 assert.equal(report[key],build.payload.find(pin=>pin.path===`samples/${report.sample}/${name}`).sha256);
assert.equal(report.mediaManifestSha256,build.payload.find(pin=>pin.path==='media/build-manifest.json').sha256);
assert.equal(report.ownedPeakScope,'render-job-committed-bytes');
assert.equal(report.productionExportQualified,false);
console.log(JSON.stringify({event:'passed',seam:'returned-report-build-and-input-attribution',reportPath,productionExportQualified:false}));
