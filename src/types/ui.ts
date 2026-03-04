/** UI-only types — not mirrored in Rust. */

export type Page =
  | "import"
  | "postprocess"
  | "review"
  | "tidyup"
  | "transfer"
  | "settings";

export interface ImageSet {
  original: string | null;
  improved: string | null;
  bw: string | null;
}
