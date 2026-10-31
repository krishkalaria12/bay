import { Typography } from "heroui-native";
import type { JSX } from "react";
import { View } from "react-native";

import { ActionRow, PanelSheet } from "./PanelSheet";

export interface ArchiveItem {
  id: string;
  url: string;
  title: string;
  closedAt: number;
}

export interface ArchivePanelProps {
  visible: boolean;
  onClose: () => void;
  items: readonly ArchiveItem[];
  onRestore: (id: string) => void;
}

export function ArchivePanel({ visible, onClose, items, onRestore }: ArchivePanelProps): JSX.Element {
  return (
    <PanelSheet visible={visible} onClose={onClose} title="Archive" testID="archive-screen">
      <Typography className="mb-3 text-sm text-muted">Closed tabs and tabs put away automatically stay here.</Typography>
      {items.length === 0 ? (
        <View testID="archive-empty" className="py-12">
          <Typography className="text-center">No archived tabs</Typography>
          <Typography className="mt-2 text-center text-sm text-muted">Close a tab to keep it here for later.</Typography>
        </View>
      ) : (
        items.map((item) => (
          <ActionRow
            key={item.id}
            testID={`archive-restore-${item.id}`}
            label={item.title || item.url}
            detail={item.url}
            onPress={() => {
              onRestore(item.id);
              onClose();
            }}
          />
        ))
      )}
    </PanelSheet>
  );
}
