import type { ImportJob, ProcessJob, ProcessTask } from "../types/api";
import type { StudioJob } from "../types/videoStudio";
import { formatImportRate, importPhaseLabel, importSourceLabel, importWaitReason, isReadingImportSource } from "./importScheduling";
import { getProcessAttemptLabel, getProcessResultLabel } from "./processJobs";

type Icon = "sd" | "drive" | "photo" | "video" | "cloud" | "check" | "folder" | "scan" | "trash";
interface Endpoint { icon: Icon; label: string }
interface Meter { label: string; name?: string; value?: number; total?: number; detail?: string }
type Fact = [label: string, value: string | number | null | undefined];

export interface JobProgressDisplay {
  title: string;
  subject?: string;
  status: string;
  phase?: string;
  currentItem?: string;
  source: Endpoint;
  target: Endpoint;
  moving: boolean;
  verified?: boolean;
  meters: Meter[];
  facts: Fact[];
  note?: string | null;
}

const tasks: Record<ProcessTask, [title: string, source: Endpoint, target: Endpoint]> = {
  focus: ["Focus Detection", { icon: "photo", label: "Photos" }, { icon: "scan", label: "Focus flags" }],
  remove_focus: ["Remove Focus Flags", { icon: "scan", label: "Focus flags" }, { icon: "photo", label: "Restored photos" }],
  enhance: ["JPG Enhancement", { icon: "photo", label: "Originals" }, { icon: "photo", label: "Enhanced photos" }],
  remove_enhance: ["Remove Enhancement Outputs", { icon: "photo", label: "Enhanced photos" }, { icon: "trash", label: "Removal" }],
  bw: ["B&W Conversion", { icon: "photo", label: "Originals" }, { icon: "photo", label: "B&W photos" }],
  remove_bw: ["Remove B&W Outputs", { icon: "photo", label: "B&W photos" }, { icon: "trash", label: "Removal" }],
  stabilize: ["MP4 Stabilisation", { icon: "video", label: "Source clips" }, { icon: "video", label: "Stabilised clips" }],
  remove_stabilize: ["Remove Stabilised MP4s", { icon: "video", label: "Stabilised clips" }, { icon: "trash", label: "Removal" }],
  scan_archive_naming: ["Archive Naming Scan", { icon: "drive", label: "Archive" }, { icon: "scan", label: "Folder matches" }],
  apply_event_naming: ["Apply Event Naming", { icon: "folder", label: "Folders" }, { icon: "folder", label: "Named events" }],
  transfer: ["Transfer to NAS", { icon: "folder", label: "Staging" }, { icon: "drive", label: "NAS archive" }],
  verify_checksums: ["Verify Checksums", { icon: "drive", label: "Archive" }, { icon: "check", label: "Checksum results" }],
  scan_faces: ["Face Library Scan", { icon: "video", label: "Videos" }, { icon: "scan", label: "Face library" }],
  search_person_videos: ["Search Person Videos", { icon: "scan", label: "Face library" }, { icon: "video", label: "Video matches" }],
  googlePhotos: ["Google Photos", { icon: "photo", label: "Selected photos" }, { icon: "cloud", label: "Album" }],
  rawDevelop: ["RAW Development", { icon: "photo", label: "RAW captures" }, { icon: "photo", label: "Developed photos" }],
  takeOutTrash: ["Take out the trash", { icon: "folder", label: "Reviewed files" }, { icon: "trash", label: "Removal" }],
  sdCardArchive: ["SD Card Archive", { icon: "sd", label: "SD card" }, { icon: "drive", label: "Repository" }],
};

export function isMeasured(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function formatJobBytes(value: number) {
  const index = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return (value / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: index ? 1 : 0 }) + " " + ["B", "KiB", "MiB", "GiB"][index];
}

function byteMeter(label: string, value: number, total: number, name?: string, files?: number): Meter {
  const amount = isMeasured(value) ? formatJobBytes(value) : "—";
  const limit = isMeasured(total) && total > 0 ? " / " + formatJobBytes(total) : "";
  const count = isMeasured(files) ? " · " + files.toLocaleString() + " files" : "";
  return { label, name, value, total, detail: amount + limit + count };
}

function seconds(value: unknown) {
  if (!isMeasured(value) || value === 0) return null;
  const n = Math.ceil(value);
  if (n >= 3600) return Math.floor(n / 3600) + " h " + Math.floor(n % 3600 / 60) + " min";
  if (n >= 60) return Math.floor(n / 60) + " min " + (n % 60) + " s";
  return n + " s";
}

