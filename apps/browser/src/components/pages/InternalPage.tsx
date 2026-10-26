import { View } from "@bay/platform";
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { useBrowserRead as useBrowser } from "../../store/read";
import { dispatchBrowserCommand, reportBrowserCommand } from "../../runtime/commands";
import { bookmarkSpaceId } from "../../store/model";
import { libraryAvailable } from "../library/availability";
import { EmptyState } from "./PageLayout";
import { LibraryPage } from "../library/LibraryPage";
import { EaselPage } from "../library/EaselPage";
import { easelIdOf } from "../library/actions";
import { useLibrary } from "../library/state";
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
  const easelId = easelIdOf(url);
  const easelTitle = useLibrary((s) => (easelId ? s.easels[easelId]?.title : undefined));
  const spaceId = useBrowser((s) => s.tabs[tabId]?.spaceId ?? "");
  const bookmarkProfile = useBrowser((s) => bookmarkSpaceId(s, s.windows[s.tabs[tabId]?.windowId ?? ""]));

  useEffect(() => {
    if (!page) return;
    reportBrowserCommand(dispatchBrowserCommand({ method: "syncInternalPage", tabId }));
  }, [page, url, easelTitle, tabId]);

  if (!page) return null;
  if ((page === "library" || page === "easel") && !libraryAvailable())
    return <EmptyState title="Library and Easels are unavailable" subtitle="These features are not supported in this window yet." />;
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
