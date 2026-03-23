/**
 * API types — mirror the Rust structs exposed via Tauri commands/events.
 * Keep in sync with src-tauri/src/commands/*.rs
 */

export interface Settings {
  source_root: string;
  staging_dir: string;
  archive_dir: string;
  stabilize_max_parallel_jobs: number;
  stabilize_ffmpeg_threads_per_job: number;
}

export interface ImportProgress {
  total: number;
  done: number;
  current_file: string;
  speed_mbps: number;
  skipped: number;
  errors: string[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  sourceFileTotal: number;
  ignoredFileTotal: number;
  ignoredLegacyMd5SidecarTotal: number;
  unsupportedFileTotal: number;
  errors: string[];
}

export interface ImportOptions {
  reprocessExisting: boolean;
}

export interface SourceShortcut {
  path: string;
  label: string;
}

export type ImportJobStatus = "queued" | "running" | "paused" | "aborted" | "completed" | "failed";

export interface ImportJob {
  id: string;
  sourceDir: string;
  stagingDir: string;
  logFilePath: string;
  manifestFilePath: string;
  reprocessExisting: boolean;
  status: ImportJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sourceFileTotal: number;
  ignoredFileTotal: number;
  ignoredLegacyMd5SidecarTotal: number;
  unsupportedFileTotal: number;
  total: number;
  done: number;
  skipped: number;
  speedMbps: number;
  currentFile: string;
  imported: number;
  md5SidecarHits: number;
  md5Computed: number;
  errors: string[];
  logs: string[];
  pauseRequested: boolean;
  abortRequested: boolean;
}

export interface ProcessProgress {
  total: number;
  done: number;
  current_file: string;
  phase: string;
}

export interface ProcessResult {
  processed: number;
  out_of_focus: number;
  errors: string[];
}

export type ProcessTask = "focus" | "remove_focus" | "enhance" | "remove_enhance" | "bw" | "remove_bw" | "stabilize" | "remove_stabilize";

export type ProcessScopeMode = "entireStaging" | "folderRecursive" | "folderOnly";

export type StabilizationMode = "maxFrame" | "edgeSafe" | "aggressiveCrop";

export type StabilizationStrength = "gentle" | "balanced" | "strong";

export type ProcessJobStatus = "queued" | "running" | "paused" | "aborted" | "completed" | "failed";

export interface ProcessJob {
  id: string;
  task: ProcessTask;
  stagingDir: string;
  scopeDir: string;
  scopeMode: ProcessScopeMode;
  status: ProcessJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  processed: number;
  outOfFocus: number;
  currentFile: string;
  stabilizationMode?: StabilizationMode;
  stabilizationStrength?: StabilizationStrength;
  preserveSourceBitrate?: boolean;
  stabilizeMaxParallelJobsUsed?: number;
  stabilizeFfmpegThreadsPerJobUsed?: number;
  errors: string[];
  logs: string[];
  pauseRequested: boolean;
  abortRequested: boolean;
}

export interface TransferProgress {
  total: number;
  done: number;
  current_file: string;
  phase: string;
  speed_mbps: number;
}

export interface TransferResult {
  copied: number;
  verified: number;
  errors: string[];
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  children?: TreeNode[];
}