export function jobStatusLabel(status: string) {
  if (status === "completed_with_warnings") return "Completed with verification warnings";
  if (status === "needs_attention") return "Needs attention";
  return status.replace(/(^.|_.)/g, (part) => part.replace("_", " ").toUpperCase());
}

function isMoving(status: string, phase = "", stopping = false) {
  return ["running", "preparing", "uploading", "committing"].includes(status)
    && !stopping && !/^(?:waiting|queued|paus|interrupted)/i.test(phase.trim());
}

export function importJobProgress(job: ImportJob): JobProgressDisplay {
  const phase = importPhaseLabel(job);
  const waiting = importWaitReason(job);
  return {
    title: "Import",
    subject: importSourceLabel(job),
    status: job.status,
    phase,
    currentItem: job.currentFile,
    source: { icon: "sd", label: "Source media" },
    target: { icon: "folder", label: "Staging" },
    moving: isMoving(job.status, phase, job.pauseRequested || job.abortRequested || !!waiting),
    meters: [{ label: "Files attempted", name: "Import progress", value: job.done, total: job.total }],
    facts: [
      ["Imported", job.imported], ["Skipped", job.skipped],
      ["Source read rate", isReadingImportSource(job) && isMeasured(job.sourceReadMbps) ? formatImportRate(job.sourceReadMbps) : null],
      ["Throughput", job.status === "running" && !waiting && isMeasured(job.speedMbps) ? formatImportRate(job.speedMbps) : null],
      ["Bytes read", isMeasured(job.bytesRead) ? formatJobBytes(job.bytesRead) : null],
      ["Bytes copied", isMeasured(job.bytesCopied) ? formatJobBytes(job.bytesCopied) : null],
    ],
    note: waiting,
  };
}

