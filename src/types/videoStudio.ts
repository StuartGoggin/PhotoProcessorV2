export interface StudioReplay {
  id: string;
  start: number;
  end: number;
  speed: number;
  caption: string;
  enabled: boolean;
}
export type StudioStabilizationPreset = "off" | "gentle" | "balanced" | "strong" | "custom";
export type StudioStabilizationMethod = "fast" | "quality";
export type StudioWindReductionPreset = "off" | "light" | "moderate" | "strong";
export type StudioClipWindReduction = "inherit" | StudioWindReductionPreset;
export type StudioScoreTiming = "clipEnd" | "afterReplays" | "separateCard" | "clipStart" | "custom";
export interface StudioGraphicsTheme {
  font: "segoe" | "georgia" | "trebuchet";
  palette: "midnight" | "ivory" | "slate";
  accent: string;
  position: "bottom" | "top";
  opacity: number;
}
export interface StudioGraphicsSettings {
  version: 1;
  theme: StudioGraphicsTheme;
  styledTitles: boolean;
  scorecardTiming: StudioScoreTiming;
  scorecardSeconds: number;
  scorecardStart: number;
}
export interface StudioScorecard {
  enabled: boolean;
  template: "line" | "result" | "table";
  heading: string;
  result: string;
  subtitle: string;
  columns: string[];
  rows: string[][];
  timing: "inherit" | StudioScoreTiming;
  seconds: number;
  start: number;
}
export interface StudioCustomStabilization {
  radius: number;
  blockSize: number;
  contrast: number;
}
export const defaultCustomStabilization = (): StudioCustomStabilization => ({
  radius: 16,
  blockSize: 8,
  contrast: 125,
});
export interface StudioClip {
  id: string;
  path: string;
  duration: number;
  include: boolean;
  chapter: string;
  title: string;
  titleHeading?: string;
  titleSubtitle?: string;
  titleSeconds: number;
  stabilization: StudioStabilizationPreset;
  stabilizationMethod: StudioStabilizationMethod;
  customStabilization: StudioCustomStabilization;
  framing: "edgeSafe" | "maxFrame" | "aggressiveCrop";
  reviewed: boolean;
  notes: string;
  replays: StudioReplay[];
  rendered?: StudioClipRender | null;
  revision?: number;
  // Camera-audio processing is applied at final assembly, not picture rendering.
  windReduction?: StudioClipWindReduction;
  // Finishing-only: never changes the reusable stabilised picture.
  scorecard?: StudioScorecard;
}
export interface StudioClipRender {
  path: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  renderedAt: string;
  bitrateMbps: number;
  revision: number;
  signature: string;
  available?: boolean;
  titleStyleKey?: string;
}
export interface MusicSection {
  name: string;
  bars: number;
  energy: number;
}
export interface MusicDirection {
  title: string;
  summary: string;
  genre: string;
  mood: string;
  key: string;
  mode: "major" | "minor";
  bpm: number;
  energy: number;
  instruments: string[];
  chordProgression: string[];
  arrangement: MusicSection[];
}
export interface BackgroundMusic {
  enabled: boolean;
  creativeBrief: string;
  direction: MusicDirection | null;
  midiPath: string;
  lmmsPath: string;
  audioPath: string;
  musicVolume: number;
  originalVolume: number;
  requestId: string;
  projectPath: string;
}
export const newBackgroundMusic = (): BackgroundMusic => ({
  enabled: false,
  creativeBrief: "",
  direction: null,
  midiPath: "",
  lmmsPath: "",
  audioPath: "",
  musicVolume: 28,
  originalVolume: 45,
  requestId: "",
  projectPath: "",
});
export interface StudioProject {
  version: number;
  name: string;
  team: string;
  title: string;
  titleHeading?: string;
  subtitle: string;
  titleSeconds: number;
  openingTitleMode: "card" | "overlay" | "none";
  outputDir: string;
  width: number;
  height: number;
  fps: number;
  defaultStabilization: StudioStabilizationPreset;
  defaultStabilizationMethod: StudioStabilizationMethod;
  defaultCustomStabilization: StudioCustomStabilization;
  performance: "max" | "balanced";
  adaptiveScheduling: boolean;
  encoderPreference: "auto" | "cpu";
  clips: StudioClip[];
  music: BackgroundMusic;
  defaultWindReduction?: StudioWindReductionPreset;
  graphics?: StudioGraphicsSettings;
  assembleRenderedClips?: boolean;
  bitrateMbps: number;
}
export interface StudioActiveTask {
  key: string;
  phase: string;
  progress: number;
  fps: number | null;
  speed: number | null;
  threads?: number;
  processId?: number | null;
}
export interface StudioSchedulerSnapshot {
  adaptive: boolean;
  targetWorkers: number;
  activeWorkers: number;
  reservedThreads: number;
  cpuPercent: number | null;
  availableMemoryBytes: number | null;
  gpuEncoderPercent: number | null;
  gpuDecoderPercent: number | null;
  gpuComputePercent: number | null;
  gpuMemoryFreeBytes: number | null;
  throughputFps: number | null;
  reason: string;
}
export interface StudioJob {
  // Immutable edit recipe captured by native enqueue; absent on legacy jobs.
  sequence?: unknown;
  id: string;
  name: string;
  status: string;
  phase: string;
  progress: number;
  output: string | null;
  error: string | null;
  logs: string[];
  cancelled: boolean;
  paused: boolean;
  kind?: "preview" | "clip" | "project" | "assembly" | "music";
  clipId?: string | null;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  bitrateMbps?: number;
  targets?: { clipId: string; sourcePath: string; revision: number; titleStyleKey?: string }[];
  artifacts?: { clipId: string; sourcePath: string; rendered: StudioClipRender }[];
  musicRequestId?: string;
  musicProjectPath?: string | null;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  heartbeatAt?: string;
  progressAt?: string;
  processId?: number | null;
  processName?: string;
  logPath?: string;
  retryOf?: string | null;
  retriedAs?: string | null;
  queuePosition: number | null;
  activeTasks: StudioActiveTask[];
  encoder: string;
  hardwareNote: string;
  workerLimit: number;
  threadsPerWorker: number;
  cacheHits: number;
  elapsedSeconds: number;
  etaSeconds: number | null;
  recoverable: boolean;
  persistenceError: string | null;
  scheduler?: StudioSchedulerSnapshot | null;
}
// Snapshots describe the shared processing pool, not the individual job carrying them.
// Never use persisted/final-job telemetry as a reading of the current machine.
export const liveStudioScheduler = (jobs: StudioJob[]): StudioSchedulerSnapshot | null => {
  for (const job of jobs) {
    const snapshot = job.scheduler;
    if (job.status !== "running" || !snapshot || typeof snapshot !== "object") continue;
    if (typeof snapshot.adaptive !== "boolean") continue;
    if (![snapshot.targetWorkers, snapshot.activeWorkers, snapshot.reservedThreads]
      .every((value) => Number.isSafeInteger(value) && value >= 0)) continue;
    return snapshot;
  }
  return null;
};
export const formatStudioMetric = (value: unknown, kind: "percent" | "memory" | "fps" | "threads"): string => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "N/A";
  if (kind === "percent") return value <= 100 ? `${Math.round(value)}%` : "N/A";
  if (kind === "memory") return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (kind === "fps") return `${value.toFixed(1)} fps`;
  return Number.isSafeInteger(value) && value > 0 ? `${value} CPU thread(s) allocated` : "N/A";
};
export const isPendingStudioJob = (job: StudioJob) =>
  ["queued", "running", "paused"].includes(job.status) || (job.status === "interrupted" && job.recoverable);
