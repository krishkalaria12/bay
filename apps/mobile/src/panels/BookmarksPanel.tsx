import { useBottomSheetScrollableCreator } from "@gorhom/bottom-sheet";
import { LegendList } from "@legendapp/list/react-native";
import { useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/chrome/Icon";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { iconSize, space } from "@/chrome/tokens";
import { useT } from "@/i18n";
import { BOOKMARKS_ROOT, bookmarkChildren, bookmarkFolder, bookmarkLinks, folderLinkCount } from "@/store/bookmarks";
import type { BookmarkFolder, BookmarkNode, Bookmarks } from "@/store/types";
import { pageTitle, SearchField, siteName, SiteRow } from "./HistoryPanel";
import { ActionRow, PanelSheet, SheetFitEnd } from "./PanelSheet";
import { quietWhileClosed } from "./quietWhileClosed";

/** How many search matches the list shows. */
const SHOWN = 200;

type Link = Extract<BookmarkNode, { kind: "url" }>;

export interface BookmarksPanelProps {
  visible: boolean;
  onClose: () => void;
  bookmarks: Bookmarks;
  onOpen: (url: string) => void;
  /** Removes a bookmark, or a folder with everything in it. */
  onRemove: (id: string) => void;
  /** Opens the import sheet. */
  onImport: () => void;
}

/**
 * The bookmark tree, a folder at a time, in the order it was saved. Search looks through every link, whichever folder
 * it's in. Removing a folder asks first, since it takes everything inside with it.
 */
function BookmarksPanelSheet({ visible, onClose, bookmarks, onOpen, onRemove, onImport }: BookmarksPanelProps): JSX.Element {
  const t = useT();
  const insets = useSafeAreaInsets();
  const Scrollable = useBottomSheetScrollableCreator();
  const listBottom = Math.max(insets.bottom, space.gutter) + space.md;
  const [folderId, setFolderId] = useState(BOOKMARKS_ROOT);
  const [query, setQuery] = useState("");
  // The folder whose remove button was tapped: its row asks before anything goes.
  const [confirming, setConfirming] = useState<string | null>(null);

  // Each opening starts at the top, with no search.
  useEffect(() => {
    if (!visible) return;
    setFolderId(BOOKMARKS_ROOT);
    setQuery("");
    setConfirming(null);
  }, [visible]);

  // A folder removed while open (or by clearing data) leaves the list at the top.
  const folder = bookmarkFolder(bookmarks, folderId) ?? bookmarkFolder(bookmarks, BOOKMARKS_ROOT);
  const atRoot = !folder || folder.id === BOOKMARKS_ROOT;
  const needle = query.trim().toLowerCase();
  const total = Object.keys(bookmarks).length - 1;

  const rows: BookmarkNode[] = needle
    ? bookmarkLinks(bookmarks)
        .filter((link) => link.title.toLowerCase().includes(needle) || link.url.toLowerCase().includes(needle))
        .slice(0, SHOWN)
    : folder
      ? bookmarkChildren(bookmarks, folder.id)
      : [];

  const open = (url: string) => {
    onClose();
    onOpen(url);
  };

  const enter = (id: string) => {
    setConfirming(null);
    setFolderId(id);
  };

  const search = <SearchField testID="bookmarks-search" value={query} onChange={setQuery} placeholder={t("bookmarks.search")} />;

  const importRow = (
    <View className="mt-4">
      <ActionRow testID="bookmarks-import" icon="import" label={t("bookmarks.import")} chevron onPress={onImport} />
    </View>
  );

  const title = atRoot ? t("bookmarks.title") : folder.title || t("bookmarks.untitled");

  return (
    <PanelSheet
      visible={visible}
      onClose={onClose}
      onBack={atRoot ? undefined : () => enter(folder.parentId ?? BOOKMARKS_ROOT)}
      title={title}
      testID="bookmarks-screen"
      height="85%"
      listMode
    >
      {total === 0 ? (
        <SheetFitEnd>
          <View style={{ paddingHorizontal: space.gutter, paddingBottom: listBottom }}>
            <View testID="bookmarks-empty" className="py-10">
              <Text accessibilityRole="header" variant="headline" className="text-center">
                {t("bookmarks.empty")}
              </Text>
              <Text variant="subhead" tone="muted" className="mt-2 text-center">
                {t("bookmarks.emptyDetail")}
              </Text>
            </View>
            {importRow}
          </View>
        </SheetFitEnd>
      ) : rows.length === 0 ? (
        <SheetFitEnd enabled={!query}>
          <View style={{ paddingHorizontal: space.gutter, paddingBottom: listBottom }}>
            {search}
            <Text testID="bookmarks-no-matches" accessibilityLiveRegion="polite" tone="muted" className="py-8 text-center">
              {needle ? t("bookmarks.noMatches", { query: query.trim() }) : t("bookmarks.folderEmpty")}
            </Text>
          </View>
        </SheetFitEnd>
      ) : (
        <LegendList
          data={rows}
          keyExtractor={(node) => node.id}
          // The folder asking to be removed lives outside the rows, so the list redraws when it changes.
          extraData={confirming}
          estimatedItemSize={56}
          keyboardShouldPersistTaps="handled"
          renderScrollComponent={Scrollable}
          contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: listBottom }}
          ListHeaderComponent={search}
          ListFooterComponent={
            <SheetFitEnd after={listBottom} enabled={!query}>
              {atRoot && !needle ? importRow : null}
            </SheetFitEnd>
          }
          renderItem={({ item }) =>
            item.kind === "folder" ? (
              <FolderRow
                folder={item}
                count={folderLinkCount(bookmarks, item.id)}
                confirming={confirming === item.id}
                onOpen={() => enter(item.id)}
                onAskRemove={() => setConfirming(item.id)}
                onRemove={() => {
                  setConfirming(null);
                  onRemove(item.id);
                }}
                onKeep={() => setConfirming(null)}
              />
            ) : (
              <LinkRow link={item} onOpen={open} onRemove={onRemove} />
            )
          }
          style={{ flex: 1 }}
        />
      )}
    </PanelSheet>
  );
}

