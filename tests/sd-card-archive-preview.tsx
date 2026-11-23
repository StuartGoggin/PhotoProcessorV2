// Actual PhotoGoGo App. All directories, cards, jobs and hardware are synthetic.
import { createRoot } from "react-dom/client";
import App from "../src/App";
import type { ImportJob, ProcessJob, Settings } from "../src/types";
import type { StudioJob } from "../src/types/videoStudio";
import type { SdCardArchiveSummary, SdCardInspection } from "../src/types/sdCardArchive";
import { defaultLightboxBindings } from "../src/controller/lightboxBindings";
import "../src/styles.css";

const source = "E:\\";
const secondSource = "F:\\";
const secondLabel = "USB READER (F:)";
const repository = "D:\\SD archives";
const archiveFolder = repository + "\\SD-C8A01234_2026-11-21";
const archiveId = "sd_archive_" + "a".repeat(32);
const secondArchiveId = "sd_archive_" + "c".repeat(32);
const totalBytes = 64 * 1024 ** 3;
const checkpoint = {
  mode: "archive" as const, label: "CANON (E:)", phase: "Copying",
  totalBytes, copiedBytes: 24 * 1024 ** 3, verifiedBytes: 18 * 1024 ** 3,
  filesCopied: 109, filesVerified: 79, sourceMbps: 91.5, sustainedMbps: 87.2,
  etaSeconds: 470, timestampWarnings: 0, needsDate: false,
};
const settings: Pick<Settings, "source_root" | "staging_dir" | "archive_dir" | "sd_card_repository" | "exiftool_dir"> = {
  source_root: source, staging_dir: "D:\\PhotoGoGo Stage", archive_dir: "D:\\Media archive",
  sd_card_repository: "", exiftool_dir: "",
};

function makeJob(id: string, summary: SdCardArchiveSummary, jobSource = summary.mode === "verify" ? archiveFolder : source): ProcessJob {
  return {
    id, task: "sdCardArchive", stagingDir: jobSource, scopeDir: jobSource, scopeMode: "folderRecursive",
    status: "running", createdAt: "2026-11-23T03:00:00Z", startedAt: "2026-11-23T03:00:01Z",
    finishedAt: null, total: 246, done: summary.filesVerified, processed: summary.filesCopied,
    resultCount: summary.filesVerified, currentFile: "DCIM/100CANON/MVI_1042.MP4",
    archiveDir: repository, currentPhase: summary.phase, statusLine: summary.phase,
    pauseRequested: false, abortRequested: false, errors: [], logs: [], canContinue: true,
    sdCardArchive: summary,
  };
}

