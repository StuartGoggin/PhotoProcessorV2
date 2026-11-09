import type { Page } from "../types";

const chapters: Record<Page, string> = {
  import: "ch-03", stagingexplorer: "ch-04", videostudio: "ch-08", videosnapshots: "ch-11",
  nameevents: "ch-03", postprocess: "ch-05", review: "ch-06", transfer: "ch-13",
  googlephotos: "ch-12", faceidentify: "ch-16", settings: "ch-02", jobs: "ch-14", cleanup: "ch-16", logs: "ch-14",
};
export const guideChapterForPage = (page: Page) => chapters[page];
export const GUIDE_SCOPE = "photogogo-guide";
export const GUIDE_EXTERNAL_LINKS = new Set([
  "https://developers.google.com/photos/library/guides/get-started-library",
  "https://developers.google.com/photos/overview/configure-your-app",
  "https://developers.google.com/identity/protocols/oauth2/#expiration",
  "https://support.google.com/youtube/answer/9884579?hl=en",
]);

/** A fixed, read-only contract with an opaque-origin sandbox. No native command forwarding. */
export function guideMessage(value: unknown): { type: "ready" | "close" | "focus-return" } | { type: "external"; url: string } | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.scope !== GUIDE_SCOPE || message.version !== 1) return null;
  if (["ready", "close", "focus-return"].includes(String(message.type)) && Object.keys(message).length === 3)
    return {type: message.type as "ready" | "close" | "focus-return"};
  if (message.type === "external" && Object.keys(message).length === 4 && typeof message.url === "string" && GUIDE_EXTERNAL_LINKS.has(message.url))
    return {type: "external", url: message.url};
  return null;
}
