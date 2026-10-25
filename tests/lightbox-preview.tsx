// Development-only fixture: real Lightbox UI, synthetic photos and native IPC.
// No local photos, directories or native file operations are accessed.
import React from "react";
import { createRoot } from "react-dom/client";
import Review from "../src/pages/Review";
import type { TreeNode } from "../src/types";
import "../src/styles.css";

const fixture = window as any;
const file = (name: string, parent = ""): TreeNode => ({ name, path: parent ? `${parent}/${name}` : name, type: "file", size: 32768 });
fixture.__lightboxTree = {
  name: "Synthetic photos", path: "", type: "dir", children: [
    file("01-rider.jpg"), file("01-rider_improved.jpg"), file("01-rider_BW.jpg"),
    file("02-arena.CR3"), file("02-arena_improved.jpg"), file("02-arena_BW.jpg"),
    file("03-wide{Like oo}.PNG"), file("03-wide_improved.jpg"), file("03-wide_BW{trash}.jpg"),
    // These are genuine independently named originals: there is no source sibling.
    file("04-genuine_BW.jpg"), file("05-course_improved.jpg"),
    file("notes.txt"), file("camera.mp4"),
    { name: "Session", path: "Session", type: "dir", children: [
      file("10-close.jpeg", "Session"), file("10-close_improved.jpg", "Session"), file("10-close_BW.jpg", "Session"),
      file("11-pan.jpg", "Session"), file("11-pan_improved.jpg", "Session"),
    ] },
  ],
} satisfies TreeNode;
fixture.__lightboxReads = [];
fixture.__lightboxPending = [];
fixture.__lightboxRenames = [];
fixture.__lightboxTreeReads = 0;
fixture.__lightboxGeneration = 0;
fixture.__lightboxCropRequests = [];
fixture.__lightboxCropInfoReads = 0;
fixture.__lightboxCropFingerprint ??= "synthetic-original-v1";
fixture.__lightboxPayloads = new Map<string, { path: string; generation: number }>();
fixture.__lightboxRevokedUrls = [];
const nativeRevoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => { fixture.__lightboxRevokedUrls.push(url); nativeRevoke(url); };

function image(path: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 480;
  const context = canvas.getContext("2d")!;
  const seed = Array.from(path).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  context.fillStyle = `hsl(${seed % 360} 35% 25%)`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f5d889"; context.font = "18px sans-serif";
  context.fillText(path.split("\\").pop()!, 16, 55, 610);
  context.fillText(`Synthetic revision ${fixture.__lightboxGeneration}`, 16, 90);
  const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  fixture.__lightboxPayloads.set(data, { path, generation: fixture.__lightboxGeneration });
  return { data, mime: "image/jpeg", width: 640, height: 480 };
}

function allFiles(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => node.type === "file" ? [node] : allFiles(node.children ?? []));
}

