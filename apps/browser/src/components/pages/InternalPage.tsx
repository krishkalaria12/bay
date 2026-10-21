import { View } from "@bay/platform";
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { useBrowserRead as useBrowser } from "../../store/read";
import { dispatchBrowserCommand, reportBrowserCommand } from "../../runtime/commands";
import { bookmarkSpaceId } from "../../store/model";
import { BookmarksPage } from "./BookmarksPage";
import { DownloadsPage } from "./DownloadsPage";
import { HistoryPage } from "./HistoryPage";
import { internalPageOf, internalQuery, tabDestination } from "./urls";

export function InternalPage({ tabId }: { tabId: string }) {
  const url = useBrowser((s) => {
    const t = s.tabs[tabId];
    return t ? tabDestination(t) : "";
  });
  const page = internalPageOf(url);
  const spaceId = useBrowser((s) => s.tabs[tabId]?.spaceId ?? "");
  const bookmarkProfile = useBrowser((s) => bookmarkSpaceId(s, s.windows[s.tabs[tabId]?.windowId ?? ""]));

  useEffect(() => {
    if (!page) return;
    reportBrowserCommand(dispatchBrowserCommand({ method: "syncInternalPage", tabId }));
  }, [page, url]);

  if (!page) return null;
  return (
    <View style={StyleSheet.absoluteFill}>
      {page === "history" && <HistoryPage tabId={tabId} spaceId={spaceId} initialQuery={internalQuery(url)} />}
      {page === "bookmarks" && <BookmarksPage key={bookmarkProfile} tabId={tabId} spaceId={bookmarkProfile} />}
      {page === "downloads" && <DownloadsPage tabId={tabId} />}
    </View>
  );
}