export function processJobProgress(job: ProcessJob): JobProgressDisplay {
  const [title, source, target] = tasks[job.task] ?? [job.task, { icon: "folder", label: "Source" }, { icon: "check", label: "Results" }];
  const phase = job.currentPhase || job.statusLine;
  const base: JobProgressDisplay = {
    title, source, target, phase, status: job.status, currentItem: job.currentFile,
    moving: isMoving(job.status, phase, job.pauseRequested || job.abortRequested),
    meters: [{ label: "Items attempted", name: title + " progress", value: job.done, total: job.total }],
    facts: [[getProcessAttemptLabel(job.task), job.processed], [getProcessResultLabel(job.task), job.resultCount]],
  };

  if (job.sdCardArchive) {
    const archive = job.sdCardArchive;
    const verifying = archive.mode !== "archive";
    const removing = archive.mode === "remove";
    const verified = job.status === "completed" && !!archive.archiveFolder;
    const archivePhase = job.currentPhase || archive.phase;
    return {
      ...base, subject: archive.label, phase: archivePhase, verified,
      source: verifying && archivePhase !== "Checking card checksums" ? { icon: "drive", label: removing ? "Replacement" : "Saved archive" } : source,
      target: verified || verifying ? { icon: "check", label: verified ? "Verified" : removing && job.status === "completed" ? "Removed" : "Checksum check" } : target,
      moving: isMoving(job.status, archivePhase) && ["Copying", "Verifying", "Checking card checksums", "Restoring timestamps", "Removing old archive"].includes(archivePhase),
      meters: [
        ...(!verifying ? [byteMeter("Read from card", archive.copiedBytes, archive.totalBytes, "Card bytes read", archive.filesCopied)] : []),
        byteMeter("Verified", archive.verifiedBytes, archive.totalBytes, "Verified bytes", archive.filesVerified),
      ],
      facts: [
        ["Card read", job.status === "running" && isMeasured(archive.sourceMbps) ? archive.sourceMbps.toFixed(1) + " MiB/s" : null],
        ["Sustained", !verifying && isMeasured(archive.sustainedMbps) ? archive.sustainedMbps.toFixed(1) + " MiB/s" : null],
        ["Read remaining", job.status === "running" ? seconds(archive.etaSeconds) : null],
        ["Reused", (archive.filesReused || archive.filesRepaired) ? (archive.filesReused ?? 0) : null],
        ["Repaired", (archive.filesReused || archive.filesRepaired) ? (archive.filesRepaired ?? 0) : null],
      ],
      note: archive.bottleneck,
    };
  }

  if (job.task === "googlePhotos") {
    const photo = job.googlePhotos;
    return {
      ...base,
      subject: photo?.albums?.map(album => album.title).filter(Boolean).join(" · "),
      meters: photo && (isMeasured(photo.totalBytes) || isMeasured(photo.bytesDone))
        ? [byteMeter("Bytes transferred", photo.bytesDone, photo.totalBytes, "Google Photos bytes transferred")] : base.meters,
      facts: [
        ["Accepted", photo ? (photo.accepted ?? photo.uploaded) : null], ["Verified", photo?.uploaded],
        ["Needs attention", photo?.verificationNeedsAttention || null], ["Read-back unavailable", photo?.readbackUnavailable || null],
      ],
    };
  }

  if (job.task === "transfer") return {
    ...base, subject: job.archiveDir,
    meters: [{ label: "Files assessed", name: title + " progress", value: job.done, total: job.total }],
    facts: [["Copied", job.transferUploadedCount ?? job.processed], ["Already present", job.transferDeduplicatedCount]],
    note: job.statusLine !== phase ? job.statusLine : undefined,
  };

  if (job.task === "scan_faces") return {
    ...base,
    meters: [{
      label: "Frames sampled", name: title + " progress", value: job.faceFramesScanned, total: job.faceFramesTotalEstimate,
      detail: isMeasured(job.faceFramesScanned)
        ? (isMeasured(job.faceFramesTotalEstimate) && job.faceFramesTotalEstimate > 0
          ? job.faceFramesScanned.toLocaleString() + " of ~" + job.faceFramesTotalEstimate.toLocaleString() : job.faceFramesScanned.toLocaleString()) : undefined,
    }],
    facts: [["Videos scanned", job.videosScanned], ["Faces found", job.facesDetected], ["People grouped", job.uniquePeople]],
  };

  if (job.task === "search_person_videos") return { ...base, subject: job.personName, facts: [["Videos checked", job.processed], ["Matches", job.resultCount]] };
  if (job.task === "stabilize") return {
    ...base, meters: [{ label: "Clips attempted", name: title + " progress", value: job.done, total: job.total }],
    facts: [["Stabilised", job.resultCount], ["Workers", job.stabilizeMaxParallelJobsUsed], ["Threads per clip", job.stabilizeFfmpegThreadsPerJobUsed]],
    note: job.statusLine !== phase ? job.statusLine : undefined,
  };
  if (job.task === "rawDevelop") return { ...base, facts: [["Developed", job.resultCount], ["Processed", job.processed]] };
  if (job.task === "takeOutTrash") return { ...base, facts: [["Removed", job.resultCount], ["Processed", job.processed]] };
  if (job.task === "verify_checksums") return { ...base, subject: job.archiveDir, note: job.statusLine !== phase ? job.statusLine : undefined };
  return base;
}

const studioKinds: Record<NonNullable<StudioJob["kind"]>, string> = {
  preview: "Preview", clip: "Clip render", project: "Project render", assembly: "Assembly", music: "Music render",
};

export function studioJobProgress(job: StudioJob): JobProgressDisplay {
  const moving = isMoving(job.status, job.phase, job.paused || job.cancelled);
  const tasks = moving ? job.activeTasks ?? [] : [];
  const fps = tasks.length === 1 ? tasks[0].fps : null;
  return {
    title: "Video Studio",
    subject: job.name,
    status: job.status,
    phase: job.paused && job.status !== "paused" ? "Pause requested · " + job.phase : job.phase,
    currentItem: tasks.length === 1 && tasks[0].phase !== job.phase ? tasks[0].phase : undefined,
    source: { icon: job.kind === "music" ? "folder" : "video", label: studioKinds[job.kind ?? "project"] },
    target: { icon: "check", label: job.kind === "music" ? "Soundtrack" : "Rendered output" },
    moving,
    meters: [{ label: "Render progress", name: job.name + " progress", value: job.progress, total: 100, detail: isMeasured(job.progress) ? Math.round(Math.min(job.progress, 100)) + "%" : undefined }],
    facts: [
      ["Encoder", job.encoder], ["Render speed", isMeasured(fps) ? fps.toFixed(1) + " fps" : null],
      ["Active tasks", tasks.length > 1 ? tasks.length : null], ["Remaining", moving ? seconds(job.etaSeconds) : null],
      ["Queue position", job.status === "queued" ? job.queuePosition : null],
      ["Clips saved", job.artifacts?.length],
    ],
  };
}
