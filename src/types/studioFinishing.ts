/** Finishing never changes a clip's camera-motion recipe. */
export interface StudioColourGrade {
  /** Endpoint-preserving midtone trim, not scene-referred camera exposure. */
  lightEv: number;
  contrast: number;
  saturation: number;
  warmth: number;
}

export interface StudioFinishingSettings {
  version: 1;
  enabled: boolean;
  subject: "horseRider";
  colourScope: "subject";
  /** Reuse is the safe initial choice; regeneration is always explicit. */
  basePolicy: "reuse" | "clean";
  sharpening: { amount: number; noiseThreshold: number };
  colour: StudioColourGrade;
  wholeFrame: { enabled: boolean; colour: StudioColourGrade };
}

export type StudioFinishingInput = Partial<Omit<StudioFinishingSettings,
  "sharpening" | "colour" | "wholeFrame">> & {
  sharpening?: Partial<StudioFinishingSettings["sharpening"]>;
  colour?: Partial<StudioColourGrade>;
  wholeFrame?: { enabled?: boolean; colour?: Partial<StudioColourGrade> };
};

export interface StudioSubjectPoint { x: number; y: number; include: boolean }
export interface StudioSubjectAnchor {
  frame: number;
  object: "horse" | "rider";
  box?: [number, number, number, number];
  points?: StudioSubjectPoint[];
}
/** Coordinates refer to this exact stabilized base, never the original frame. */
export interface StudioSubjectSelection {
  version: 1;
  baseIdentity: string;
  frameCount: number;
  referenceFrame?: number;
  anchors: StudioSubjectAnchor[];
}
