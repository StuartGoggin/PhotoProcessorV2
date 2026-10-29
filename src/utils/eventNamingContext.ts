import type { EventNamingContext, EventNamingResult, NamingDay } from "../types/eventNaming";

export function namingRootKey(root: string): string {
  return root.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "").replace(/\/+$/, "").toLowerCase();
}

export function eventPathInRoot(root: string, absolute: string): string {
  const plain = (path: string) => path.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "").replace(/\/+$/, "");
  const base = plain(root), path = plain(absolute);
  if (path.toLowerCase() === base.toLowerCase()) return "";
  if (!base || !path.toLowerCase().startsWith(base.toLowerCase() + "/")) throw Error("Selected folder is outside staging.");
  return eventRelativePath(path.slice(base.length + 1));
}

export const eventAbsolutePath = (root: string, relative: string) => relative ? `${root.replace(/[\\/]+$/, "")}\\${eventRelativePath(relative).replace(/\//g, "\\")}` : root;

export function eventRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/")) throw Error("Choose a folder inside the current staging directory.");
  const relative = normalized.replace(/\/+$/, "");
  if (/[:\x00-\x1f]/.test(relative)
    || (relative && relative.split("/").some(part => !part || part === "." || part === ".."))) {
    throw Error("Choose a folder inside the current staging directory.");
  }
  return relative;
}

export interface FolderEventTarget {
  label: string;
  target: string;
  context: EventNamingContext;
}

/** Native date enumeration supplies ownership; a filename resemblance cannot. */
export function folderEventTarget(root: string, clickedPath: string, days: NamingDay[]): FolderEventTarget {
  const relativePath = eventRelativePath(clickedPath), key = relativePath.toLowerCase();
  const owner = days.find(day => {
    const path = eventRelativePath(day.relativePath).toLowerCase();
    return key === path || key.startsWith(path + "/");
  });
  if (owner) {
    if (owner.warning) throw Error(owner.warning);
    const contained = key !== eventRelativePath(owner.relativePath).toLowerCase();
    const named = owner.hasCustomName || !!owner.event;
    return {
      label: `${named ? "Edit" : "Name"}${contained ? " containing" : ""} event…`,
      target: owner.relativePath,
      context: { root, relativePath, dayPath: owner.path },
    };
  }
  if ((relativePath === "" || /^\d{4}(?:\/(?:0[1-9]|1[0-2]))?$/.test(relativePath))
    && days.some(day => !relativePath || day.relativePath.toLowerCase().startsWith(key + "/"))) {
    return { label: "Name events within…", target: relativePath || "Staging", context: { root, relativePath } };
  }
  throw Error("This folder is not a recognised event date or a year/month containing event dates.");
}

/** Rebase only confirmed path segments, never similarly prefixed siblings. */
export function namedEventPath(path: string, result: EventNamingResult): string {
  const normalized = eventRelativePath(path), key = normalized.toLowerCase();
  for (const change of result.changes) {
    const from = eventRelativePath(change.from), to = eventRelativePath(change.to);
    if (!from || !to) throw Error("Event naming cannot replace the staging root.");
    if (key === from.toLowerCase() || key.startsWith(from.toLowerCase() + "/")) {
      return to + normalized.slice(from.length);
    }
  }
  return normalized;
}
