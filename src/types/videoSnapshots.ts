/** Original-video snapshot interface. Frame indexes refer to native, timestamp-indexed frames. */
export interface SnapshotClip {
  id: string;
  identity: string;
  path: string;
  name: string;
  width: number;
  height: number;
  frameTimesMs: number[];
  suggestedStart: string | null;
  timeSource: string;
  warnings: string[];
}

export interface SnapshotFrame { index: number; atMs: number; data: string }
export interface SnapshotFrames { frames: SnapshotFrame[] }
export interface SnapshotCrop { x: number; y: number; width: number; height: number }
export interface SnapshotRecipe {
  brightness: number;
  contrast: number;
  sharpness: number;
  crop: SnapshotCrop | null;
}
export interface SnapshotExport {
  path: string;
  enhancedPath: string | null;
  provenancePath: string;
  capturedAt: string;
  width: number;
  height: number;
}
export const defaultSnapshotRecipe = (): SnapshotRecipe => ({ brightness: 0, contrast: 0, sharpness: 0, crop: null });

export interface SnapshotSource {
  clip: SnapshotClip;
  shootingStart: string;
  timeConfirmed: boolean;
  position: number;
}
export interface SnapshotSelection {
  id: string;
  clipId: string;
  index: number;
  thumbnail: string;
  personName: string;
  recipe: SnapshotRecipe;
  exported: SnapshotExport | null;
  /** Transient receipt scope; not persisted in sessions or sent to the native exporter. */
  exportedDestination?: string;
}

/** Persist paths/identities/positions, not transient IDs, frame indexes or huge decoded media. */
export interface SnapshotSession {
  kind: "photogogo-video-snapshots";
  version: 1;
  sources: { path: string; identity: string; shootingStart: string; timeConfirmed: boolean; position: number }[];
  selections: { sourcePath: string; identity: string; index: number; personName: string; recipe: SnapshotRecipe }[];
}
