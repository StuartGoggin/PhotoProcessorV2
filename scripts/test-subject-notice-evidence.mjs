import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {describePackageEvidence} from './subject-finishing/runtime/notice-evidence.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const base = '.build-cache/subject-finishing-manual-cpu-v1/runtime/Lib/site-packages/';
const metadata = await readFile(base + 'setuptools/_vendor/autocommand-2.2.2.dist-info/METADATA', 'utf8');
const evidence = {
  componentPath: 'runtime/Lib/site-packages/setuptools/_vendor/autocommand-2.2.2.dist-info',
  noticeDigests: [digest(await readFile(base + 'setuptools/_vendor/autocommand-2.2.2.dist-info/LICENSE'))],
  sourceHeaderDigest: digest(await readFile(base + 'setuptools/_vendor/autocommand/__init__.py')),
};
test('exact retained LGPL evidence preserves declaration and later-version classification', () => {
  const actual = describePackageEvidence(metadata, evidence);
  assert.equal(actual.declaredLicense, 'LGPLv3'); assert.equal(actual.declaredLicenseExpression, null);
  assert.equal(actual.licenseExpression, null); assert.equal(actual.reviewedLegacyClassification.spdxExpression, 'LGPL-3.0-or-later');
  assert.equal(actual.redistributionApproved, undefined);
});
test('exact retained mixed notice stays AND, not MIT-only or OR', async () => {
  const text = await readFile(base + 'tqdm-4.70.1.dist-info/METADATA', 'utf8');
  const actual = describePackageEvidence(text, {componentPath: 'runtime/Lib/site-packages/tqdm-4.70.1.dist-info', noticeDigests: [digest(await readFile(base + 'tqdm-4.70.1.dist-info/licenses/LICENCE'))]});
  assert.equal(actual.licenseExpression, null); assert.equal(actual.reviewedLegacyClassification.spdxExpression, 'MPL-2.0 AND MIT');
});
for (const [name, text, changed] of [
  ['changed metadata bytes', metadata + '\nchanged', evidence],
  ['changed version', metadata.replace('Version: 2.2.2', 'Version: 2.2.3'), evidence],
  ['missing notice', metadata, {...evidence, noticeDigests: []}],
  ['changed notice', metadata, {...evidence, noticeDigests: ['0'.repeat(64)]}],
  ['missing later-version header', metadata, {...evidence, sourceHeaderDigest: null}],
  ['changed source header', metadata, {...evidence, sourceHeaderDigest: '0'.repeat(64)}],
  ['changed component path', metadata, {...evidence, componentPath: 'unreviewed/autocommand'}],
  ['new modern expression on reviewed package', metadata.replace('License: LGPLv3', 'License: LGPLv3\nLicense-Expression: MIT'), evidence],
]) test(name + ' refuses reviewed classification', () => assert.throws(() => describePackageEvidence(text, changed), /evidence mismatch/));
test('unknown legacy declaration remains unclassified', () => {
  const actual = describePackageEvidence('Name: fixture\nVersion: 1\nLicense: MIT\n\ndescription');
  assert.equal(actual.declaredLicense, 'MIT'); assert.equal(actual.licenseExpression, null);
});
test('description body cannot inject header authority', () => {
  const actual = describePackageEvidence('Name: fixture\nVersion: 1\n\nLicense-Expression: MIT\nLicense-File: ../escape');
  assert.equal(actual.licenseExpression, null); assert.deepEqual(actual.declaredLicenseFiles, []);
});
test('declared modern expression is retained without approval', () => {
  const actual = describePackageEvidence('Name: fixture\nVersion: 1\nLicense-Expression: BSD-3-Clause\n\ntext');
  assert.equal(actual.licenseExpression, 'BSD-3-Clause'); assert.equal(actual.reviewedLegacyClassification, null);
});
test('folded legacy licence is preserved, not guessed', () => {
  const actual = describePackageEvidence('Name: fixture\r\nVersion: 1\r\nLicense: terms\r\n continued\r\n\r\ntext');
  assert.equal(actual.declaredLicense, 'terms\ncontinued'); assert.equal(actual.licenseExpression, null);
});
test('header-only metadata with one terminal newline is accepted', () => {
  const actual = describePackageEvidence('Name: fixture\nVersion: 1\nLicense: BSD\n');
  assert.equal(actual.declaredLicense, 'BSD'); assert.equal(actual.licenseExpression, null);
});
for (const [name, text] of [
  ['duplicate name', 'Name: fixture\nName: other\nVersion: 1'],
  ['duplicate expression', 'Name: fixture\nVersion: 1\nLicense-Expression: MIT\nLicense-Expression: MPL-2.0'],
  ['missing version', 'Name: fixture'],
  ['malformed continuation', ' continued\nName: fixture\nVersion: 1'],
  ['oversized metadata', 'X'.repeat(8 * 1024 * 1024 + 1)],
]) test(name + ' refuses metadata', () => assert.throws(() => describePackageEvidence(text), /metadata|Metadata/));
