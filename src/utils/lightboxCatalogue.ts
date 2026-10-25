import type { TreeNode } from "../types";

export interface LightboxPhoto { node: TreeNode; original: TreeNode; bw?: TreeNode; improved?: TreeNode }
const PHOTO = /\.(jpe?g|png|cr3|dng)$/i;
const JPEG = /\.jpe?g$/i;
const TAGS = /\{(?:Like o{1,3}|trash|Out of Focus \d+)\}/gi;
const stem = (name: string) => name.replace(/\.[^.]+$/, "");
const untag = (name: string) => name.replace(TAGS, "");
const key = (name: string) => name.toLowerCase();

/** A single conservative catalogue drives the tree and folder-local navigation.
 * A suffix alone is not proof: orphan variants stay visible; no files change. */
export function lightboxCatalogue(nodes: TreeNode[]): { tree: TreeNode[]; photos: Map<string, LightboxPhoto>; folders: Map<string, LightboxPhoto[]> } {
  const photos = new Map<string, LightboxPhoto>();
  const folders = new Map<string, LightboxPhoto[]>();
  function visit(children: TreeNode[], parent: string): TreeNode[] {
    const files = children.filter(node => node.type === "file" && PHOTO.test(node.name));
    const sourcesByStem = new Map<string, TreeNode[]>();
    for (const file of files) {
      const sourceKey = key(untag(stem(file.name)));
      const group = sourcesByStem.get(sourceKey) ?? [];
      group.push(file); sourcesByStem.set(sourceKey, group);
    }
    const variants = new Map<string, { source: TreeNode; kind: "bw" | "improved" }>();
    for (const file of files) {
      if (!JPEG.test(file.name)) continue;
      const clean = untag(stem(file.name));
      const match = clean.match(/_(bw|improved)$/i);
      if (!match) continue;
      const candidates = sourcesByStem.get(key(clean.slice(0, -match[0].length))) ?? [];
      const rawBase = stem(file.name).replace(/_(bw|improved)(?=(?:\{[^}]+\})*$)/i, "");
      const exact = candidates.filter(other => key(stem(other.name)) === key(rawBase));
      const preferred = exact.length ? exact : candidates;
      // Photo Process produces these variants from JPEGs, not same-stem RAWs.
      const jpegSources = preferred.filter(other => JPEG.test(other.name));
      const sources = jpegSources.length === 1 ? jpegSources : preferred;
      if (sources.length === 1) variants.set(file.path, { source: sources[0], kind: match[1].toLowerCase() as "bw" | "improved" });
    }
    const entries = files.filter(file => !variants.has(file.path)).map(node => ({ node, original: node } as LightboxPhoto));
    const comparisons = new Map<string, { bw: TreeNode[]; improved: TreeNode[] }>();
    for (const file of files) {
      const variant = variants.get(file.path);
      if (!variant) continue;
      const group = comparisons.get(variant.source.path) ?? { bw: [], improved: [] };
      group[variant.kind].push(file); comparisons.set(variant.source.path, group);
    }
    for (const entry of entries) {
      for (const kind of ["bw", "improved"] as const) {
        const matches = comparisons.get(entry.node.path)?.[kind] ?? [];
        if (matches.length === 1) entry[kind] = matches[0];
      }
      photos.set(entry.node.path, entry);
    }
    folders.set(parent, entries);
    return children.flatMap(node => node.type === "dir"
      ? [{ ...node, children: visit(node.children ?? [], node.path) }]
      : photos.has(node.path) ? [node] : []);
  }
  return { tree: visit(nodes, ""), photos, folders };
}

export function photoFolder(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
}
export function photoPaths(photo: LightboxPhoto): string[] {
  return [photo.original, photo.bw, photo.improved].filter((node): node is TreeNode => !!node).map(node => node.path);
}
export function neighborPaths(photos: LightboxPhoto[], index: number, direction: 1 | -1): string[] {
  const neighbors = [index + direction, index - direction, index + direction * 2].map(at => photos[at]).filter((photo): photo is LightboxPhoto => !!photo);
  return [...neighbors.map(photo => photo.original.path), ...neighbors.flatMap(photo => photoPaths(photo).slice(1))];
}
export function lightboxAbsolute(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${relative.replace(/\\/g, "/")}`;
}
