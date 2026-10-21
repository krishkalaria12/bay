import { ScrollView } from "@bay/platform";
import { Pressable, View } from "@bay/platform";
import { resolveInput } from "@bay/core";
import { Surface } from "@bay/shell";
import { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { hex, useTheme } from "../../lib/theme";
import { useBrowserRead as useBrowser } from "../../store/read";
import { useWindowId } from "../../store/hooks";
import { searchUrlPrefix } from "../../store/settings";
import { Button, TextField, useFormColors } from "../settings/controls";
import { useBookmarkEditor, type EditorState } from "./edit";
import { FolderTree } from "./FolderTree";
import { reportBrowserCommand } from "../../runtime/commands";
import { addBookmark, addBookmarkFolder, moveBookmark, updateBookmark } from "../../runtime/bookmarkActions";

export function EditBookmarkDialog() {
  const windowId = useWindowId();
  const open = useBookmarkEditor((e) => (e.open?.windowId === windowId ? e.open : null));
  if (!open) return null;
  return <Sheet key={`${open.bookmarkId}:${open.folder}`} state={open} />;
}

function Sheet({ state }: { state: EditorState }) {
  const theme = useTheme();
  const colors = useFormColors();
  // The bookmark as the sheet opened on it (each one opens its own sheet).
  const [node] = useState(() => useBrowser.getState().bookmarks.nodes[state.bookmarkId ?? ""]);
  const [title, setTitle] = useState(node?.title ?? "");
  const [url, setUrl] = useState(node?.kind === "url" ? node.url : "");
  const [parentId, setParentId] = useState<string | null>(
    () => node?.parentId ?? state.parentId ?? useBrowser.getState().bookmarks.roots[state.spaceId]?.bar ?? null,
  );
  const searchPrefix = useBrowser((s) => searchUrlPrefix(s.settings));
  const close = () => useBookmarkEditor.getState().set(null);
  const resolvedUrl = url.trim() ? resolveInput(url, searchPrefix) : "";
  const valid = state.folder ? !!title.trim() : !!resolvedUrl;

  const save = () => {
    if (!valid) return;
    if (node) {
      reportBrowserCommand(updateBookmark(node.id, state.folder ? { title: title.trim() } : { title: title.trim(), url: resolvedUrl }));
      if (parentId && parentId !== node.parentId) reportBrowserCommand(moveBookmark(node.id, parentId));
    } else if (state.folder) {
      reportBrowserCommand(addBookmarkFolder({ spaceId: state.spaceId, title: title.trim(), parentId: parentId ?? undefined, index: state.index }));
    } else {
      const options = { spaceId: state.spaceId, url: resolvedUrl, title: title.trim() || resolvedUrl, parentId: parentId ?? undefined, index: state.index };
      reportBrowserCommand(addBookmark(options));
    }
    close();
  };

  const heading = state.folder ? (node ? "Rename Folder" : "New Folder") : node ? "Edit Bookmark" : "Add Bookmark";

  return (
    <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: theme.dark ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.15)" }]} onPress={close} />
      <Surface
        fill={hex(theme.panel)}
        cornerRadius={14}
        borderColor={hex(theme.panelBorder)}
        borderWidth={0.5}
        shadowColor="#000000"
        shadowOpacity={theme.panelShadowOpacity}
        shadowRadius={30}
        shadowOffset={[0, 12]}
        style={{ width: 420, padding: 18 }}
      >
        <Text style={{ fontSize: 15, fontWeight: "600", color: theme.textPrimary }}>{heading}</Text>
        <Label text="Name" />
        <TextField value={title} onChangeText={setTitle} autoFocus selectOnFocus onSubmit={save} onEscape={close} />
        {!state.folder && (
          <>
            <Label text="URL" />
            <TextField value={url} onChangeText={setUrl} placeholder="https://" onSubmit={save} onEscape={close} />
          </>
        )}
        {(!state.folder || !node) && (
          <>
            <Label text="Folder" />
            <View
              style={{
                height: 180,
                borderRadius: 7,
                borderWidth: StyleSheet.hairlineWidth * 2,
                borderColor: colors.fieldBorder,
                backgroundColor: colors.field,
              }}
            >
              <ScrollView contentContainerStyle={{ padding: 4 }}>
                <FolderTree spaceId={state.spaceId} selectedId={parentId} onSelect={setParentId} rowHeight={24} />
              </ScrollView>
            </View>
          </>
        )}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <Button title="Cancel" onPress={close} />
          <Button title="Save" kind="primary" disabled={!valid} onPress={save} />
        </View>
      </Surface>
    </View>
  );
}

function Label({ text }: { text: string }) {
  const theme = useTheme();
  return <Text style={{ fontSize: 11.5, marginTop: 12, marginBottom: 5, color: theme.textSecondary }}>{text}</Text>;
}
