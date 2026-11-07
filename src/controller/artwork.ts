import type { ControllerKey } from "./types";

const paths: Record<string, string> = {
  star: "M12 1.5 15 8l7 .9-5.1 5 1.3 7.1L12 17.5 5.8 21l1.3-7.1L2 8.9 9 8Z",
  next: "m8 4 8 8-8 8M20 4v16", previous: "m16 4-8 8 8 8M4 4v16",
  back: "m10 5-7 7 7 7M4 12h17", check: "m3 12 6 6L21 5",
  trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7",
  heart: "M12 21 3.8 13C-2 7 5 0 12 7c7-7 14 0 8.2 6Z",
  crop: "M6 2v16h16M2 6h16v16M3 3l18 18", zoom: "M16 16l6 6M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0M6 10h8m-4-4v8",
  photo: "M2 4h20v16H2ZM2 17l6-6 5 5 4-3 5 5M17 8h.01",
  original: "M2 4h20v16H2ZM2 17l6-6 5 5 4-3 5 5M17 8h.01",
  capture: "M3 6h4l2-3h6l2 3h4v15H3ZM17 13a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
  play: "m7 3 14 9-14 9Z", pause: "M7 3v18M17 3v18",
  sun: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M20 4l-2 2M6 18l-2 2",
  contrast: "M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 0v20m0-17 5 2m-5 1 8 3m-8 1 8 3m-8 1 5 2",
  color: "M12 2C8 8 5 10 5 15a7 7 0 0 0 14 0c0-5-3-7-7-13ZM9 15v.1",
  reset: "M3 10a9 9 0 1 1 2 9M3 3v7h7", menu: "M3 5h18M3 12h18M3 19h18",
  jobs: "M4 5h16v16H4ZM8 2v6m8-6v6M8 12h8m-8 5h5",
  help: "M8 8a4 4 0 1 1 6 3.5c-2 1-2 2-2 3M12 19h.01",
  folder: "M2 5h8l2 3h10v13H2Z", off: "M12 2v10M6 5a9 9 0 1 0 12 0",
  save: "M3 3h15l3 3v15H3ZM7 3v6h10V3M7 21v-8h10v8",
  bw: "M12 2a10 10 0 1 1 0 20V2Zm0 0a10 10 0 0 0 0 20",
  enhanced: "m12 1 2.5 8.5L23 12l-8.5 2.5L12 23l-2.5-8.5L1 12l8.5-2.5Z",
  pan: "M12 2v20M2 12h20M8 6l4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4",
};

function appearance(key: ControllerKey) {
  const accent = !key.enabled ? "#64748b" : key.status === "error" ? "#fb7185" : key.status === "saving" ? "#fbbf24" : key.active ? "#e5c478" : "#67e8f9";
  const words = key.label.trim().split(/\s+/), lines: string[] = [];
  for (const word of words) {
    const last = lines.length - 1;
    if (last >= 0 && (lines[last] + " " + word).length <= 12) lines[last] += " " + word;
    else if (lines.length < 2) lines.push(word.slice(0, 12));
  }
  return { accent, lines, detail: key.status === "saving" ? "SAVING" : key.status === "error" ? "RETRY" : key.detail?.slice(0, 12) || (key.status === "saved" ? "SAVED" : ""), path: paths[key.icon || ""] || paths[key.id.split("-")[0]] || paths.menu };
}

const xml = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));

/** Vector artwork for the mirror; generated from the same geometry as hardware JPEGs. */
export function controllerKeySvg(key: ControllerKey): string {
  const { accent, lines, detail, path } = appearance(key);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60"><rect width="60" height="60" rx="7" fill="#101a2b"/><rect x="1" y="1" width="58" height="58" rx="6" fill="none" stroke="${key.active ? accent : "#293850"}" stroke-width="${key.active ? 2 : 1}"/><path d="M8 4h44" stroke="${accent}" opacity=".6"/><g transform="translate(19 7) scale(.92)" fill="none" stroke="${accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></g>${lines.map((line, i) => `<text x="30" y="${38 + i * 9}" fill="${key.enabled ? "#f8fafc" : "#94a3b8"}" font-family="Segoe UI,Arial,sans-serif" font-size="8" font-weight="600" text-anchor="middle">${xml(line)}</text>`).join("")}${detail ? `<text x="30" y="56" fill="${accent}" font-family="Segoe UI,Arial,sans-serif" font-size="5.5" font-weight="600" letter-spacing=".5" text-anchor="middle">${xml(detail)}</text>` : ""}</svg>`;
}

export function controllerKeyPreview(key: ControllerKey): string { return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(controllerKeySvg(key)); }

/** A 60px high-contrast frame; no remote images, fonts, paths or media enter the device. */
export function controllerKeyJpeg(key: ControllerKey): string {
  const { accent, lines, detail, path } = appearance(key);
  const canvas = document.createElement("canvas"); canvas.width = 60; canvas.height = 60;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Controller artwork could not be drawn.");
  context.fillStyle = "#101a2b"; context.fillRect(0, 0, 60, 60);
  context.strokeStyle = key.active ? accent : "#293850"; context.lineWidth = key.active ? 2 : 1; context.strokeRect(1, 1, 58, 58);
  context.strokeStyle = accent; context.globalAlpha = .6; context.beginPath(); context.moveTo(8, 4); context.lineTo(52, 4); context.stroke(); context.globalAlpha = 1;
  context.save(); context.translate(19, 7); context.scale(.92, .92); context.strokeStyle = accent; context.lineWidth = 1.8; context.lineCap = "round"; context.lineJoin = "round"; context.stroke(new Path2D(path)); context.restore();
  context.textAlign = "center"; context.fillStyle = key.enabled ? "#f8fafc" : "#94a3b8"; context.font = "600 8px Segoe UI, Arial, sans-serif";
  lines.forEach((line, i) => context.fillText(line, 30, 38 + i * 9, 54));
  if (detail) { context.font = "600 5.5px Segoe UI, Arial, sans-serif"; context.fillStyle = accent; context.fillText(detail, 30, 56, 54); }
  return canvas.toDataURL("image/jpeg", .9);
}
