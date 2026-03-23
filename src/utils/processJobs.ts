import type { ProcessJob } from "../types";

export function getProcessAttemptLabel(task: ProcessJob["task"]): string {
  switch (task) {
    case "scan_archive_naming":
      return "Scanned";
    default:
      return "Processed";
  }
}

export function getProcessResultLabel(task: ProcessJob["task"]): string {
  switch (task) {
    case "focus":
      return "Flagged";
    case "remove_focus":
      return "Restored";
    case "enhance":
      return "Enhanced";
    case "remove_enhance":
      return "Removed";
    case "bw":
      return "Converted";
    case "remove_bw":
      return "Removed";
    case "stabilize":
      return "Stabilized";
    case "remove_stabilize":
      return "Removed";
    case "scan_archive_naming":
      return "Matched";
    case "apply_event_naming":
      return "Renamed";
    default:
      return "Result";
  }
}

export function getProcessResultToken(task: ProcessJob["task"]): string {
  return getProcessResultLabel(task).toLowerCase().replace(/\s+/g, "_");
}
