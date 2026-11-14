import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useThemeColor } from "heroui-native";
import { useState, type JSX } from "react";
import { View } from "react-native";

import { inputFont } from "@/chrome/tokens";
import { useT } from "@/i18n";
import { spaceName } from "@/store/spaceName";
import type { BrowserFolder, BrowserSpace } from "@/store/types";
import { ActionRow, PanelSheet, SectionLabel } from "./PanelSheet";

export interface TabsMenuProps {
  visible: boolean;
  onClose: () => void;
  tabCount: number;
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
  const t = useT();

  function act(action: () => void): void {
    props.onClose();
    setPage("main");
    action();
  }

  const activeSpace = props.spaces.find((space) => space.id === props.activeSpaceId) ?? props.spaces[0];
  const activeSpaceName = activeSpace ? spaceName(activeSpace, t) : t("space.unnamed");
  const folders = props.folders;

  // A rename or a new folder: one input row and a done row, inside this same sheet.
  if (page === "renameSpace" || page === "renameFolder" || page === "newFolder") {
    const folderName = folders.find((folder) => folder.id === props.activeFolderId)?.name;

    const title =
      page === "renameSpace"
        ? t("tabsMenu.rename", { name: activeSpaceName })
        : page === "newFolder"
          ? t("tabsMenu.newFolderTitle")
          : folderName
            ? t("tabsMenu.rename", { name: folderName })
            : t("tabsMenu.renameFolder");

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
            style={[inputFont("body"), { flex: 1, color: foreground, paddingVertical: 10 }]}
          />
        </View>
        <ActionRow testID={`tabs-menu-name-save`} label={t("tabsMenu.done")} onPress={() => setPage("main")} />
      </PanelSheet>
    );
  }

  if (page === "move") {
    return (
      <PanelSheet visible={props.visible} onClose={props.onClose} title={t("tabsMenu.moveTab")} testID="tabs-menu" height="45%">
        <ActionRow testID="tabs-menu-move-back" label={t("tabsMenu.backToTabs")} onPress={() => setPage("main")} />
        <SectionLabel>{t("tabsMenu.spaces")}</SectionLabel>
        {props.spaces.map((space) => (
          <ActionRow
            key={space.id}
            testID={`tabs-menu-move-space-${space.id}`}
            label={spaceName(space, t)}
            selected={space.id === props.activeSpaceId}
            onPress={() => act(() => props.onMoveTab(space.id, null))}
          />
        ))}
        {folders.length ? (
          <>
            <SectionLabel>{t("tabsMenu.folders")}</SectionLabel>
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
    <PanelSheet visible={props.visible} onClose={props.onClose} title={t("tabsMenu.title")} testID="tabs-menu" height="45%">
      <ActionRow testID="tabs-menu-new" icon="add" label={t("tabsMenu.newTab")} onPress={() => act(props.onNewTab)} />
      <ActionRow testID="tabs-menu-private" icon="private" label={t("tabsMenu.newPrivateTab")} onPress={() => act(props.onNewPrivateTab)} />
      <ActionRow testID="tabs-menu-archive" icon="archive" label={t("tabsMenu.archiveTab")} onPress={() => act(props.onArchiveTab)} />
      {props.tabCount > 1 ? (
        <ActionRow
          testID="tabs-menu-archive-all"
          icon="archive"
          label={t("tabsMenu.archiveAll", { count: props.tabCount })}
          destructive
          onPress={() => act(props.onArchiveAll)}
        />
      ) : null}
      <SectionLabel>{t("tabsMenu.spaces")}</SectionLabel>
      {props.spaces.map((space) => (
        <ActionRow
          key={space.id}
          testID={`tabs-menu-space-${space.id}`}
          label={spaceName(space, t)}
          selected={space.id === props.activeSpaceId}
          onPress={() => act(() => props.onSelectSpace(space.id))}
        />
      ))}
      <ActionRow testID="tabs-menu-new-space" icon="add" label={t("tabsMenu.newSpace")} onPress={() => act(props.onNewSpace)} />
      {activeSpace ? (
        <>
          <ActionRow
            testID="tabs-menu-rename-space"
            label={t("tabsMenu.rename", { name: activeSpaceName })}
            onPress={() => {
              setName(activeSpace.name);
              setPage("renameSpace");
            }}
          />
          {props.spaces.length > 1 ? (
            <ActionRow
              testID="tabs-menu-delete-space"
              label={t("tabsMenu.deleteSpace", { name: activeSpaceName })}
              detail={t("tabsMenu.deleteSpace.detail")}
              destructive
              onPress={() => act(() => props.onDeleteSpace(activeSpace.id))}
            />
          ) : null}
        </>
      ) : null}
      <SectionLabel>{t("tabsMenu.moveTab")}</SectionLabel>
      <ActionRow testID="tabs-menu-move" label={t("tabsMenu.moveTabTo")} onPress={() => setPage("move")} />
      <SectionLabel>{t("tabsMenu.folders")}</SectionLabel>
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
        <ActionRow testID="tabs-menu-folders-empty" label={t("tabsMenu.noFolders")} onPress={() => setPage("newFolder")} />
      )}
      <ActionRow
        testID="tabs-menu-new-folder"
        icon="add"
        label={t("tabsMenu.newFolder")}
        onPress={() => {
          setName("");
          setPage("newFolder");
        }}
      />
      {props.activeFolderId ? <ActionRow testID="tabs-menu-rename-folder" label={t("tabsMenu.renameFolder")} onPress={() => setPage("renameFolder")} /> : null}
      {props.activeFolderId ? (
        <ActionRow
          testID="tabs-menu-delete-folder"
          label={t("tabsMenu.deleteFolder")}
          detail={t("tabsMenu.deleteFolder.detail")}
          destructive
          onPress={() => act(() => props.onDeleteFolder(props.activeFolderId!))}
        />
      ) : null}
    </PanelSheet>
  );
}
