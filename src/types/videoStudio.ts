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
  subtitle: string;
  titleSeconds: number;
  outputDir: string;
  width: number;
  height: number;
  fps: number;
  defaultStabilization: StudioStabilizationPreset;
  defaultStabilizationMethod: StudioStabilizationMethod;
  defaultCustomStabilization: StudioCustomStabilization;
  performance: "max" | "balanced";
  encoderPreference: "auto" | "cpu";
  clips: StudioClip[];
  music: BackgroundMusic;
  assembleRenderedClips?: boolean;
  bitrateMbps: number;
}
export interface StudioActiveTask {
  key: string;
  phase: string;
  progress: number;
  fps: number | null;
  speed: number | null;
  processId?: number | null;
}
export interface StudioJob {
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
  targets?: { clipId: string; sourcePath: string; revision: number }[];
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
}
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
  outputDir: "",
  width: 3840,
  height: 2160,
  fps: 50,
  defaultStabilization: "balanced",
  defaultStabilizationMethod: "fast",
  defaultCustomStabilization: defaultCustomStabilization(),
  performance: "max",
  encoderPreference: "auto",
  clips: [],
  music: newBackgroundMusic(),
  assembleRenderedClips: true,
  bitrateMbps: 32,
});
// Add only missing fields. Backend validation still rejects invalid saved values.
// Existing projects retain their original two-pass stabilisation until explicitly changed.
export const normalizeProject = (project: StudioProject): StudioProject => ({
  ...project,
  defaultStabilization: project.defaultStabilization ?? "off",
  defaultStabilizationMethod: project.defaultStabilizationMethod ?? "quality",
  defaultCustomStabilization: project.defaultCustomStabilization ?? defaultCustomStabilization(),
  performance: project.performance ?? "max",
  encoderPreference: project.encoderPreference ?? "auto",
  clips: project.clips.map((clip) => ({
    ...clip,
    stabilizationMethod: clip.stabilizationMethod ?? "quality",
    customStabilization: clip.customStabilization ?? defaultCustomStabilization(),
  })),
});
export const clipName = (path: string) => path.split(/[\\/]/).pop() || path;
export const timecode = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
export const projectDuration = (p: StudioProject) =>
  (p.title ? p.titleSeconds : 0) +
  p.clips
    .filter((c) => c.include)
    .reduce(
      (n, c) =>
        n +
        c.duration +
        c.replays.filter((r) => r.enabled).reduce((s, r) => s + (r.end - r.start) / r.speed, 0),
      0
    );