export const sortStudioJobs = (jobs: StudioJob[]) => {
  const rank = (job: StudioJob) => {
    if (job.status === "running") return 0;
    if (job.status === "queued") return 1;
    if (isPendingStudioJob(job)) return 2;
    if (job.status === "failed") return 3;
    return 4;
  };
  return [...jobs].sort((a, b) => rank(a) - rank(b) ||
    (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER) ||
    b.id.localeCompare(a.id));
};
export const newProject = (): StudioProject => ({
  version: 1,
  name: "Training review",
  team: "",
  title: "TEAM TRAINING REVIEW",
  subtitle: "",
  titleSeconds: 5,
  openingTitleMode: "card",
  outputDir: "",
  width: 3840,
  height: 2160,
  fps: 50,
  defaultStabilization: "balanced",
  defaultStabilizationMethod: "fast",
  defaultCustomStabilization: defaultCustomStabilization(),
  performance: "max",
  adaptiveScheduling: true,
  encoderPreference: "auto",
  clips: [],
  music: newBackgroundMusic(),
  defaultWindReduction: "off",
  assembleRenderedClips: true,
  bitrateMbps: 32,
});
// Add only missing fields. Backend validation still rejects invalid saved values.
// Existing projects retain their original two-pass stabilisation until explicitly changed.
export const normalizeProject = (project: StudioProject): StudioProject => ({
  ...project,
  openingTitleMode: project.openingTitleMode ?? "card",
  defaultStabilization: project.defaultStabilization ?? "off",
  defaultStabilizationMethod: project.defaultStabilizationMethod ?? "quality",
  defaultCustomStabilization: project.defaultCustomStabilization ?? defaultCustomStabilization(),
  performance: project.performance ?? "max",
  adaptiveScheduling: project.adaptiveScheduling ?? true,
  encoderPreference: project.encoderPreference ?? "auto",
  defaultWindReduction: project.defaultWindReduction ?? "off",
  clips: project.clips.map((clip) => ({
    ...clip,
    stabilizationMethod: clip.stabilizationMethod ?? "quality",
    customStabilization: clip.customStabilization ?? defaultCustomStabilization(),
    windReduction: clip.windReduction ?? "inherit",
  })),
});
export const clipName = (path: string) => path.split(/[\\/]/).pop() || path;
export const timecode = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
const scorecardExtraDuration = (p: StudioProject, c: StudioClip) => {
  const s = c.scorecard;
  if (!s?.enabled || (s.timing === "inherit" ? p.graphics?.scorecardTiming : s.timing) !== "separateCard") return 0;
  const seconds = s.timing === "inherit" ? (p.graphics?.scorecardSeconds ?? 6) : s.seconds;
  return Math.round(seconds * p.fps) / p.fps;
};
export const projectDuration = (p: StudioProject) =>
  (p.title.trim() && (p.openingTitleMode ?? "card") === "card" ? p.titleSeconds : 0) +
  p.clips
    .filter((c) => c.include)
    .reduce(
      (n, c) =>
        n +
        c.duration + scorecardExtraDuration(p, c) +
        c.replays.filter((r) => r.enabled).reduce((s, r) => s + (r.end - r.start) / r.speed, 0),
      0
    );
