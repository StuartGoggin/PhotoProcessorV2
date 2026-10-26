/** One command vocabulary for mouse controls, keyboard dispatch and help. */
export const lightboxCommands = [
  { id: "previous", label: "Previous original photo", group: "Browse", keys: ["←"], repeat: true },
  { id: "next", label: "Next original photo / skip", group: "Browse", keys: ["→"], repeat: true },
  { id: "first", label: "First photo in this folder", group: "Browse", keys: ["Home"] },
  { id: "last", label: "Last photo in this folder", group: "Browse", keys: ["End"] },
  { id: "rate-1", label: "Set one star", group: "Review", keys: ["1"] },
  { id: "rate-2", label: "Set two stars", group: "Review", keys: ["2"] },
  { id: "rate-3", label: "Set three stars", group: "Review", keys: ["3"] },
  { id: "clear-rating", label: "Clear the star rating", group: "Review", keys: ["Backspace"] },
  { id: "rate-1-next", label: "Set one star, save and next", group: "Quick review", keys: ["Shift+1"] },
  { id: "rate-2-next", label: "Set two stars, save and next", group: "Quick review", keys: ["Shift+2"] },
  { id: "rate-3-next", label: "Set three stars, save and next", group: "Quick review", keys: ["Shift+3"] },
  { id: "trash", label: "Mark / unmark trash (no file deletion)", group: "Review", keys: ["Delete"] },
  { id: "trash-next", label: "Mark trash, save and next", group: "Quick review", keys: ["X"] },
  { id: "select-original", label: "Toggle Original Google Photos selection (Cropped in cropped view)", group: "Version selections", keys: ["Q"] },
  { id: "select-bw", label: "Toggle B&W Google Photos selection", group: "Version selections", keys: ["W"] },
  { id: "select-enhanced", label: "Toggle Enhanced Google Photos selection", group: "Version selections", keys: ["E"] },
  { id: "favourite-original", label: "Toggle Original favourite (Cropped in cropped view)", group: "Version selections", keys: ["Shift+Q"] },
  { id: "favourite-bw", label: "Toggle B&W favourite", group: "Version selections", keys: ["Shift+W"] },
  { id: "favourite-enhanced", label: "Toggle Enhanced favourite", group: "Version selections", keys: ["Shift+E"] },
  { id: "panel-previous", label: "Previous available image panel", group: "Inspect", keys: ["["], repeat: true },
  { id: "panel-next", label: "Next available image panel", group: "Inspect", keys: ["]"], repeat: true },
  { id: "select-active", label: "Toggle the active panel's Google Photos selection", group: "Version selections", keys: ["A"] },
  { id: "select-active-next", label: "Select the active version, save and next", group: "Quick review", keys: ["G"] },
  { id: "zoom-in", label: "Zoom in", group: "Inspect", keys: ["+", "="], repeat: true },
  { id: "zoom-out", label: "Zoom out", group: "Inspect", keys: ["−"], repeat: true },
  { id: "fit", label: "Fit image / reset zoom and pan", group: "Inspect", keys: ["0"] },
  { id: "pan-left", label: "Pan the active zoomed image left", group: "Inspect", keys: ["Shift+←"], repeat: true },
  { id: "pan-right", label: "Pan the active zoomed image right", group: "Inspect", keys: ["Shift+→"], repeat: true },
  { id: "pan-up", label: "Pan the active zoomed image up", group: "Inspect", keys: ["Shift+↑"], repeat: true },
  { id: "pan-down", label: "Pan the active zoomed image down", group: "Inspect", keys: ["Shift+↓"], repeat: true },
  { id: "crop", label: "Open crop editor for this JPEG original", group: "Editing", keys: ["C"] },
  { id: "crop-version", label: "Switch Original / Cropped view", group: "Editing", keys: ["V"] },
  { id: "refresh", label: "Refresh photos and saved selections", group: "Browse", keys: ["R"] },
  { id: "help", label: "Keyboard & Controller Help", group: "Help", keys: ["F1", "?"] },
] as const;

export const lightboxCropCommands = [
  { id: "crop-apply", label: "Apply crop and regenerate chosen versions", group: "Crop editor", keys: ["Ctrl+Enter"] },
  { id: "crop-close", label: "Cancel / close crop editor", group: "Crop editor", keys: ["Escape"] },
  { id: "crop-reset", label: "Reset full frame", group: "Crop editor", keys: ["R"] },
  { id: "crop-orientation", label: "Switch portrait / landscape for a fixed ratio", group: "Crop editor", keys: ["V"] },
  { id: "crop-bw", label: "Toggle regeneration of cropped B&W", group: "Crop editor", keys: ["Q"] },
  { id: "crop-enhanced", label: "Toggle regeneration of cropped Enhanced", group: "Crop editor", keys: ["E"] },
  { id: "crop-nudge", label: "Move focused crop handle by one source pixel", group: "Crop editor", keys: ["Arrow keys"] },
  { id: "crop-nudge-fast", label: "Move focused crop handle by ten source pixels", group: "Crop editor", keys: ["Shift+Arrow keys"] },
  { id: "crop-focus", label: "Move between crop handles and editing controls", group: "Crop editor", keys: ["Tab", "Shift+Tab"] },
  { id: "crop-help", label: "Show crop keyboard help", group: "Crop editor", keys: ["F1", "?"] },
] as const;

export type LightboxCommandId = typeof lightboxCommands[number]["id"];
export type LightboxCommand = { id: LightboxCommandId; label: string; group: string; keys: readonly string[]; repeat?: boolean };
export function shortcutFor(id: string): string {
  return [...lightboxCommands, ...lightboxCropCommands].find(command => command.id === id)?.keys.join(" / ") ?? "";
}

/** Recognises shifted number-row keys by physical code, including !/@/#.
 * Alt/Meta/Ctrl and IME input retain their normal app/OS behaviour. */
export function matchLightboxCommand(event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "isComposing">): LightboxCommand | undefined {
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return undefined;
  let key = event.key;
  if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(-1);
  else if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
  const names: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", "-": "−" };
  key = names[key] ?? key;
  const shifted = event.shiftKey && key !== "+" && key !== "?";
  const binding = `${shifted ? "Shift+" : ""}${key}`;
  return lightboxCommands.find(command => (command.keys as readonly string[]).includes(binding));
}

export function lightboxTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return true;
  const input = target.closest("input");
  return input instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "reset"].includes(input.type);
}

export function matchLightboxCropCommand(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "isComposing" | "repeat">): typeof lightboxCropCommands[number]["id"] | undefined {
  if (event.metaKey || event.altKey || event.isComposing || event.repeat) return undefined;
  if (event.ctrlKey) return event.key === "Enter" && !event.shiftKey ? "crop-apply" : undefined;
  if (event.shiftKey && event.key !== "?") return undefined;
  const key = /^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : event.key;
  return lightboxCropCommands.find(command => (command.keys as readonly string[]).includes(key))?.id;
}
