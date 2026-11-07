import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useThemeColor } from "heroui-native";
import { useState, type JSX } from "react";
import { View } from "react-native";

import { ActionRow, PanelSheet, SectionLabel } from "./PanelSheet";
import type { BrowserFolder, BrowserSpace } from "@/store/types";

export interface TabsMenuProps {
  visible: boolean;
  onClose: () => void;
  tabCount: number;
  privateAvailable: boolean;
  onNewTab: () => void;
  onNewPrivateTab: () => void;
  onArchiveTab: () => void;
  onArchiveAll: () => void;
  /** Spaces (B21): the switcher shows one at a time. */
  spaces: readonly BrowserSpace[];
  activeSpaceId: string;
  onSelectSpace: (id: string) => void;
  onNewSpace: () => void;
  onRenameSpace: (id: string, name: string) => void;
  onDeleteSpace: (id: string) => void;
  /** Folders in the active space. */
  folders: readonly BrowserFolder[];
  activeFolderId: string | null;
  onSelectFolder: (id: string | null) => void;
  onNewFolder: (name: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  /** Moves the active tab to a space or into a folder. */
  onMoveTab: (spaceId: string, folderId: string | null) => void;
}

type MenuPage = "main" | "move" | "renameSpace" | "renameFolder" | "newFolder";

/** Long-pressing the Tabs button: quick tab actions, spaces (B21) and folders, without opening the switcher. */
export function TabsMenu(props: TabsMenuProps): JSX.Element {
  const [page, setPage] = useState<MenuPage>("main");
  const [name, setName] = useState("");
  const foreground = useThemeColor("foreground");

  function act(action: () => void): void {
    props.onClose();
    setPage("main");
    action();
  }

  const activeSpace = props.spaces.find((space) => space.id === props.activeSpaceId) ?? props.spaces[0];
  const folders = props.folders;

  // A rename or a new folder: one input row and a done row, inside this same sheet.
  if (page === "renameSpace" || page === "renameFolder" || page === "newFolder") {
    const title =
      page === "renameSpace"
        ? `Rename ${activeSpace?.name ?? "space"}`
        : page === "newFolder"
          ? "New folder"
          : `Rename ${folders.find((folder) => folder.id === props.activeFolderId)?.name ?? "folder"}`;

    return (
      <PanelSheet visible={props.visible} onClose={props.onClose} title={title} testID="tabs-menu" height="45%">
        <View className="mt-3 flex-row items-center rounded-full bg-default px-4">
          <BottomSheetTextInput
            testID="tabs-menu-name"
            accessibilityLabel={title}
            value={name}
            onChangeText={setName}
            returnKeyType="done"
            autoFocus
            onSubmitEditing={() => {
              const trimmed = name.trim();
              if (!trimmed) return;

              if (page === "renameSpace" && activeSpace) act(() => props.onRenameSpace(activeSpace.id, trimmed));
              else if (page === "newFolder") act(() => props.onNewFolder(trimmed));
              else if (page === "renameFolder" && props.activeFolderId) act(() => props.onRenameFolder(props.activeFolderId!, trimmed));
            }}
            style={{ flex: 1, color: foreground, fontSize: 16, paddingVertical: 10 }}
          />
        </View>
        <ActionRow testID={`tabs-menu-name-save`} label="Done" onPress={() => setPage("main")} />
      </PanelSheet>
    );
  }

  if (page === "move") {
    return (
      <PanelSheet visible={props.visible} onClose={props.onClose} title="Move tab" testID="tabs-menu" height="45%">
        <ActionRow testID="tabs-menu-move-back" label="Back to Tabs" onPress={() => setPage("main")} />
        <SectionLabel>Spaces</SectionLabel>
        {props.spaces.map((space) => (
          <ActionRow
            key={space.id}
            testID={`tabs-menu-move-space-${space.id}`}
            label={space.name}
            selected={space.id === props.activeSpaceId}
            onPress={() => act(() => props.onMoveTab(space.id, null))}
          />
        ))}
        {folders.length ? (
          <>
            <SectionLabel>Folders</SectionLabel>
            {folders.map((folder) => (
              <ActionRow
                key={folder.id}
                testID={`tabs-menu-move-folder-${folder.id}`}
                label={folder.name}
                selected={folder.id === props.activeFolderId}
                onPress={() => act(() => props.onMoveTab(props.activeSpaceId, folder.id))}
              />
            ))}
          </>
        ) : null}
      </PanelSheet>
    );
  }

  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title="Tabs" testID="tabs-menu" height="45%">
      <ActionRow testID="tabs-menu-new" icon="add" label="New tab" onPress={() => act(props.onNewTab)} />
      {props.privateAvailable ? (
        <ActionRow testID="tabs-menu-private" icon="private" label="New private tab" onPress={() => act(props.onNewPrivateTab)} />
      ) : null}
      <ActionRow testID="tabs-menu-archive" icon="archive" label="Archive this tab" onPress={() => act(props.onArchiveTab)} />
      {props.tabCount > 1 ? (
        <ActionRow
          testID="tabs-menu-archive-all"
          icon="archive"
          label={`Archive all ${props.tabCount} tabs`}
          destructive
          onPress={() => act(props.onArchiveAll)}
        />
      ) : null}
      <SectionLabel>Spaces</SectionLabel>
      {props.spaces.map((space) => (
        <ActionRow
          key={space.id}
          testID={`tabs-menu-space-${space.id}`}
          label={space.name}
          selected={space.id === props.activeSpaceId}
          onPress={() => act(() => props.onSelectSpace(space.id))}
        />
      ))}
      <ActionRow testID="tabs-menu-new-space" icon="add" label="New space" onPress={() => act(props.onNewSpace)} />
      {activeSpace ? (
        <>
          <ActionRow
            testID="tabs-menu-rename-space"
            label={`Rename ${activeSpace.name}`}
            onPress={() => {
              setName(activeSpace.name);
              setPage("renameSpace");
            }}
          />
          {props.spaces.length > 1 ? (
            <ActionRow
              testID="tabs-menu-delete-space"
              label={`Delete ${activeSpace.name}`}
              detail="Tabs move to the first space"
              destructive
              onPress={() => act(() => props.onDeleteSpace(activeSpace.id))}
            />
          ) : null}
        </>
      ) : null}
      <SectionLabel>Move tab</SectionLabel>
      <ActionRow testID="tabs-menu-move" label={`Move tab to…`} onPress={() => setPage("move")} />
      <SectionLabel>Folders</SectionLabel>
      {folders.length ? (
        folders.map((folder) => (
          <ActionRow
            key={folder.id}
            testID={`tabs-menu-folder-${folder.id}`}
            label={folder.name}
            selected={folder.id === props.activeFolderId}
            onPress={() => act(() => props.onSelectFolder(folder.id))}
          />
        ))
      ) : (
        <ActionRow testID="tabs-menu-folders-empty" label="No folders yet" onPress={() => setPage("newFolder")} />
      )}
      <ActionRow
        testID="tabs-menu-new-folder"
        icon="add"
        label="New folder…"
        onPress={() => {
          setName("");
          setPage("newFolder");
        }}
      />
      {props.activeFolderId ? <ActionRow testID="tabs-menu-rename-folder" label="Rename folder" onPress={() => setPage("renameFolder")} /> : null}
      {props.activeFolderId ? (
        <ActionRow
          testID="tabs-menu-delete-folder"
          label="Delete folder"
          detail="Tabs return to the top level"
          destructive
          onPress={() => act(() => props.onDeleteFolder(props.activeFolderId!))}
        />
      ) : null}
    </PanelSheet>
  );
}
