// The update waiting for the user (packages/shell's Updater.swift): the sidebar's Update row and the + menu show it.
//
// The app follows the updater (lib/updaterService.ts); this is where the app keeps what it heard.
import { installPendingUpdate, type PendingUpdate } from "@bay/desktop";
import { create } from "zustand";
import { APP_NAME } from "./constants";

export const usePendingUpdate = create<{ pending: PendingUpdate | null }>(() => ({ pending: null }));

/** Downloaded: install it and relaunch. Found only: Sparkle's window, to read about it and install. */
export const installUpdate = () => void installPendingUpdate();

export function updateTitle(pending: PendingUpdate) {
  if (pending.ready) return "Restart to Update";

  if (pending.downloading) return "Downloading Update…";

  return `Update ${APP_NAME}`;
}
