// Evidence classification only; never grants permission to execute or distribute.
import {createHash} from 'node:crypto';

const digest = text => createHash('sha256').update(text).digest('hex');
const reviewed = {
  autocommand: {
    path: 'runtime/Lib/site-packages/setuptools/_vendor/autocommand-2.2.2.dist-info',
    version: '2.2.2', declaration: 'LGPLv3', expression: 'LGPL-3.0-or-later',
    metadata: '3800d9b91dceea2065a6ed6279383362e97ac38b8e56b9343f404ee531860099',
    notice: 'ade78d04982d69972d444a8e14a94f87a2334dd3855cc80348ea8e240aa0df2d',
    header: 'ce4a39467be896f6fe5178c2c7fd80acf4c6056c142b9418e0b21020a611ec0b',
    basis: 'Exact retained metadata, LGPL notice and source header with version-3-or-later option',
  },
  tqdm: {
    path: 'runtime/Lib/site-packages/tqdm-4.70.1.dist-info',
    version: '4.70.1', declaration: 'MPL-2.0 AND MIT', expression: 'MPL-2.0 AND MIT',
    metadata: 'a5da70b966afea3a759716041bad7187f2ece02c22348cf9e7c0a512bbf15f57',
    notice: 'fcff87c3a47ce8028a8512aa182d4fcf0ad1c90544ee75cf9b343684cac194de',
    basis: 'Exact retained legacy declaration and combined publisher notice; not an OR choice',
  },
};

export function describePackageEvidence(metadata, {componentPath = null, noticeDigests = [], sourceHeaderDigest = null} = {}) {
  if (typeof metadata !== 'string' || Buffer.byteLength(metadata) > 8 * 1024 * 1024) throw new Error('Metadata exceeds evidence bound');
  const header = metadata.split(/\r?\n\r?\n/, 1)[0];
  const fields = new Map();
  let last = null;
  for (const line of header.split(/\r?\n/)) {
    if (line === '') break;
    if (/^[ \t]/.test(line)) {
      if (!last) throw new Error('Malformed metadata continuation');
      const values = fields.get(last); values[values.length - 1] += '\n' + line.trim(); continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
    if (!match) throw new Error('Malformed metadata header');
    last = match[1].toLowerCase();
    if (!fields.has(last)) fields.set(last, []);
    fields.get(last).push(match[2].trim());
  }
  const all = key => fields.get(key) || [];
  const single = (key, required = false) => {
    const values = all(key);
    if (values.length > 1 || (required && (!values.length || !values[0]))) throw new Error('Ambiguous package metadata');
    return values[0] || null;
  };
  const name = single('name', true), version = single('version', true);
  const declaredLicenseExpression = single('license-expression'), declaredLicense = single('license');
  const metadataSha256 = digest(metadata);
  const result = {name, version, metadataSha256, declaredLicenseExpression, declaredLicense,
    declaredLicenseFiles: all('license-file'), sourceLinks: all('project-url'),
    licenseClassifiers: all('classifier').filter(value => value.startsWith('License ::')),
    licenseExpression: declaredLicenseExpression, reviewedLegacyClassification: null};
  const known = Object.hasOwn(reviewed, name) ? reviewed[name] : null;
  if (known) {
    if (componentPath !== known.path || version !== known.version || declaredLicense !== known.declaration || declaredLicenseExpression !== null ||
        metadataSha256 !== known.metadata || !noticeDigests.includes(known.notice) ||
        (known.header && sourceHeaderDigest !== known.header)) throw new Error('Reviewed legacy licence evidence mismatch: ' + name);
    result.reviewedLegacyClassification = {spdxExpression: known.expression, basis: known.basis, reviewStatus: 'evidence_only',
      metadataSha256: known.metadata, noticeSha256: known.notice,
      sourceHeaderSha256: known.header || null, checkpoint: 'docs/subject-finishing-model-source-checkpoint-2026-10-10.md'};
  }
  return result;
}
