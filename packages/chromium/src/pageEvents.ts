import { Cef } from "./native";

// Browser-owned page facts are delivered only to the coordinator. Subscribe
// before starting: Chrome replays current facts, including parked pages.
export const onPageEvent = (listener: (event: unknown) => void) => Cef.addListener("onPageEvent", listener);
export const onPageOpen = (listener: (event: unknown) => void) => Cef.addListener("onPageOpen", listener);

export function finishPageOpen(offerId: string, tabId: string | null): Promise<void> {
  if (!Cef.finishPageOpen) return Promise.reject(new Error("Native page handoff is not supported by this host"));
  return Cef.finishPageOpen(offerId, tabId);
}

export function startPageEvents(): Promise<void> {
  if (!Cef.startPageEvents || !Cef.stopPageEvents) return Promise.reject(new Error("Coordinator page events are not supported by this host"));
  return Cef.startPageEvents();
}

export function stopPageEvents(): Promise<void> {
  return Cef.stopPageEvents?.() ?? Promise.resolve();
}
