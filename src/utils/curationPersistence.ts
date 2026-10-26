import { invoke } from "@tauri-apps/api/core";
import { CurationWriteQueue, type CurationReceipt } from "./curationWriteQueue";

/** One in-memory writer shared by Review and its publishing/archive consumers. */
export const curationWriter = new CurationWriteQueue(request => invoke<CurationReceipt>("google_photos_update_selection", { ...request }));
export async function settleCuration(root: string) {
  await curationWriter.settled();
  const error = curationWriter.error(root);
  if (error) throw Error(`${error} Return to Photo Lightbox to retry the checkbox or reload its saved selections before preparing a transfer.`);
}
