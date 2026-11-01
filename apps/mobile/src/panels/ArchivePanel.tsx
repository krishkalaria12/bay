import { Typography } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { View } from "react-native";

import { groupByDay } from "./historyGroups";
import { pageTitle, SearchField, siteName, SiteRow, time } from "./HistoryPanel";
import { ActionRow, PanelSheet, SectionLabel } from "./PanelSheet";

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
  onRemove: (id: string) => void;
  onClear: () => void;
}

export function ArchivePanel({ visible, onClose, items, onRestore, onRemove, onClear }: ArchivePanelProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (visible) setConfirming(false);
  }, [visible]);
  const needle = query.trim().toLowerCase();
  const matches = needle ? items.filter((item) => item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle)) : items;
  const groups = groupByDay(matches, Date.now(), (item) => item.closedAt);

  return (
    <PanelSheet visible={visible} onClose={onClose} title="Archive" testID="archive-screen" height="85%">
      {items.length ? <SearchField testID="archive-search" value={query} onChange={setQuery} placeholder="Search archived tabs" /> : null}
      {items.length === 0 ? (
        <View testID="archive-empty" className="py-12">
          <Typography className="text-center">No archived tabs</Typography>
          <Typography className="mt-2 text-center text-sm text-muted">Closed tabs and tabs you haven't used in a while wait here.</Typography>
        </View>
      ) : groups.length === 0 ? (
        <Typography testID="archive-no-matches" className="py-8 text-center text-muted">
          Nothing matches “{query.trim()}”
        </Typography>
      ) : (
        groups.map((group) => (
          <View key={group.label}>
            <SectionLabel>{group.label}</SectionLabel>
            {group.entries.map((item) => {
              const title = pageTitle(item.title, item.url);
              return (
                <SiteRow
                  key={item.id}
                  testID={`archive-restore-${item.id}`}
                  removeTestID={`archive-remove-${item.id}`}
                  url={item.url}
                  title={title}
                  detail={`${siteName(item.url)} · ${time(item.closedAt)}`}
                  onPress={() => {
                    onRestore(item.id);
                    onClose();
                  }}
                  onRemove={() => onRemove(item.id)}
                  removeLabel={`Remove ${title} from the archive`}
                />
              );
            })}
          </View>
        ))
      )}
      {items.length ? (
        <View className="mt-4">
          {confirming ? (
            <>
              <ActionRow
                testID="archive-clear-confirm"
                icon="delete"
                label="Clear archive"
                detail="Open tabs, history and pins stay."
                destructive
                onPress={() => {
                  setConfirming(false);
                  onClear();
                }}
              />
              <ActionRow testID="archive-clear-cancel" label="Keep archive" onPress={() => setConfirming(false)} />
            </>
          ) : (
            <ActionRow testID="archive-clear" icon="delete" label="Clear archive" destructive onPress={() => setConfirming(true)} />
          )}
        </View>
      ) : null}
    </PanelSheet>
  );
}
