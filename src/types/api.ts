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

export interface EventTypeDefinition {
  name: string;
  locations: string[];
}

export interface EventNamingCatalog {
  eventTypes: EventTypeDefinition[];
  peopleTags: string[];
  groupTags: string[];
  generalTags: string[];
}

export interface ScanEventNamingLibraryResult {
  catalog: EventNamingCatalog;
  discoveredDirectories: number;
}

export interface PrefillEventNamingFromArchiveResult {
  catalog: EventNamingCatalog;
  matchedDirectories: number;
  assignments: EventNamingAssignment[];
}

export interface EventDayDirectory {
  path: string;
  relativePath: string;
  name: string;
  year: number;
  month: number;
  day: number;
  dateKey: string;
  hasCustomName: boolean;
}

export interface RenamedEventDirectory {
  oldPath: string;
  newPath: string;
  oldName: string;
  newName: string;
  day: number;
}

export interface EventNamingAssignment {
  directory: string;
  eventType: string;
  location: string;
  source?: "manual" | "archive_prefill";
  targetName?: string;
  peopleTags: string[];
  groupTags: string[];
  generalTags: string[];
}

export interface ApplyEventNamingRequest {
  directories: string[];
  eventType: string;
  location: string;
  peopleTags: string[];
  groupTags: string[];
  generalTags: string[];
  assignments: EventNamingAssignment[];
}

export interface ApplyEventNamingResult {
  renamed: RenamedEventDirectory[];
  catalog: EventNamingCatalog;
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
  speed_mbps?: number | null;
}

export interface ProcessResult {
  processed: number;
  result_count: number;
  errors: string[];
}

export type ProcessTask = "focus" | "remove_focus" | "enhance" | "remove_enhance" | "bw" | "remove_bw" | "stabilize" | "remove_stabilize" | "scan_archive_naming" | "apply_event_naming" | "transfer" | "verify_checksums" | "scan_faces" | "search_person_videos";

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
  resultCount: number;
  currentFile: string;
  archiveDir?: string;
  conflictReportPath?: string;
  currentPhase?: string;
  speedMbps?: number | null;
  transferLocalProcessedCount?: number;
  transferLocalSidecarHitsCount?: number;
  transferLocalManifestHitsCount?: number;
  transferLocalHashComputedCount?: number;
  transferUploadedCount?: number;
  transferDeduplicatedCount?: number;
  transferRenamedCount?: number;
  transferServerHashMatchCount?: number;
  transferServerHashUnverifiedCount?: number;
  transferIndexedAddedCount?: number;
  stabilizationMode?: StabilizationMode;
  stabilizationStrength?: StabilizationStrength;
  preserveSourceBitrate?: boolean;
  stabilizeMaxParallelJobsUsed?: number;
  stabilizeFfmpegThreadsPerJobUsed?: number;
  framesPerSecond?: number;
  similarityThreshold?: number;
  videosScanned?: number;
  facesDetected?: number;
  uniquePeople?: number;
  personName?: string;
  searchResults?: VideoMatch[];
  errors: string[];
  logs: string[];
  statusLine: string;  // Single-line status that updates in-place
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

// Face Recognition types
export interface FaceEmbedding {
  personId: string;
  personName: string;
  embedding: number[];
  sourceVideo: string;
  timestampMs: number;
  confidence: number;
}

export interface FaceDatabase {
  version: number;
  faces: FaceEmbedding[];
  updatedAt: string;
}

export interface PersonIdentity {
  personId: string;
  personName: string;
  distinctEmbeddings: number;
  videoCount: number;
  lastSeen: string;
}

export interface VideoMatch {
  videoPath: string;
  relativePath: string;
  matchCount: number;
  timestamps: number[];
  firstMatch: number;
  lastMatch: number;
}

export interface SearchPersonResult {
  personIdentity: PersonIdentity;
  matches: VideoMatch[];
}

export interface ScanFacesConfig {
  archiveDir: string;
  framesPerSecond: number;
  similarityThreshold: number;
}

export interface ScanFacesResult {
  videosScanned: number;
  facesDetected: number;
  uniquePeople: number;
  dbPath: string;
}
