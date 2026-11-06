import type { JSX } from "react";

import { ActionRow, PanelSheet } from "./PanelSheet";

export interface TabsMenuProps {
  visible: boolean;
  onClose: () => void;
  tabCount: number;
  privateAvailable: boolean;
  onNewTab: () => void;
  onNewPrivateTab: () => void;
  onArchiveTab: () => void;
  onArchiveAll: () => void;
}

/** Long-pressing the Tabs button: quick tab actions without opening the switcher. */
export function TabsMenu(props: TabsMenuProps): JSX.Element {
  function act(action: () => void): void {
    props.onClose();
    action();
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
    </PanelSheet>
  );
}