fixture.__lightboxRelease = (match: string) => {
  const matches = fixture.__lightboxPending.filter((pending: any) => pending.path.includes(match));
  fixture.__lightboxPending = fixture.__lightboxPending.filter((pending: any) => !pending.path.includes(match));
  for (const pending of matches) pending.resolve(pending.value);
  return matches.length;
};
fixture.__lightboxReleaseAll = () => fixture.__lightboxRelease("");
fixture.__TAURI_INTERNALS__ = {
  convertFileSrc: () => "",
  invoke: async (command: string, args: any) => {
    if (command === "load_settings") return { staging_dir: "D:\\Synthetic photos", source_root: "", archive_dir: "", exiftool_dir: "" };
    if (command === "list_staging_tree") {
      fixture.__lightboxTreeReads++;
      return structuredClone(fixture.__lightboxTree);
    }
    if (command === "lightbox_crop_info") {
      fixture.__lightboxCropInfoReads++;
      const value = { width: 640, height: 480, sourceFingerprint: fixture.__lightboxCropFingerprint, original: `data:image/jpeg;base64,${image(`D:\\Synthetic photos\\${String(args.path).replace(/\//g, "\\")}`).data}`,
        crop: fixture.__lightboxLastCrop ?? null, hasCrop: !!fixture.__lightboxLastCrop };
      if (fixture.__lightboxDeferCropInfo) return new Promise(resolve => { fixture.__lightboxResolveCropInfo = () => resolve(value); });
      return value;
    }
    if (command === "lightbox_apply_crop") {
      const request = structuredClone(args.request);
      fixture.__lightboxCropRequests.push(request);
      if (fixture.__lightboxCropError) throw new Error(fixture.__lightboxCropError);
      if (request.sourceFingerprint !== fixture.__lightboxCropFingerprint) throw new Error("The original has changed. Reload the original and try again.");
      if (fixture.__lightboxDeferCrop) await new Promise<void>((resolve) => { fixture.__lightboxResolveCrop = resolve; });
      const original = allFiles(fixture.__lightboxTree.children).find(node => node.path === request.path)!;
      const parent = original.path.includes("/") ? original.path.slice(0, original.path.lastIndexOf("/") + 1) : "";
      const stem = original.name.replace(/\.[^.]+$/, "").replace(/\{(?:Like o{1,3}|trash|Out of Focus \d+)\}/gi, "");
      const siblings = parent ? fixture.__lightboxTree.children.find((node: TreeNode) => node.path === parent.slice(0, -1)).children : fixture.__lightboxTree.children;
      const names = [`${stem}_crop.jpg`, ...(request.regenerateBw ? [`${stem}_crop_BW.jpg`] : []), ...(request.regenerateEnhanced ? [`${stem}_crop_improved.jpg`] : [])];
      for (const name of names) if (!siblings.some((node: TreeNode) => node.name === name)) siblings.push(file(name, parent.replace(/\/$/, "")));
      fixture.__lightboxLastCrop = request.crop;
      fixture.__lightboxGeneration++;
      return { cropPath: `D:\\Synthetic photos\\${parent}${names[0]}`, width: Math.min(640, Math.ceil(640 * (request.crop.x + request.crop.width))) - Math.floor(640 * request.crop.x), height: Math.min(480, Math.ceil(480 * (request.crop.y + request.crop.height))) - Math.floor(480 * request.crop.y), outputs: names.slice(1), errors: fixture.__lightboxCropWarnings ?? [] };
    }
    if (command === "read_lightbox_image" || command === "read_image_base64") {
      const path = String(args.path).replace(/\//g, "\\");
      const relativePath = path.replace(/^D:\\Synthetic photos\\/i, "").replace(/\\/g, "/");
      fixture.__lightboxReads.push({ id: fixture.__lightboxReads.length + 1, command, path, generation: fixture.__lightboxGeneration });
      if (!allFiles(fixture.__lightboxTree.children).some((node) => node.path.toLowerCase() === relativePath.toLowerCase())) {
        throw new Error("Synthetic image does not exist");
      }
      if ((fixture.__lightboxFailures ?? []).some((match: string) => path.includes(match))) throw new Error("Synthetic read failure");
      const value = image(path);
      if ((fixture.__lightboxHold ?? []).some((match: string) => path.includes(match))) {
        return new Promise((resolve) => fixture.__lightboxPending.push({ path, value: command === "read_image_base64" ? value.data : value, resolve }));
      }
      if (fixture.__lightboxDelay) await new Promise((resolve) => setTimeout(resolve, fixture.__lightboxDelay));
      return command === "read_image_base64" ? value.data : value;
    }
    if (command === "rename_file") {
      fixture.__lightboxRenames.push(args);
      if (fixture.__lightboxDeferRename) await new Promise<void>((resolve) => { fixture.__lightboxResolveRename = resolve; });
      const relativePath = String(args.oldPath).replace(/\//g, "\\").replace(/^D:\\Synthetic photos\\/i, "").replace(/\\/g, "/");
      const node = allFiles(fixture.__lightboxTree.children).find((entry) => entry.path === relativePath);
      if (!node) throw new Error("Cannot rename missing synthetic photo");
      const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/") + 1) : "";
      node.name = args.newName; node.path = parent + args.newName;
      return null;
    }
    throw new Error(`Unexpected Lightbox fixture command: ${command}`);
  },
};

document.documentElement.style.height = "100%";
document.body.style.height = "100%";
document.getElementById("root")!.style.height = "100%";
const root = createRoot(document.getElementById("root")!);
fixture.__lightboxUnmount = () => root.unmount();
root.render(<React.StrictMode><Review /></React.StrictMode>);
