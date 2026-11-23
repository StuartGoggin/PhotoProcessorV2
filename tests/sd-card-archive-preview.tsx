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
const reuseJobId = "sd_archive_" + "9".repeat(32);
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
  librarySlow: false,
  reuseReplaced: false,
  reusePhase(phase: "compare" | "failed" | "matched") {
    const job = this.jobs.find(item => item.id === reuseJobId);
    if (!job?.sdCardArchive?.reuseProof) throw new Error("Missing synthetic reuse proof");
    const proof = job.sdCardArchive.reuseProof;
    const matched = phase === "matched";
    const side = {
      files: 246, folders: 14, bytes: totalBytes,
      checkedFiles: matched ? 246 : 79, checkedBytes: matched ? totalBytes : 18 * 1024 ** 3,
    };
    Object.assign(proof, {
      stage: phase === "compare" ? "compare" : "report",
      archivesSearched: 4, candidates: 2,
      card: { ...side, files: phase === "failed" ? 247 : 246 },
      archive: { ...side }, archiveFolder, checksumFile: archiveFolder + "\\SD-C8A01234_2026-11-21.checksums.json",
      manifestSha256: "2".repeat(64),
      checkedAt: matched ? "2026-11-24T02:00:00Z" : null,
    });
    const currentPhase = matched ? "Card and repository matched" : phase === "failed" ? "Verification incomplete" : "Checking card checksums";
    Object.assign(job.sdCardArchive, {
      phase: currentPhase,
      strictMetadata: matched,
      archiveFolder: matched ? archiveFolder : null,
      checksumFile: matched ? proof.checksumFile : null,
    });
    Object.assign(job, {
      currentPhase, status: matched ? "completed" : phase === "failed" ? "needs_attention" : "running",
      errors: phase === "failed" ? ["Mismatch: DCIM/extra.jpg"] : [],
    });
  },
  libraryPreviewsActive: 0,
  libraryPeakPreviews: 0,
  archiveId,
  complete(id: string) {
    const job = this.jobs.find(item => item.id === id);
    if (!job?.sdCardArchive) throw new Error("Missing synthetic archive");
    const completed = {
      ...job.sdCardArchive, phase: "Verified", verifiedBytes: totalBytes, filesVerified: 246,
      strictMetadata: true,
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
    if (command === "list_sd_archive_library") return {
      books: [
        { name: "SD-C8A01234_2026-11-21", card: "SD-C8A01234", dateHint: "2026-11-21" },
        { name: "2025-12-01_SD-legacy-archive", card: "Legacy SD archive", dateHint: "2025-12-01" },
      ],
      skipped: 0,
    };
    if (command === "sd_archive_library_date_range") {
      while (fixture.librarySlow) await new Promise(resolve => setTimeout(resolve, 50));
      return args.name === "SD-C8A01234_2026-11-21"
        ? { first: "2026-11-21", last: "2026-11-22", estimated: false, undated: 0 }
        : { first: "2025-12-01", last: "2025-12-01", estimated: true, undated: 0 };
    }
    if (command === "sd_archive_library_page") {
      const size = args.name === "SD-C8A01234_2026-11-21" ? 64 : 1;
      const offset = Number(args.offset);
      return {
        revision: "browser-fixture:" + args.name,
        card: "C8A01234", archiveDate: "2026-11-21", total: size, offset,
        photos: Array.from({length: Math.max(0, Math.min(48, size - offset))}, (_, i) => {
          const index = i + offset;
          const name = "IMG_" + String(index + 1).padStart(4, "0") + ".JPG";
          return { index, name, relative: "DCIM/100CANON/" + name };
        }),
      };
    }
    if (command === "sd_archive_library_preview") {
      fixture.libraryPreviewsActive += 1;
      fixture.libraryPeakPreviews = Math.max(fixture.libraryPeakPreviews, fixture.libraryPreviewsActive);
      try {
        while (fixture.librarySlow) await new Promise(resolve => setTimeout(resolve, 50));
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 210;
        const context = canvas.getContext("2d")!;
        const gradient = context.createLinearGradient(0, 0, 320, 210);
        gradient.addColorStop(0, "hsl(" + (Number(args.index) * 47 % 360) + ", 44%, 47%)");
        gradient.addColorStop(1, "#354859");
        context.fillStyle = gradient;
        context.fillRect(0, 0, 320, 210);
        return canvas.toDataURL("image/jpeg").split(",")[1];
      } finally {
        fixture.libraryPreviewsActive -= 1;
      }
    }
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
      if (!second && fixture.recovery && !args.newSnapshot && !args.replaceFolder) {
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
      const job = makeJob(args.replaceFolder ? "sd_archive_" + "d".repeat(32) : second ? secondArchiveId : archiveId, {
        ...checkpoint, label: second ? secondLabel : checkpoint.label,
      }, second ? secondSource : source);
      fixture.jobs.unshift(job);
      return structuredClone(job);
    }
    if (command === "review_sd_archive_upgrade") {
      if (args.folder !== archiveFolder) throw new Error("Archive folder missing.");
      return {
        token: "test-upgrade-token", targetName: "SD-C8A01234_2026-11-22",
        date: { date: "2026-11-22", basis: "Embedded capture time" }, serialKnown: true,
        fileTimes: 246, fileCount: 246, folderTimes: 0, directoryCount: 14, rootTime: false,
      };
    }
    if (command === "start_sd_archive_upgrade" || command === "remove_sd_archive_after_recreation") {
      const upgrade = command === "start_sd_archive_upgrade";
      const job = makeJob("sd_archive_" + (upgrade ? "e" : "f").repeat(32), {
        ...checkpoint, mode: upgrade ? "upgrade" : "remove", phase: "Verifying",
      });
      fixture.jobs.unshift(job);
      return structuredClone(job);
    }
    if (command === "verify_sd_card_for_reuse") {
      if (args.source !== source || !fixture.mounted) throw new Error("The selected card is unavailable.");
      fixture.jobs = fixture.jobs.filter(job => job.id !== reuseJobId);
      const job = makeJob(reuseJobId, {
        ...checkpoint, mode: "verifyReuse", phase: "Looking for matching archives",
        copiedBytes: 0, filesCopied: 0, verifiedBytes: 0, filesVerified: 0,
        reuseProof: {
          stage: "lookup", cardId: "C8A01234", archivesSearched: 0, candidates: 0, unreadable: 0,
          card: null, archive: null, archiveFolder: null, checksumFile: null, manifestSha256: null, checkedAt: null,
        },
      }, source);
      fixture.jobs.unshift(job);
      return structuredClone(job);
    }
    if (command === "confirm_sd_card_reuse") {
      if (fixture.reuseReplaced) throw new Error("The selected card was removed or replaced. Start a new reuse check.");
      if (args.jobId !== reuseJobId || !fixture.jobs.find(job => job.id === reuseJobId && job.status === "completed")) {
        throw new Error("A complete verification proof is required.");
      }
      return;
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