const fixture = {
  settings,
  jobs: [] as ProcessJob[],
  imports: [] as ImportJob[],
  studio: [] as StudioJob[],
  calls: [] as { command: string; args: Record<string, unknown> }[],
  mounted: true,
  availableBytes: 42 * 1024 ** 3,
  recovery: null as SdCardInspection["recovery"],
  holdOtherJobs: false,
  otherJobsBlocked: false,
  pick: repository,
  verificationCount: 0,
  archiveId,
  complete(id: string) {
    const job = this.jobs.find(item => item.id === id);
    if (!job?.sdCardArchive) throw new Error("Missing synthetic archive");
    const completed = {
      ...job.sdCardArchive, phase: "Verified", verifiedBytes: totalBytes, filesVerified: 246,
      sourceMbps: null, etaSeconds: null, archiveFolder,
      checksumFile: archiveFolder + "\\SD-C8A01234_2026-11-21.checksums.json",
      date: { date: "2026-11-21", basis: "Date entered by you" },
    };
    if (completed.mode === "archive") {
      completed.copiedBytes = totalBytes;
      completed.filesCopied = 246;
    }
    Object.assign(job, { status: "completed", currentPhase: "Verified", done: 246, resultCount: 246, sdCardArchive: completed });
  },
};
const desktop = window as unknown as Record<string, unknown>;
desktop.__sdArchiveFixture = fixture;
let nextCallback = 0;
const callbacks = new Map<number, (value: unknown) => void>();
desktop.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
desktop.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: (callback: (value: unknown) => void) => {
    callbacks.set(++nextCallback, callback);
    return nextCallback;
  },
  unregisterCallback: (id: number) => callbacks.delete(id),
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    fixture.calls.push({ command, args: structuredClone(args) });
    if (command === "load_settings") return structuredClone(fixture.settings);
    if (command === "save_settings") {
      Object.assign(fixture.settings, args.settings);
      return;
    }
    if (command === "list_sd_archive_sources") return fixture.mounted ? [
      { path: source, label: checkpoint.label, kind: "sd", capacityBytes: 128 * 1024 ** 3 },
      { path: secondSource, label: secondLabel, kind: "usb", capacityBytes: 64 * 1024 ** 3 },
    ] : [];
    if (command === "list_import_jobs") return structuredClone(fixture.imports);
    if (command === "studio_list_jobs") return structuredClone(fixture.studio);
    if (command === "snapshot_sessions_list") return { sessions: [], warnings: [] };
    if (command === "process_jobs_snapshot") {
      if (args.jobGroup === "other") {
        if (fixture.holdOtherJobs) {
          fixture.otherJobsBlocked = true;
          await new Promise<void>(() => {});
        }
        return { jobs: [], warnings: [] };
      }
      return { jobs: structuredClone(fixture.jobs), warnings: [] };
    }
    if (command === "plugin:dialog|open") return fixture.pick;
    if (command === "plugin:event|listen") return args.handler;
    if (command === "plugin:event|unlisten") return;
    if (command === "controller_claim_client" || command === "controller_status") {
      return { enabled: false, phase: "disabled", message: "Controller is disabled", vendorStopped: false };
    }
    if (command === "controller_lightbox_bindings") return defaultLightboxBindings();
    if (command === "controller_surface" || command === "controller_ack") return;
    if (command === "scan_sd_card_archive") {
      if (!fixture.mounted || (args.source !== source && args.source !== secondSource)) throw new Error("The card is unavailable.");
      const second = args.source === secondSource;
      const configured = fixture.settings.sd_card_repository;
      const inspection: SdCardInspection = {
        token: configured ? (second ? "synthetic-second-card-preview" : "synthetic-card-preview") : null,
        source: args.source, label: second ? secondLabel : checkpoint.label, repository: configured || null,
        cardReference: "C8A01234", files: 246, directories: 14, totalBytes,
        availableBytes: configured ? fixture.availableBytes : null,
        repositoryIssue: configured ? null : "Choose an SD Card Repository before starting the archive.",
        proposedDate: { date: "2026-11-22", basis: "File modification time", file: "DCIM/100CANON/IMG_0991.JPG" },
        recovery: second ? null : fixture.recovery,
      };
      return inspection;
    }
    if (command === "start_sd_card_archive") {
      const second = args.token === "synthetic-second-card-preview";
      if ((!second && args.token !== "synthetic-card-preview") || !fixture.settings.sd_card_repository) throw new Error("Card inspection is stale.");
      if (!second && fixture.recovery && !args.newSnapshot) {
        const saved = fixture.jobs.find(job => job.id === fixture.recovery?.jobId);
        if (!saved) throw new Error("Saved job is missing.");
        if (fixture.recovery.completed) {
          const verification = makeJob("sd_archive_" + String(++fixture.verificationCount).padStart(32, "b"), {
            ...checkpoint, mode: "verify", phase: "Checking card checksums", filesVerified: 0, verifiedBytes: 0,
          }, source);
          fixture.jobs.unshift(verification);
          return structuredClone(verification);
        }
        saved.status = "running";
        saved.currentPhase = "Copying";
        saved.sdCardArchive = { ...checkpoint, filesReused: 79 };
        return structuredClone(saved);
      }
      if (fixture.availableBytes <= totalBytes) throw new Error("The repository is full.");
      const job = makeJob(second ? secondArchiveId : archiveId, {
        ...checkpoint, label: second ? secondLabel : checkpoint.label,
      }, second ? secondSource : source);
      fixture.jobs.unshift(job);
      return structuredClone(job);
    }
    if (command === "verify_sd_card_archive") {
      const known = fixture.jobs.some(job => job.id === args.archiveJobId && job.sdCardArchive?.archiveFolder === archiveFolder);
      if (!known && args.folder !== archiveFolder) throw new Error("Archive folder missing.");
      const job = makeJob("sd_archive_" + String(++fixture.verificationCount).padStart(32, "b"), {
        ...checkpoint, mode: "verify", label: "Saved archive", phase: "Verifying", copiedBytes: 0,
        verifiedBytes: 0, filesCopied: 0, filesVerified: 0, sourceMbps: null, sustainedMbps: null, etaSeconds: null,
      });
      fixture.jobs.unshift(job);
      return structuredClone(job);
    }
    if (command === "open_in_default_app") return;
    if (["pause_process_job", "resume_process_job", "abort_process_job", "retry_process_job", "set_sd_card_archive_date"].includes(command)) {
      const job = fixture.jobs.find(item => item.id === args.jobId);
      if (!job?.sdCardArchive) throw new Error("Saved archive job missing.");
      if (command === "set_sd_card_archive_date") {
        job.sdCardArchive.needsDate = false;
        job.canContinue = true;
        return;
      }
      if (command === "retry_process_job" && job.sdCardArchive.needsDate) throw new Error("Enter an archive date first.");
      job.status = command === "pause_process_job" ? "paused" : command === "abort_process_job" ? "aborted" : "running";
      job.currentPhase = job.status === "paused" ? "Paused at a safe checkpoint" : job.status === "aborted" ? "Cancelled. Draft retained" : "Copying";
      job.sdCardArchive.phase = job.currentPhase;
      job.errors = [];
      return true;
    }
    throw new Error("Unexpected archive fixture command: " + command);
  },
};

createRoot(document.getElementById("root")!).render(<App />);
