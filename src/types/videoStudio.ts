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
}
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
