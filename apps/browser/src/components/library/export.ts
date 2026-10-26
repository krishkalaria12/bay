import { exportEaselHTML, revealFile, saveCaptureImage, shareCaptureImage, type EaselCanvasHandle } from "@bay/shell";
import { showToast } from "../layout/splitActions";
import type { EaselDocument } from "./model";

export async function writeEaselPNG(canvas: EaselCanvasHandle | null, doc: EaselDocument, windowId: string, share: boolean) {
  const image = await canvas?.export();
  if (!image) throw new Error("Try again after the images finish loading.");
  if (share) return shareCaptureImage(image.path, doc.title, windowId);
  const path = await saveCaptureImage(image.path, doc.title || "Untitled Easel");
  if (!path) throw new Error("Bay couldn't write to Downloads.");
  exported(windowId, path, "Saved a PNG to Downloads.");
}

export async function writeEaselHTML(doc: EaselDocument, windowId: string) {
  const path = await exportEaselHTML(JSON.stringify(doc));
  if (!path) throw new Error("Bay couldn't write the HTML file.");
  exported(windowId, path, "Saved a self-contained HTML file to Downloads.");
}

function exported(windowId: string, path: string, message: string) {
  showToast(windowId, "Exported Easel", message, { icon: "arrow.down.circle", action: { title: "Show in Finder", run: () => void revealFile(path) } });
}
