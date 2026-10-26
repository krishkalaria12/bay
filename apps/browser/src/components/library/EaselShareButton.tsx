import { confirm, copyText, sharePage, showMenu, type EaselCanvasHandle } from "@bay/shell";
import { useEffect, type RefObject } from "react";
import { useBrowser } from "../../store/browser";
import { showToast } from "../layout/splitActions";
import { Button } from "../settings/controls";
import type { EaselDocument } from "./model";
import { easelShareURL, publishEasel, startEaselShares, stopSharingEasel, useEaselShares } from "./sharing";

export function EaselShareButton({ doc, canvas, windowId }: { doc: EaselDocument; canvas: RefObject<EaselCanvasHandle | null>; windowId: string }) {
  const publication = useEaselShares((s) => s.records[doc.id]);
  const busy = useEaselShares((s) => !!s.busy[doc.id]);
  useEffect(startEaselShares, []);
  return (
    <Button
      title={busy ? "Sharing…" : publication ? "Shared Easel…" : "Share Easel…"}
      disabled={busy}
      onPress={() => void openEaselSharing(doc, canvas, windowId)}
    />
  );
}

async function openEaselSharing(doc: EaselDocument, canvas: RefObject<EaselCanvasHandle | null>, windowId: string) {
  const publish = async () => {
    const url = await publishEasel(doc.id, async () => {
      if (!canvas.current) throw new Error("The Easel is still loading. Try again.");
      return canvas.current.prepareShare(doc.title);
    });
    copyText(url);
    showToast(windowId, "Easel Link Copied", "Anyone with the link can view this snapshot in a browser.", { icon: "link" });
  };
  try {
    startEaselShares();
    const state = useEaselShares.getState();
    if (state.error) {
      showToast(windowId, "Couldn't Share Easel", state.error, { icon: "link" });
      return;
    }
    const current = state.records[doc.id];
    if (!current) {
      const { confirmed } = await confirm({
        title: "Share this Easel on the web?",
        message:
          "Anyone with the link can view the canvas and its source links. Live captures become still images. Edits stay private until you update the shared page. You can stop sharing at any time.",
        confirmTitle: "Publish and Copy Link",
        windowId,
      });
      if (confirmed) await publish();
      return;
    }
    const choice = await showMenu([
      { id: "copy", title: "Copy Easel Link", enabled: current.publishedAt !== null },
      { id: "open", title: "Open Shared Page", enabled: current.publishedAt !== null },
      { id: "share", title: "Share Link Via…", enabled: current.publishedAt !== null },
      { separator: true },
      { id: "update", title: current.publishedAt === null ? "Retry Publishing and Copy Link" : "Update Shared Page and Copy Link" },
      { id: "stop", title: "Stop Sharing…" },
    ]);
    const url = easelShareURL(current.id);
    if (choice === "copy") {
      copyText(url);
      showToast(windowId, "Easel Link Copied", undefined, { icon: "link" });
    }
    if (choice === "open") useBrowser.getState().newTab(windowId, { url });
    if (choice === "share") await sharePage(url, doc.title, windowId);
    if (choice === "update") await publish();
    if (choice === "stop") {
      const { confirmed } = await confirm({
        title: "Stop sharing this Easel?",
        message: "The shared link will stop working. Your Easel stays in Library. Copies people have already saved cannot be removed.",
        confirmTitle: "Stop Sharing",
        destructive: true,
        windowId,
      });
      if (!confirmed) return;
      await stopSharingEasel(doc.id);
      showToast(windowId, "Easel Sharing Stopped", "The shared link no longer opens this Easel.", { icon: "link" });
    }
  } catch (error) {
    showToast(windowId, "Couldn't Share Easel", error instanceof Error ? error.message : String(error), { icon: "link" });
  }
}
