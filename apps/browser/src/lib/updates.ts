import { installPendingUpdate, onUpdatePending, updaterState, type PendingUpdate } from "@bay/shell";
import { create } from "zustand";
import { APP_NAME } from "./constants";

// The update waiting for the user (packages/shell's Updater.swift): the sidebar's Update row and the + menu show it.

export const usePendingUpdate = create<{ pending: PendingUpdate | null }>(() => ({ pending: null }));

let watching = false;

/** Follows the updater from the first sidebar on. */
export function watchPendingUpdate() {
  if (watching) return;
  watching = true;
  onUpdatePending((pending) => usePendingUpdate.setState({ pending }));
  void updaterState().then(
    (state) => {
      if (state.available) usePendingUpdate.setState({ pending: state.pending ?? null });
    },
    () => {},
  );
}

/** Downloaded: install it and relaunch. Found only: Sparkle's window, to read about it and install. */
export const installUpdate = () => void installPendingUpdate();

export function updateTitle(pending: PendingUpdate) {
  if (pending.ready) return "Restart to Update";
  if (pending.downloading) return "Downloading Update…";
  return `Update ${APP_NAME}`;
}
