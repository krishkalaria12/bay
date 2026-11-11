import { useBottomSheetScrollableCreator } from "@gorhom/bottom-sheet";
import { LegendList } from "@legendapp/list/react-native";
import { Typography } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useT } from "@/i18n";
import { groupByDay } from "./historyGroups";
import { DAY_GROUP_LABELS, pageTitle, SearchField, siteName, SiteRow, time } from "./HistoryPanel";
import { ActionRow, PanelSheet, SectionLabel } from "./PanelSheet";

type Row = { kind: "label"; label: string } | { kind: "entry"; item: ArchiveItem };

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
  const insets = useSafeAreaInsets();
  const Scrollable = useBottomSheetScrollableCreator();
  const t = useT();
  useEffect(() => {
    if (visible) setConfirming(false);
  }, [visible]);
  const needle = query.trim().toLowerCase();
  const matches = needle ? items.filter((item) => item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle)) : items;
  const groups = groupByDay(matches, Date.now(), (item) => item.closedAt);

  const rows: Row[] = groups.flatMap((group) => [
    { kind: "label" as const, label: t(DAY_GROUP_LABELS[group.id]) },
    ...group.entries.map((item) => ({ kind: "entry" as const, item })),
  ]);

  function clearFooter(): JSX.Element | null {
    if (!items.length) return null;

    return (
      <View className="mt-4">
        {confirming ? (
          <>
            <ActionRow
              testID="archive-clear-confirm"
              icon="delete"
              label={t("archive.clear")}
              detail={t("archive.clear.detail")}
              destructive
              onPress={() => {
                setConfirming(false);
                onClear();
              }}
            />
            <ActionRow testID="archive-clear-cancel" label={t("archive.keep")} onPress={() => setConfirming(false)} />
          </>
        ) : (
          <ActionRow testID="archive-clear" icon="delete" label={t("archive.clear")} destructive onPress={() => setConfirming(true)} />
        )}
      </View>
    );
  }

  return (
    <PanelSheet visible={visible} onClose={onClose} title={t("archive.title")} testID="archive-screen" height="85%" listMode>
      {items.length === 0 ? (
        <View testID="archive-empty" className="py-12">
          <Typography accessibilityRole="header" className="text-center">
            {t("archive.empty")}
          </Typography>
          <Typography className="mt-2 text-center text-sm text-muted">{t("archive.emptyDetail")}</Typography>
        </View>
      ) : groups.length === 0 ? (
        <>
          <SearchField testID="archive-search" value={query} onChange={setQuery} placeholder={t("archive.search")} />
          <Typography testID="archive-no-matches" accessibilityLiveRegion="polite" className="py-8 text-center text-muted">
            {t("archive.noMatches", { query: query.trim() })}
          </Typography>
          {clearFooter()}
        </>
      ) : (
        <LegendList
          data={rows}
          keyExtractor={(row) => (row.kind === "label" ? `label-${row.label}` : row.item.id)}
          estimatedItemSize={56}
          keyboardShouldPersistTaps="handled"
          renderScrollComponent={Scrollable}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 20) + 12 }}
          ListHeaderComponent={<SearchField testID="archive-search" value={query} onChange={setQuery} placeholder={t("archive.search")} />}
          ListFooterComponent={clearFooter()}
          renderItem={({ item }) => {
            if (item.kind === "label") return <SectionLabel>{item.label}</SectionLabel>;
            const entry = item.item;
            const title = pageTitle(entry.title, entry.url);

            return (
              <SiteRow
                testID={`archive-restore-${entry.id}`}
                removeTestID={`archive-remove-${entry.id}`}
                url={entry.url}
                title={title}
                detail={`${siteName(entry.url)} · ${time(entry.closedAt)}`}
                onPress={() => {
                  onRestore(entry.id);
                  onClose();
                }}
                onRemove={() => onRemove(entry.id)}
                removeLabel={t("archive.removeLabel", { title })}
              />
            );
          }}
          style={{ flex: 1 }}
        />
      )}
    </PanelSheet>
  );
}
