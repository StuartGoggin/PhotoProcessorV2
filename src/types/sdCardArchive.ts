export interface ArchiveDate {
  date: string;
  basis: string;
  file?: string | null;
}

export interface SdArchiveSource {
  path: string;
  label: string;
  kind: "sd" | "usb" | "mmc" | "removable";
  capacityBytes: number | null;
}

export interface SdCardInspection {
  token: string | null;
  source: string;
  label: string;
  repository: string | null;
  cardReference: string;
  files: number;
  directories: number;
  totalBytes: number;
  availableBytes: number | null;
  repositoryIssue: string | null;
  proposedDate: ArchiveDate | null;
  recovery?: { jobId: string; completed: boolean } | null;
}

export interface SdCardArchiveSummary {
  mode: "archive" | "verify" | "upgrade" | "remove";
  label: string;
  phase: string;
  totalBytes: number;
  copiedBytes: number;
  verifiedBytes: number;
  filesCopied: number;
  filesVerified: number;
  filesReused?: number;
  filesRepaired?: number;
  sourceMbps?: number | null;
  sustainedMbps?: number | null;
  etaSeconds?: number | null;
  bottleneck?: string | null;
  archiveFolder?: string | null;
  checksumFile?: string | null;
  date?: ArchiveDate | null;
  timestampWarnings: number;
  strictMetadata?: boolean;
  needsDate: boolean;
}
