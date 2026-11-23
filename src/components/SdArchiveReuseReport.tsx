import type { ProcessJob } from "../types";
import type { ArchiveReuseSide } from "../types/sdCardArchive";
import { formatJobBytes } from "../utils/jobProgress";

export function reuseProofMatched(job: ProcessJob | undefined): boolean {
  const detail = job?.sdCardArchive;
  const proof = detail?.reuseProof;
  const card = proof?.card;
  const archive = proof?.archive;
  return !!(job?.status === "completed" && detail?.strictMetadata && proof?.checkedAt
    && proof.archiveFolder && proof.checksumFile && proof.manifestSha256 && card && archive
    && card.files > 0 && card.files === archive.files && card.bytes === archive.bytes
    && card.folders === archive.folders && [card, archive].every(side =>
      side.files === side.checkedFiles && side.bytes === side.checkedBytes));
}

export function ReuseSide({ title, label, side, live }: {
  title: string; label: string; side: ArchiveReuseSide | null | undefined; live?: boolean;
}) {
  return <section className="sd-reuse-side" aria-label={title}>
    <h4>{title}</h4>
    <p className="sd-reuse-side-label" title={label}>{label}</p>
    {side ? <>
      <dl className="sd-reuse-counts">
        <div><dt>Files</dt><dd>{side.files.toLocaleString()}</dd></div>
        <div><dt>Folders</dt><dd>{side.folders.toLocaleString()}</dd></div>
        <div><dt>Data</dt><dd title={side.bytes.toLocaleString() + " bytes"}>{formatJobBytes(side.bytes)}</dd></div>
      </dl>
      {live && <progress max={Math.max(side.files, 1)} value={side.checkedFiles} aria-label={title + " checksums"} />}
      <p className="sd-reuse-check-count">{side.checkedFiles.toLocaleString()} of {side.files.toLocaleString()} SHA-256 checks matched</p>
      <p className="sd-reuse-side-label" title={side.checkedBytes.toLocaleString() + " bytes"}>
        {side.checkedBytes.toLocaleString()} / {side.bytes.toLocaleString()} bytes verified
      </p>
    </> : <p className="sd-reuse-side-label">{live ? "Waiting for the file list…" : "File count unavailable"}</p>}
  </section>;
}

export default function SdArchiveReuseReport({ job }: { job: ProcessJob }) {
  const proof = job.sdCardArchive?.reuseProof;
  if (!proof) return null;
  const matched = reuseProofMatched(job);
  return <section className="sd-reuse-report" aria-label="Verification proof">
    <h3>Verification proof</h3>
    <p className={matched ? "sd-reuse-ok" : "sd-reuse-warning"}>{matched
      ? "The inserted card and repository copy matched during this check."
      : "This check did not establish a full match."}</p>
    <div className="sd-reuse-sides">
      <ReuseSide title="Source card" label={job.stagingDir} side={proof.card} />
      <ReuseSide title="Repository copy" label={proof.archiveFolder ?? job.archiveDir ?? ""} side={proof.archive} />
    </div>
    <dl className="sd-reuse-proof-details">
      <div><dt>Card ID</dt><dd>{proof.cardId}</dd></div>
      <div><dt>Archives with this ID</dt><dd>{proof.candidates.toLocaleString()} of {proof.archivesSearched.toLocaleString()} checked</dd></div>
      {proof.checkedAt && <div><dt>Matched at</dt><dd>{new Date(proof.checkedAt).toLocaleString()}</dd></div>}
      {matched && <div><dt>Metadata</dt><dd>Paths, creation and modification times, and supported Windows attributes matched.</dd></div>}
      {proof.checksumFile && <div><dt>Checksum file</dt><dd>{proof.checksumFile}</dd></div>}
      {proof.manifestSha256 && <div><dt>Checksum file SHA-256</dt><dd className="sd-reuse-hash">{proof.manifestSha256}</dd></div>}
    </dl>
    {proof.unreadable > 0 && <p className="sd-reuse-warning">{proof.unreadable.toLocaleString()} archive records could not be read.</p>}
    {job.errors.length > 0 && <ul className="sd-reuse-warning" aria-label="Differences">
      {job.errors.map((entry, index) => <li key={index}>{typeof entry === "string" ? entry : JSON.stringify(entry)}</li>)}
    </ul>}
    <p className="sd-reuse-record">Saved in Jobs · {job.id}</p>
  </section>;
}
