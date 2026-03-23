/** UI-only types — not mirrored in Rust. */

export type Page =
  | "import"
  | "nameevents"
  | "cleanup"
  | "jobs"
  | "postprocess"
  | "review"
  | "transfer"
  | "settings"
  | "logs";

export interface ImageSet {
  original: string | null;
  improved: string | null;
  bw: string | null;
}
