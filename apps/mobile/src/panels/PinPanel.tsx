import { displayUrl } from "@bay/core/src/suggest.ts";
import type { JSX } from "react";

import { useT } from "@/i18n";
import type { BrowserFolder, BrowserTab, PinKind, PinnedSite } from "@/store/types";

import { ActionRow, Group, PanelSheet } from "./PanelSheet";

/**
 * A tab's pinning, from a long press on its card: an Essential, a pinned row, or a row in one of the space's folders,
 * as the desktop's sidebar has them. The way it is pinned now is ticked; choosing it again unpins it.
 */
export function PinPanel({
  visible,
  onClose,
  tab,
  pin,
  folders,
  onPin,
  onCloseTab,
}: {
  visible: boolean;
  onClose: () => void;
  tab: BrowserTab | null;
  /** How the tab's page is pinned in its space now, if it is. */
  pin: PinnedSite | null;
  folders: readonly BrowserFolder[];
  onPin: (kind: PinKind, folderId: string | null) => void;
  onCloseTab: () => void;
}): JSX.Element {
  const t = useT();
  const title = tab ? tab.title || displayUrl(tab.url) : "";

  return (
    <PanelSheet visible={visible} onClose={onClose} title={title} testID="pin-menu" height="60%">
      <Group>
        <ActionRow
          testID="pin-menu-essential"
          icon="bookmark"
          label={t("pin.essential")}
          selected={pin?.kind === "essential"}
          onPress={() => onPin("essential", null)}
        />
        <ActionRow testID="pin-menu-row" icon="pin" label={t("pin.row")} selected={pin?.kind === "row" && !pin.folderId} onPress={() => onPin("row", null)} />
        {folders.map((folder) => (
          <ActionRow
            key={folder.id}
            testID={`pin-menu-folder-${folder.id}`}
            icon="folder"
            label={t("pin.into", { folder: folder.name })}
            selected={pin?.kind === "row" && pin.folderId === folder.id}
            onPress={() => onPin("row", folder.id)}
          />
        ))}
      </Group>
      <Group>
        <ActionRow testID="pin-menu-close-tab" icon="close" destructive label={t("pin.close")} onPress={onCloseTab} />
      </Group>
    </PanelSheet>
  );
}
