import type { TreeNode } from "../types";

export interface LightboxPhoto { node: TreeNode; original: TreeNode; bw?: TreeNode; improved?: TreeNode; crop?: LightboxPhoto; cameraJpeg?: TreeNode; cameraPhoto?: LightboxPhoto; improvedLabel?: string }
export type OriginalSource = "raw" | "cameraJpeg";
const PHOTO = /\.(jpe?g|png|cr3|dng)$/i;
const JPEG = /\.jpe?g$/i;
const TAGS = /\{(?:Like o{1,3}|trash|Out of Focus \d+)\}/gi;
const stem = (name: string) => name.replace(/\.[^.]+$/, "");
const untag = (name: string) => name.replace(TAGS, "");
const key = (name: string) => name.toLowerCase();
const pathKey = (path: string) => path.replace(/\\/g, "/").toLowerCase();
const RAW = /\.(cr3|dng)$/i;

/** A single conservative catalogue drives the tree and folder-local navigation.
 * A suffix alone is not proof: orphan variants stay visible; no files change. */
export function lightboxCatalogue(nodes: TreeNode[]): { tree: TreeNode[]; photos: Map<string, LightboxPhoto>; folders: Map<string, LightboxPhoto[]> } {
  const photos = new Map<string, LightboxPhoto>();
  const folders = new Map<string, LightboxPhoto[]>();
  function visit(children: TreeNode[], parent: string): TreeNode[] {
    const files = children.filter(node => node.type === "file" && PHOTO.test(node.name));
    const byPath = new Map<string, TreeNode[]>();
    for (const file of files) { const group = byPath.get(pathKey(file.path)) ?? []; group.push(file); byPath.set(pathKey(file.path), group); }
    const retired = new Set<string>();
    const owned = new Map<string, { source: TreeNode; kind: "bw" | "improved"; files: TreeNode[] }>();
    for (const file of files) {
      if (!JPEG.test(file.name) || !file.rawSource || !file.rawKind) continue;
      const owners = byPath.get(pathKey(file.rawSource)) ?? [];
      if (owners.length !== 1 || !RAW.test(owners[0].name) || pathKey(photoFolder(file.path)) !== pathKey(photoFolder(owners[0].path))) continue;
      if (file.rawKind === "retired") { retired.add(file.path); continue; }
      const kind = file.rawKind === "developed" ? "improved" : file.rawKind === "bw" ? "bw" : null;
      if (!kind) continue;
      const id = `${pathKey(owners[0].path)}|${kind}`;
      const group = owned.get(id) ?? { source: owners[0], kind, files: [] };
      group.files.push(file); owned.set(id, group);
    }
    const sourcesByStem = new Map<string, TreeNode[]>();
    for (const file of files) {
      if (file.rawSource || file.rawKind || retired.has(file.path)) continue;
      const sourceKey = key(untag(stem(file.name)));
      const group = sourcesByStem.get(sourceKey) ?? [];
      group.push(file); sourcesByStem.set(sourceKey, group);
    }
    const variants = new Map<string, { source: TreeNode; kind: "bw" | "improved" }>();
    for (const group of owned.values()) if (group.files.length === 1) variants.set(group.files[0].path, { source: group.source, kind: group.kind });
    for (const file of files) {
      if (!JPEG.test(file.name) || file.rawSource || file.rawKind || retired.has(file.path)) continue;
      const clean = untag(stem(file.name));
      const match = clean.match(/_(bw|improved)$/i);
      if (!match) continue;
      const candidates = sourcesByStem.get(key(clean.slice(0, -match[0].length))) ?? [];
      const rawBase = stem(file.name).replace(/_(bw|improved)(?=(?:\{[^}]+\})*$)/i, "");
      const exact = candidates.filter(other => key(stem(other.name)) === key(rawBase));
      const preferred = exact.length ? exact : candidates;
      // Photo Process produces these variants from JPEGs, not same-stem RAWs.
      // An untagged RAW exact match must not steal versions belonging to its
      // uniquely identifiable rated JPEG sibling. Still never guess between
      // several JPEG originals after stripping review tags.
      const exactJpegs = exact.filter(other => JPEG.test(other.name));
      const allJpegs = candidates.filter(other => JPEG.test(other.name));
      const sources = exactJpegs.length ? exactJpegs : allJpegs.length ? allJpegs : preferred.filter(other => !RAW.test(other.name));
      if (sources.length === 1) variants.set(file.path, { source: sources[0], kind: match[1].toLowerCase() as "bw" | "improved" });
    }
    const entries = files.filter(file => !variants.has(file.path) && !retired.has(file.path)).map(node => ({ node, original: node } as LightboxPhoto));
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
        const exact = matches.filter(file => key(stem(file.name).replace(/_(bw|improved)(?=(?:\{[^}]+\})*$)/i, "")) === key(stem(entry.node.name)));
        const preferred = exact.length ? exact : matches;
        if (preferred.length === 1) { entry[kind] = preferred[0]; if (kind === "improved" && preferred[0].rawKind === "developed") entry.improvedLabel = "Developed RAW"; }
      }
    }
    // A crop is a separate working image but belongs to one original navigation
    // entry. Never guess ownership for orphan names or ambiguous same-stem files.
    const cropGroups = new Map<string, LightboxPhoto[]>();
    for (const entry of entries) {
      const clean = untag(stem(entry.node.name));
      if (!JPEG.test(entry.node.name) || !/_crop$/i.test(clean)) continue;
      const base = clean.replace(/_crop$/i, "");
      if (/_crop$/i.test(base)) continue; // Never fold a crop-of-a-crop chain.
      const rawBase = stem(entry.node.name).replace(/_crop(?=(?:\{[^}]+\})*$)/i, "");
      const candidates = entries.filter(other => other !== entry && JPEG.test(other.node.name) && key(untag(stem(other.node.name))) === key(base));
      const exact = candidates.filter(other => key(stem(other.node.name)) === key(rawBase));
      const owners = exact.length ? exact : candidates;
      if (owners.length !== 1) continue;
      const group = cropGroups.get(owners[0].node.path) ?? [];
      group.push(entry); cropGroups.set(owners[0].node.path, group);
    }
    const hiddenCrops = new Set<string>();
    for (const entry of entries) {
      const crops = cropGroups.get(entry.node.path) ?? [];
      if (crops.length === 1) { entry.crop = crops[0]; hiddenCrops.add(crops[0].node.path); }
    }
    const hiddenCompanions = new Set<string>();
    const companionClaims = new Map<string, LightboxPhoto[]>();
    for (const entry of entries) {
      if (!RAW.test(entry.node.name) || !entry.node.cameraJpeg) continue;
      const id = pathKey(entry.node.cameraJpeg);
      const claims = companionClaims.get(id) ?? []; claims.push(entry); companionClaims.set(id, claims);
    }
    for (const entry of entries) {
      if (!RAW.test(entry.node.name) || !entry.node.cameraJpeg) continue;
      if ((byPath.get(pathKey(entry.node.path))?.length ?? 0) !== 1 || companionClaims.get(pathKey(entry.node.cameraJpeg))?.length !== 1) continue;
      const peers = entries.filter(other => pathKey(other.node.path) === pathKey(entry.node.cameraJpeg!));
      if (peers.length !== 1 || !JPEG.test(peers[0].node.name) || peers[0].node.rawSource || peers[0].node.rawKind || hiddenCrops.has(peers[0].node.path)) continue;
      // Native cameraJpeg is capture-metadata proof, not a basename hint. A
      // renamed companion remains valid; competing reverse claims do not.
      if (pathKey(photoFolder(entry.node.path)) !== pathKey(photoFolder(peers[0].node.path))) continue;
      entry.cameraJpeg = peers[0].node; entry.cameraPhoto = peers[0]; hiddenCompanions.add(peers[0].node.path);
    }
    const originals = entries.filter(entry => !hiddenCrops.has(entry.node.path) && !hiddenCompanions.has(entry.node.path));
    for (const entry of originals) photos.set(entry.node.path, entry);
    folders.set(parent, originals);
    return children.flatMap(node => node.type === "dir"
      ? [{ ...node, children: visit(node.children ?? [], node.path) }]
      : photos.has(node.path) ? [node] : []);
  }
  return { tree: visit(nodes, ""), photos, folders };
}

