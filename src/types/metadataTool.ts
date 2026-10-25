/** Native metadata_tool_status result. No raw process output or credentials. */
export interface MetadataToolStatus {
  ready: boolean;
  source: "override" | "bundled" | "path" | "unavailable";
  version?: string | null;
  path?: string | null;
  message: string;
}
export const METADATA_TOOL_SOURCES: Record<MetadataToolStatus["source"], string> = {
  override: "Folder override",
  bundled: "Bundled ExifTool",
  path: "System PATH",
  unavailable: "Unavailable",
};
