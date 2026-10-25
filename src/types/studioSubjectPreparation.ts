/** Native-owned IDs resolve artifacts. Paths/hashes from UI are not authority. */
export interface StudioPreparedSubjectBase {
  version: 1;
  id: string;
  clipId: string;
  identity: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  basePolicy: "reuse" | "clean";
  reused: boolean;
  containsGlobalSharpening: boolean;
  warnings: string[];
}
export interface StudioSubjectFrame {
  preparationId: string;
  baseIdentity: string;
  frame: number;
  dataUrl: string;
}
export interface StudioSubjectTracking {
  version:1;id:string;preparationId:string;baseIdentity:string;maskIdentity:string;maskSha256:string;
  frames:number;device:"cpu"|"cuda";secondsIncludingLoad:number;minimumSeamIoU:number|null;
  selection:import("./studioFinishing").StudioSubjectSelection;review?:StudioSubjectReviewReceipt|null;reviewed:false;exportQualified:false;
}
/** This is a human assertion for listed frames, never semantic/model approval. */
export interface StudioSubjectReviewReceipt {
  schema:1;sequence:number;previousIdentity:string|null;receiptIdentity:string;
  assertionKind:"user-asserted";timestamp:string;decision:"approve"|"reject";coverage:"sampledFrames";frames:number[];
  binding:{baseChecksum:string;baseSha256:string;width:number;height:number;fps:number;frames:number;
    maskIdentity:string;maskSha256:string;canonicalRecipeSha256:string;generationProfile:unknown;runtimeProfile:string;runtimeSeal:string};
}
export interface StudioSubjectReviewReply {
  trackingId:string;preparationId:string;baseIdentity:string;maskIdentity:string;maskSha256:string;
  review:StudioSubjectReviewReceipt;reviewed:false;exportQualified:false;subjectQualityAccepted:false;
}
export interface StudioSubjectMaskFrame extends StudioSubjectFrame {
  trackingId:string;maskIdentity:string;
}
export interface StudioSubjectFinishedFrame extends StudioSubjectMaskFrame {
  settings:import("./studioFinishing").StudioFinishingSettings;
  settingsIdentity:string;width:number;height:number;beforeDataUrl:string;
  engine:"subject-rgb709-q4-v2";exportQualified:false;note:string;
}