/** Keep the capture's navigation identity while resolving every visible version
 * to the chosen original source. JPEG comparisons never borrow RAW lineage. */
export function photoForSource(photo: LightboxPhoto, source: OriginalSource): LightboxPhoto {
  if (source !== "cameraJpeg" || !photo.cameraJpeg || !photo.cameraPhoto) return photo;
  return { ...photo, original: photo.cameraJpeg, bw: photo.cameraPhoto.bw, improved: photo.cameraPhoto.improved, crop: photo.cameraPhoto.crop, improvedLabel: undefined };
}

export function photoFolder(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
}
export function photoPaths(photo: LightboxPhoto, cropped = false): string[] {
  const version = cropped && photo.crop ? photo.crop : photo;
  return [version.original, version.bw, version.improved].filter((node): node is TreeNode => !!node).map(node => node.path);
}
export function neighborPaths(photos: LightboxPhoto[], index: number, direction: 1 | -1): string[] {
  const neighbors = [index + direction, index - direction, index + direction * 2].map(at => photos[at]).filter((photo): photo is LightboxPhoto => !!photo);
  return [...neighbors.map(photo => photo.original.path), ...neighbors.flatMap(photo => photoPaths(photo).slice(1))];
}
export function lightboxAbsolute(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${relative.replace(/\\/g, "/")}`;
}
