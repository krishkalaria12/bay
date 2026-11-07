import { hostOf } from "@bay/core/src/input.ts";
import { addMediaControlListener, runPageScript, setMediaSession, type MediaControl, type Tab } from "@bay/engine";
import { useEffect, useRef, useState } from "react";

import { parseMediaMessage, PAUSE_MEDIA_SCRIPT, PIP_MEDIA_SCRIPT, seekMediaScript, TOGGLE_MEDIA_SCRIPT, type MediaMessage } from "@/pagescripts/media";
import type { BrowserTab } from "@/store/types";

type Reports = Record<string, MediaMessage & { at: number }>;

export interface TabMediaOptions {
  tabs: readonly BrowserTab[];
  views: ReadonlyMap<string, Tab>;
  /** The tab on screen, whose own controls are in view; it gets no mini player. */
  onScreenTabId: string | null;
  /** Private tabs are locked: their media stays out of the mini player. */
  locked: boolean;
}

/**
 * Media playing in each tab, as its page reports it (pagescripts/media.ts): the mini player for a tab that's off screen,
 * and the system's media controls (Android's media notification) for the latest media outside private tabs.
 */
export function useTabMedia({ tabs, views, onScreenTabId, locked }: TabMediaOptions) {
  const [reports, setReports] = useState<Reports>({});
  // Tabs stopped from the mini player or the system's controls: the pause report that follows stays out.
  const [stopped] = useState(() => new Set<string>());

  const tabFor = (id: string | undefined) => (id ? tabs.find((tab) => tab.id === id) : undefined);
  const latest = (ids: string[]) => tabFor(ids.sort((a, b) => Number(reports[b]!.playing) - Number(reports[a]!.playing) || reports[b]!.at - reports[a]!.at)[0]);
  const ids = Object.keys(reports);
  const playerTab = latest(ids.filter((id) => id !== onScreenTabId && !(locked && tabFor(id)?.private)));
  const sessionTab = latest(ids.filter((id) => !tabFor(id)?.private));

  function forget(tabId: string): void {
    setReports((previous) => (previous[tabId] ? withoutKey(previous, tabId) : previous));
  }

  function command(tabId: string, source: string): void {
    const view = views.get(tabId);

    if (!view) return;
    // Resolves null when the page's media is gone.
    runPageScript<boolean | null>(view, source).then(
      (playing) => playing === null && forget(tabId),
      () => {},
    );
  }

  function stop(tabId: string): void {
    stopped.add(tabId);
    command(tabId, PAUSE_MEDIA_SCRIPT);
    forget(tabId);
  }

  const sessionTitle = sessionTab ? reports[sessionTab.id]!.title || sessionTab.title : null;
  const sessionSite = sessionTab ? hostOf(sessionTab.url) : "";
  const sessionPlaying = sessionTab ? reports[sessionTab.id]!.playing : false;
  useEffect(() => {
    setMediaSession(sessionTitle === null ? null : { title: sessionTitle, site: sessionSite, playing: sessionPlaying });
  }, [sessionTitle, sessionSite, sessionPlaying]);

  const control = useRef<(action: MediaControl) => void>(() => {});
  control.current = (action) => {
    if (!sessionTab) return;

    if (action === "toggle") command(sessionTab.id, TOGGLE_MEDIA_SCRIPT);
    else if (action === "skip-forward" || action === "skip-backward") command(sessionTab.id, seekMediaScript(action === "skip-forward" ? 10 : -10));
    else stop(sessionTab.id);
  };

  useEffect(() => {
    const subscription = addMediaControlListener((action) => control.current(action));

    return () => subscription.remove();
  }, []);

  return {
    /** Tabs playing right now; they stay loaded so their sound doesn't stop. */
    playingTabIds: ids.filter((id) => reports[id]!.playing),
    player: playerTab
      ? { tab: playerTab, title: reports[playerTab.id]!.title || playerTab.title, playing: reports[playerTab.id]!.playing, video: reports[playerTab.id]!.video }
      : null,
    /** Takes a page message; false when it isn't a media report. */
    pageMessage(tabId: string, message: string): boolean {
      const report = parseMediaMessage(message);

      if (!report) return false;

      if (!report.playing && stopped.has(tabId)) return true;
      stopped.delete(tabId);
      setReports((previous) => ({ ...previous, [tabId]: { ...report, at: Date.now() } }));

      return true;
    },
    /** A new document has no media until it reports some. */
    loadStarted: forget,
    /** Drops the media of tabs that are no longer loaded. */
    keepOnly(loaded: ReadonlySet<string>): void {
      setReports((previous) =>
        Object.keys(previous).every((id) => loaded.has(id)) ? previous : Object.fromEntries(Object.entries(previous).filter(([id]) => loaded.has(id))),
      );
    },
    toggle: (tabId: string) => command(tabId, TOGGLE_MEDIA_SCRIPT),
    /** Skips ten seconds either way, like the system's skip buttons. */
    seek: (tabId: string, seconds: number) => command(tabId, seekMediaScript(seconds)),
    /** Asks the page's video element for picture in picture; a no-op where the page can't. */
    pictureInPicture: (tabId: string) => command(tabId, PIP_MEDIA_SCRIPT),
    stop,
  };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;

  return rest;
}
