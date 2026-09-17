export interface StudioReplay {
  id: string;
  start: number;
  end: number;
  speed: number;
  caption: string;
  enabled: boolean;
}
export interface StudioClip {
  id: string;
  path: string;
  duration: number;
  include: boolean;
  chapter: string;
  title: string;
  titleSeconds: number;
  stabilization: "off" | "gentle" | "balanced" | "strong";
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
  clips: StudioClip[];
  music: BackgroundMusic;
  assembleRenderedClips?: boolean;
  bitrateMbps: number;
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
}
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
  clips: [],
  music: newBackgroundMusic(),
  assembleRenderedClips: true,
  bitrateMbps: 32,
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
