export type ArchiveRuleMode = "all" | "rated" | "google_selected" | "none";
export type ArchiveVariantKey = "originals" | "bw" | "enhanced" | "crops" | "cropBw" | "cropEnhanced";
export interface ArchiveRule { mode: ArchiveRuleMode; minStars: number }
export interface ArchivePreferences {
  rules: Record<ArchiveVariantKey, ArchiveRule>;
  excludeTrash: boolean;
  includeVideos: boolean;
  includeSourceOriginals: boolean;
  includeLibraryMetadata: boolean;
  includeCameraSidecars: boolean;
}
export interface ArchiveRequest extends ArchivePreferences {
  stagingDir: string;
  archiveDir: string;
  scopeDir?: string | null;
}
export interface ArchivePreviewItem {
  relativePath: string;
  kind: string;
  bytes: number;
  included: boolean;
  reason: string;
}
export interface ArchivePreview {
  id: string;
  stagingDir: string;
  archiveDir: string;
  scopeDir: string;
  createdAt: string;
  canStart: boolean;
  summary: {
    includedCount: number;
    excludedCount: number;
    includedBytes: number;
    groups: Array<{ kind: string; includedCount: number; excludedCount: number; includedBytes: number }>;
  };
  items: ArchivePreviewItem[];
  warnings: string[];
}