function LinkRow({ link, onOpen, onRemove }: { link: Link; onOpen: (url: string) => void; onRemove: (id: string) => void }): JSX.Element {
  const t = useT();
  const title = pageTitle(link.title, link.url);

  return (
    <SiteRow
      testID={`bookmark-open-${link.url}`}
      removeTestID={`bookmark-remove-${link.url}`}
      url={link.url}
      title={title}
      detail={siteName(link.url)}
      onPress={() => onOpen(link.url)}
      onRemove={() => onRemove(link.id)}
      removeLabel={t("bookmarks.removeLabel", { title })}
    />
  );
}

function FolderRow(props: {
  folder: BookmarkFolder;
  count: number;
  confirming: boolean;
  onOpen: () => void;
  onAskRemove: () => void;
  onRemove: () => void;
  onKeep: () => void;
}): JSX.Element {
  const t = useT();
  const muted = useThemeColor("muted");
  const accent = useThemeColor("accent");
  const name = props.folder.title || t("bookmarks.untitled");

  const detail =
    props.count === 0 ? t("bookmarks.folderEmpty") : props.count === 1 ? t("bookmarks.folderOne") : t("bookmarks.folderCount", { count: props.count });

  if (props.confirming) {
    return (
      <View testID={`bookmark-folder-confirm-${name}`} className="border-b border-foreground/5 py-2">
        <ActionRow
          testID="bookmark-folder-remove-confirm"
          icon="delete"
          label={t("bookmarks.removeFolder", { title: name })}
          detail={detail}
          destructive
          onPress={props.onRemove}
        />
        <ActionRow testID="bookmark-folder-keep" label={t("bookmarks.keep")} onPress={props.onKeep} />
      </View>
    );
  }

  return (
    <View className="min-h-14 flex-row items-center gap-3 border-b border-foreground/5">
      <PressFeedback
        testID={`bookmark-folder-${name}`}
        accessibilityRole="button"
        accessibilityLabel={t("bookmarks.openFolderLabel", { title: name })}
        accessibilityValue={{ text: detail }}
        onPress={props.onOpen}
        className="flex-1 flex-row items-center gap-3 py-2"
      >
        <View className="items-center justify-center" style={{ width: 28, height: 28 }}>
          <Icon name="folder" color={accent} size={iconSize.control} />
        </View>
        <View className="flex-1">
          <Text variant="callout" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="footnote" tone="muted" numberOfLines={1}>
            {detail}
          </Text>
        </View>
        <Icon name="chevron" color={muted} size={iconSize.inline} />
      </PressFeedback>
      <PressFeedback
        testID={`bookmark-folder-remove-${name}`}
        accessibilityRole="button"
        accessibilityLabel={t("bookmarks.removeLabel", { title: name })}
        onPress={props.onAskRemove}
        className="h-11 w-11 items-center justify-center"
      >
        <Icon name="close" color={muted} size={18} />
      </PressFeedback>
    </View>
  );
}

export const BookmarksPanel = quietWhileClosed(BookmarksPanelSheet);
