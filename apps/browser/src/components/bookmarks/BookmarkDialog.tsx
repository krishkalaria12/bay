import { ScrollView } from "@bay/platform";
import { Pressable, View } from "@bay/platform";
import { prompt, Surface } from "@bay/shell";
import { useEffect, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { hex, useTheme } from "../../lib/theme";
import { layout } from "../../lib/constants";
import { useBrowser } from "../../store/browser";
import { useSidebarOpen, useWindowId } from "../../store/hooks";
import { Button, TextField, useFormColors } from "../settings/controls";
import { useBookmarkDialog, type BookmarkDialogState } from "./actions";
import { FolderTree } from "./FolderTree";
import { useSidebarFieldShown, useSidebarOnRight } from "../layout/windowLayout";
import { SIDEBAR_FIELD } from "../layout/constants";
import { useSidebarMetrics, useSidebarWidth } from "../sidebar/tokens";
import { reportBrowserCommand } from "../../runtime/commands";
import { addBookmarkFolder, addBookmarkTree, moveBookmark, removeBookmark, updateBookmark } from "../../runtime/bookmarkActions";
import { browserRead } from "../../store/read";

export function BookmarkDialog() {
  const windowId = useWindowId();
  const open = useBookmarkDialog((d) => (d.open?.windowId === windowId ? d.open : null));
  if (!open) return null;
  return <DialogPanel key={open.kind === "page" ? open.bookmarkId : "all"} state={open} />;
}

function DialogPanel({ state }: { state: BookmarkDialogState }) {
  const theme = useTheme();
  const colors = useFormColors();
  const metrics = useSidebarMetrics();
  // Under the star it was opened from: the sidebar's field, or the toolbar's end (the sidebar's edge, on the right).
  const right = useSidebarOnRight();
  const sidebarOpen = useSidebarOpen();
  const field = useSidebarFieldShown() && sidebarOpen;
  const sidebarWidth = useSidebarWidth(useWindowId());
  const fieldSide = right ? { right: layout.sidebarInset } : { left: layout.sidebarInset };
  const toolbarEnd = (right && sidebarOpen ? sidebarWidth : layout.cardInset) + 10;
  const bookmark = useBrowser((s) => (state.kind === "page" ? s.bookmarks.nodes[state.bookmarkId] : undefined));
  const spaceId = state.kind === "page" ? profileOfNode(state.bookmarkId) : state.spaceId;
  const [name, setName] = useState(() => (state.kind === "page" ? (bookmark?.title ?? "") : ""));
  const [folderId, setFolderId] = useState<string | null>(() =>
    state.kind === "page" ? (bookmark?.parentId ?? null) : (useBrowser.getState().bookmarks.roots[state.spaceId]?.bar ?? null),
  );
  const close = () => useBookmarkDialog.getState().set(null);

  useEffect(() => {
    if (state.kind === "page" && !bookmark) close();
  }, [bookmark]);

  const done = () => {
    if (state.kind === "page") {
      if (!browserRead.getState().bookmarks.nodes[state.bookmarkId]) return close();
      if (name.trim() && name !== bookmark?.title) reportBrowserCommand(updateBookmark(state.bookmarkId, { title: name.trim() }));
      if (folderId && folderId !== bookmark?.parentId) reportBrowserCommand(moveBookmark(state.bookmarkId, folderId));
    } else {
      const title = name.trim() || "Tabs";
      reportBrowserCommand(
        addBookmarkTree(state.spaceId, [{ title, children: state.tabs.map((t) => ({ title: t.title, url: t.url })) }], folderId ?? undefined),
      );
    }
    close();
  };

  const remove = () => {
    if (state.kind === "page") reportBrowserCommand(removeBookmark(state.bookmarkId));
    close();
  };

  const newFolder = async () => {
    const title = await prompt({ title: "New Folder", placeholder: "Folder name", confirmTitle: "Create", windowId: state.windowId });
    if (!title || !spaceId) return;
    setFolderId(await addBookmarkFolder({ spaceId, title, parentId: folderId ?? undefined }));
  };

  const heading = state.kind === "allTabs" ? `Bookmark ${state.tabs.length} Tabs` : "Bookmark Added";

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={StyleSheet.absoluteFill} onPress={done} />
      <Surface
        fill={hex(theme.panel)}
        cornerRadius={14}
        borderColor={hex(theme.panelBorder)}
        borderWidth={0.5}
        shadowColor="#000000"
        shadowOpacity={theme.panelShadowOpacity}
        shadowRadius={24}
        shadowOffset={[0, 10]}
        style={{
          position: "absolute",
          ...(field
            ? { top: SIDEBAR_FIELD.top + metrics.addressHeight + 4, ...fieldSide }
            : { top: layout.cardTop + layout.toolbarHeight - 2, right: toolbarEnd }),
          width: 320,
          padding: 14,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>{heading}</Text>
        <Text style={{ fontSize: 11.5, marginTop: 12, marginBottom: 5, color: theme.textSecondary }}>{state.kind === "allTabs" ? "Folder name" : "Name"}</Text>
        <TextField
          value={name}
          onChangeText={setName}
          autoFocus
          selectOnFocus
          placeholder={state.kind === "allTabs" ? "Tabs" : "Name"}
          onSubmit={done}
          onEscape={done}
        />
        <Text style={{ fontSize: 11.5, marginTop: 12, marginBottom: 5, color: theme.textSecondary }}>Folder</Text>
        <View
          style={{
            height: 176,
            borderRadius: 7,
            borderWidth: StyleSheet.hairlineWidth * 2,
            borderColor: colors.fieldBorder,
            backgroundColor: colors.field,
            overflow: "hidden",
          }}
        >
          <ScrollView contentContainerStyle={{ padding: 4 }}>
            {spaceId && <FolderTree spaceId={spaceId} selectedId={folderId} onSelect={setFolderId} rowHeight={24} />}
          </ScrollView>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 14, gap: 8 }}>
          <Button title="New Folder" onPress={newFolder} />
          <View style={{ flex: 1 }} />
          {state.kind === "page" ? <Button title="Remove" onPress={remove} /> : <Button title="Cancel" onPress={close} />}
          <Button title={state.kind === "page" ? "Done" : "Save"} kind="primary" onPress={done} />
        </View>
      </Surface>
    </View>
  );
}

function profileOfNode(id: string): string | null {
  const b = useBrowser.getState().bookmarks;
  let node = b.nodes[id];
  for (let i = 0; node?.parentId && i < 64; i++) node = b.nodes[node.parentId];
  if (!node) return null;
  return Object.entries(b.roots).find(([, r]) => r.bar === node!.id || r.other === node!.id)?.[0] ?? null;
}
