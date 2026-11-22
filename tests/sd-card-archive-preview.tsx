// Actual PhotoGoGo App. All directories, cards, jobs and hardware are synthetic.
import { createRoot } from "react-dom/client";
import App from "../src/App";
import type { ProcessJob, Settings } from "../src/types";
import type { SdCardArchiveSummary, SdCardInspection } from "../src/types/sdCardArchive";
import { defaultLightboxBindings } from "../src/controller/lightboxBindings";
import "../src/styles.css";

const source = "E:\\";
const repository = "D:\\SD archives";
const archiveFolder = repository + "\\2026-11-21_SD-C8A0-12345678-00";
const archiveId = "sd_archive_" + "a".repeat(32);
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

function makeJob(id: string, summary: SdCardArchiveSummary): ProcessJob {
  const jobSource = summary.mode === "verify" ? archiveFolder : source;
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
  calls: [] as { command: string; args: Record<string, unknown> }[],
  mounted: true,
  availableBytes: 42 * 1024 ** 3,
  pick: repository,
  verificationCount: 0,
  archiveId,
  complete(id: string) {
    const job = this.jobs.find(item => item.id === id);
    if (!job?.sdCardArchive) throw new Error("Missing synthetic archive");
    const completed = {
      ...job.sdCardArchive, phase: "Verified", verifiedBytes: totalBytes, filesVerified: 246,
      sourceMbps: null, etaSeconds: null, archiveFolder,
      checksumFile: archiveFolder + "\\2026-11-21_SD-C8A0-12345678-00.checksums.json",
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
    if (command === "list_sd_cards") return fixture.mounted ? [{ path: source, label: checkpoint.label }] : [];
    if (command === "list_import_jobs" || command === "studio_list_jobs") return [];
    if (command === "snapshot_sessions_list") return { sessions: [], warnings: [] };
    if (command === "process_jobs_snapshot") return { jobs: structuredClone(fixture.jobs), warnings: [] };
    if (command === "plugin:dialog|open") return fixture.pick;
    if (command === "plugin:event|listen") return args.handler;
    if (command === "plugin:event|unlisten") return;
    if (command === "controller_claim_client" || command === "controller_status") {
      return { enabled: false, phase: "disabled", message: "Controller is disabled", vendorStopped: false };
    }
    if (command === "controller_lightbox_bindings") return defaultLightboxBindings();
    if (command === "controller_surface" || command === "controller_ack") return;
    if (command === "scan_sd_card_archive") {
      if (!fixture.mounted || args.source !== source) throw new Error("The card is unavailable.");
      const inspection: SdCardInspection = {
        token: "synthetic-card-preview", source, label: checkpoint.label, repository,
        cardReference: "C8A0", files: 246, directories: 14, totalBytes,
        availableBytes: fixture.availableBytes,
        proposedDate: { date: "2026-11-22", basis: "File modification time", file: "DCIM/100CANON/IMG_0991.JPG" },
      };
      return inspection;
    }
    if (command === "start_sd_card_archive") {
      if (args.token !== "synthetic-card-preview" || fixture.availableBytes <= totalBytes) throw new Error("Card inspection is stale.");
      const job = makeJob(archiveId, { ...checkpoint });
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
