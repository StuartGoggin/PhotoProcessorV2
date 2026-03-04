/**
 * API types — mirror the Rust structs exposed via Tauri commands/events.
 * Keep in sync with src-tauri/src/commands/*.rs
 */

export interface Settings {
  source_root: string;
  staging_dir: string;
  archive_dir: string;
}

export interface ImportProgress {
  total: number;
  done: number;
  current_file: string;
  speed_mbps: number;
  skipped: number;
  errors: string[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface ProcessProgress {
  total: number;
  done: number;
  current_file: string;
  phase: string;
}

export interface ProcessResult {
  processed: number;
  out_of_focus: number;
  errors: string[];
}

export interface TransferProgress {
  total: number;
  done: number;
  current_file: string;
  phase: string;
  speed_mbps: number;
}

export interface TransferResult {
  copied: number;
  verified: number;
  errors: string[];
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  children?: TreeNode[];
}
