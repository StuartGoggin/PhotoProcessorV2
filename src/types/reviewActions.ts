export interface ReviewActionRequest {
  stagingDir: string; relativePath: string; expectedSourceStamp: string; actionId: string; trashed: boolean;
}
export interface ReviewReplayRequest {
  stagingDir: string; direction: "undo" | "redo"; actionId: string; expectedRevision?: number;
}
export type ReviewWriteRequest = ReviewActionRequest | ReviewReplayRequest;
export interface ReviewHistoryEntry {
  id: string; capturePath: string; label: string; beforeTrashed: boolean; afterTrashed: boolean;
  beforeReviewed: boolean; afterReviewed: boolean; outcome: "saved" | "permanently_removed" | "blocked";
  canUndo: boolean; canRedo: boolean; createdAt: string | number;
}
export interface ReviewActionReceipt {
  actionId: string; revision: number; relativePath: string; renamed: {oldPath:string;newPath:string}[];
  trashed: boolean; reviewed: boolean; sourceStamp: string; entry: ReviewHistoryEntry;
  canUndo:boolean;canRedo:boolean;
  review: {root:string;relativePath:string;key:string;sourceStamp:string;reviewed:boolean;revision:number;explicit:boolean};
}
export interface ReviewHistory {
  revision:number; entries:ReviewHistoryEntry[]; canUndo:boolean;canRedo:boolean;total:number;
  nextOffset:number|null;warnings:string[];
}
export interface TrashPreview {
  id:string;stagingDir:string;relativeDir:string;recursive:boolean;canStart:boolean;
  items:{relativePath:string;capturePath:string;kind:string;bytes:number;included:boolean;reason:string}[];
  captureCount:number;fileCount:number;totalBytes:number;warnings:string[];
}
