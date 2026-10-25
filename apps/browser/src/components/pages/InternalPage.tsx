import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useBrowser } from "../../store/browser";
import { bookmarkSpaceId } from "../../store/model";
import { LibraryPage } from "../library/LibraryPage";
import { EaselPage } from "../library/EaselPage";
import { easelIdOf } from "../library/actions";
import { useLibrary } from "../library/state";
import { BookmarksPage } from "./BookmarksPage";
import { DownloadsPage } from "./DownloadsPage";
import { HistoryPage } from "./HistoryPage";
import { INTERNAL_PAGES, internalPageOf, internalQuery, tabDestination } from "./urls";

export function InternalPage({ tabId }: { tabId: string }) {
  const url = useBrowser((s) => {
    const t = s.tabs[tabId];
    return t ? tabDestination(t) : "";
  });
  const page = internalPageOf(url);
  const easelId = easelIdOf(url);
  const easelTitle = useLibrary((s) => (easelId ? s.easels[easelId]?.title : undefined));
  const spaceId = useBrowser((s) => s.tabs[tabId]?.spaceId ?? "");
  const bookmarkProfile = useBrowser((s) => bookmarkSpaceId(s, s.windows[s.tabs[tabId]?.windowId ?? ""]));

  useEffect(() => {
    if (!page) return;
    const t = useBrowser.getState().tabs[tabId];
    const title = page === "easel" ? easelTitle || "Easel" : INTERNAL_PAGES[page].title;
    if (t && (t.url !== url || t.title !== title)) useBrowser.getState().updateTab(tabId, { url, title, favicon: null });
    useBrowser.getState().updateLive(tabId, { isLoading: false, progress: 0, canGoBack: false, canGoForward: false });
  }, [page, url, easelTitle, tabId]);

  if (!page) return null;
  return (
    <View style={StyleSheet.absoluteFill}>
      {page === "library" && <LibraryPage tabId={tabId} initialSection={internalQuery(url)} />}
      {page === "easel" && <EaselPage key={easelId} tabId={tabId} easelId={easelId} />}
      {page === "history" && <HistoryPage tabId={tabId} spaceId={spaceId} initialQuery={internalQuery(url)} />}
      {page === "bookmarks" && <BookmarksPage key={bookmarkProfile} tabId={tabId} spaceId={bookmarkProfile} />}
      {page === "downloads" && <DownloadsPage tabId={tabId} />}
    </View>
  );
}
