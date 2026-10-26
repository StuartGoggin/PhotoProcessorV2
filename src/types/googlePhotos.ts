/** Public native IPC only. Credentials, resumable URLs and upload tokens must
 * never be returned to the webview or stored in browser storage. */
export type GooglePhotoVariant = "original" | "bw" | "enhanced" | "crop" | "crop_bw" | "crop_enhanced";
export type GooglePhotoMode = "checked" | "preferred_colour" | "originals" | "variants";

export interface GooglePhotosAccount { id: string; email: string; displayName: string }
export interface GooglePhotosStatus {
  configured: boolean;
  clientIdHint?: string;
  account?: GooglePhotosAccount | null;
  connecting: boolean;
  error?: string | null;
}
export interface GooglePhotoAsset {
  id: string;
  relativePath: string;
  variant: GooglePhotoVariant;
  selected: boolean;
  favourite: boolean;
  uploadStatus?: string;
}
export interface GooglePhotoCatalogue { root: string; revision: number; assets: GooglePhotoAsset[]; warnings: string[] }
export interface GooglePhotosPlanRequest {
  root: string;
  scopeDir?: string;
  mode: GooglePhotoMode;
  variants: GooglePhotoVariant[];
  minStars: number;
  favouritesOnly: boolean;
  excludeTrash: boolean;
  stripGps: boolean;
  albumMode: "new" | "continue";
  albumTitle?: string;
  groupByEventDay: boolean;
  eventName?: string;
  eventDate?: string;
}
export interface GooglePhotoPlanItem {
  id: string;
  relativePath: string;
  variant: GooglePhotoVariant;
  bytes: number;
  status: string;
  warnings: string[];
}
export interface GooglePhotoPlanAlbum {
  key: string;
  title: string;
  date?: string;
  albumId?: string;
  itemIds: string[];
  coverItemId?: string;
}
export interface GooglePhotosPlan {
  id: string;
  accountId: string;
  accountEmail: string;
  items: GooglePhotoPlanItem[];
  albums: GooglePhotoPlanAlbum[];
  warnings: string[];
  totalBytes: number;
}
export interface GooglePhotoAlbumEdit { key: string; title: string; coverItemId?: string }
export interface GooglePhotosJobAlbum { key: string; title: string; productUrl?: string; state?: string }
export interface GooglePhotosExistingAlbum { id: string; title: string; productUrl: string }
export interface GooglePhotosJob {
  id: string;
  status: string;
  accountEmail: string;
  accountId: string;
  createdAt: string;
  done: number;
  total: number;
  uploaded: number;
  /** Registration receipts accepted in this job, excluding reused/skipped items. */
  accepted?: number;
  /** Accepted receipts not yet verified; includes verificationNeedsAttention. */
  awaitingVerification?: number;
  /** Awaiting receipts whose last verification attempt has a saved error. */
  verificationNeedsAttention?: number;
  /** Accepted receipts whose additional read-back is unavailable. Not failures or verified photos. */
  readbackUnavailable?: number;
  historyHidden?: boolean;
  canOpenAlbum?: boolean;
  skipped: number;
  failed: number;
  bytesDone: number;
  totalBytes: number;
  currentFile: string;
  albums: GooglePhotosJobAlbum[];
  errors: string[];
}
