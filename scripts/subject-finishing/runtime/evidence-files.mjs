// Local evidence I/O only. No network, model execution or permission decisions.
import {lstat, open, mkdir, readdir} from 'node:fs/promises';
import {resolve, dirname, parse, join} from 'node:path';
import {createHash} from 'node:crypto';
export const evidenceDigest = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateEvidencePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\\:\x00-\x1f<>"?*|]/.test(value)) throw new Error('Unsafe evidence path');
  for (const part of value.split('/')) if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(part)) throw new Error('Unsafe evidence path');
  return value;
}
export async function assertEvidenceAncestry(path) {
  let cursor = resolve(path);
  while (true) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Redirected evidence ancestry');
    if (cursor === parse(cursor).root) return;
    cursor = dirname(cursor);
  }
}
export async function requirePackageMetadataDirectories(directory, expectedNames) {
  await assertEvidenceAncestry(directory);
  const entries=(await readdir(directory,{withFileTypes:true})).filter(entry=>entry.name.endsWith('.dist-info'));
  if (entries.length>64 || entries.some(entry=>!entry.isDirectory()||entry.isSymbolicLink())) throw new Error('Unexpected package metadata directory');
  const names=entries.map(entry=>validateEvidencePath(entry.name)).sort();
  if (JSON.stringify(names)!==JSON.stringify([...expectedNames].sort())) throw new Error('Package metadata inventory mismatch');
  return names;
}
export async function readEvidenceFile(path, maximum = 16 * 1024 * 1024) {
  await assertEvidenceAncestry(path);
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Evidence file exceeds regular-file bound');
    const chunks = [], buffer = Buffer.alloc(65536);
    let count = 0;
    while (true) {
      const {bytesRead} = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > maximum || count > stat.size) throw new Error('Evidence actual bytes exceed read bound');
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (count !== stat.size) throw new Error('Evidence actual length mismatch');
    return Buffer.concat(chunks, count);
  } finally { await file.close(); }
}
export function verifyEvidence(bytes, expected) {
  if (expected && (bytes.length !== expected.bytes || evidenceDigest(bytes) !== expected.sha256)) throw new Error('Evidence identity mismatch');
}
export async function writeEvidenceArtifact(stage, path, bytes) {
  validateEvidencePath(path);
  if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024) throw new Error('Evidence write exceeds bound');
  await assertEvidenceAncestry(stage);
  const target = join(stage, path);
  let parent=resolve(stage);
  // Inspect each existing segment before creating beneath it. Recursive mkdir
  // would follow a descendant junction before a later ancestry check could fail.
  for (const part of path.split('/').slice(0,-1)) {
    parent=join(parent,part);
    let info;
    try { info=await lstat(parent); }
    catch(error) { if (error.code!=='ENOENT') throw error; await mkdir(parent); info=await lstat(parent); }
    if (info.isSymbolicLink()||!info.isDirectory()) throw new Error('Redirected or non-directory evidence target ancestry');
  }
  const file = await open(target, 'wx');
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const result = {path, bytes: bytes.length, sha256: evidenceDigest(bytes)};
  verifyEvidence(await readEvidenceFile(target), result);
  return result;
}
export async function storeEvidenceFile(source, stage, path, expected = null) {
  const bytes = await readEvidenceFile(source);
  verifyEvidence(bytes, expected);
  return writeEvidenceArtifact(stage, path, bytes);
}
