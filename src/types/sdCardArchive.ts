export interface ArchiveDate {
  date: string;
  basis: string;
  file?: string | null;
}

export interface SdCardInspection {
  token: string;
  source: string;
  label: string;
  repository: string;
  cardReference: string;
  files: number;
  directories: number;
  totalBytes: number;
  availableBytes: number;
  proposedDate: ArchiveDate | null;
}

export interface SdCardArchiveSummary {
  mode: "archive" | "verify";
  label: string;
  phase: string;
  totalBytes: number;
  copiedBytes: number;
  verifiedBytes: number;
  filesCopied: number;
  filesVerified: number;
  sourceMbps?: number | null;
  sustainedMbps?: number | null;
  etaSeconds?: number | null;
  bottleneck?: string | null;
  archiveFolder?: string | null;
  checksumFile?: string | null;
  date?: ArchiveDate | null;
  timestampWarnings: number;
  needsDate: boolean;
}
