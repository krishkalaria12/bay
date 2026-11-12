import { useBottomSheetScrollableCreator } from "@gorhom/bottom-sheet";
import { LegendList } from "@legendapp/list/react-native";

import { useEffect, useState, type JSX } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "@/chrome/Text";
import { space } from "@/chrome/tokens";
import { useT } from "@/i18n";
import { groupByDay } from "./historyGroups";
import { DAY_GROUP_LABELS, pageTitle, SearchField, siteName, SiteRow, time } from "./HistoryPanel";
import { ActionRow, PanelSheet, SectionLabel, SheetFitEnd } from "./PanelSheet";

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
  const listBottom = Math.max(insets.bottom, space.gutter) + space.md;
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
        <SheetFitEnd enabled={!query}>
          <View style={{ paddingHorizontal: space.gutter, paddingBottom: listBottom }}>
            <View testID="archive-empty" className="py-12">
              <Text accessibilityRole="header" variant="headline" className="text-center">
                {t("archive.empty")}
              </Text>
              <Text variant="subhead" tone="muted" className="mt-2 text-center">
                {t("archive.emptyDetail")}
              </Text>
            </View>
          </View>
        </SheetFitEnd>
      ) : groups.length === 0 ? (
        <SheetFitEnd enabled={!query}>
          <View style={{ paddingHorizontal: space.gutter, paddingBottom: listBottom }}>
            <SearchField testID="archive-search" value={query} onChange={setQuery} placeholder={t("archive.search")} />
            <Text testID="archive-no-matches" accessibilityLiveRegion="polite" tone="muted" className="py-8 text-center">
              {t("archive.noMatches", { query: query.trim() })}
            </Text>
            {clearFooter()}
          </View>
        </SheetFitEnd>
      ) : (
        <LegendList
          data={rows}
          keyExtractor={(row) => (row.kind === "label" ? `label-${row.label}` : row.item.id)}
          estimatedItemSize={56}
          keyboardShouldPersistTaps="handled"
          renderScrollComponent={Scrollable}
          contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: listBottom }}
          ListHeaderComponent={<SearchField testID="archive-search" value={query} onChange={setQuery} placeholder={t("archive.search")} />}
          // The list doesn't report its size through the sheet's scroll view; where its footer ends does.
          ListFooterComponent={
            <SheetFitEnd after={listBottom} enabled={!query}>
              {clearFooter()}
            </SheetFitEnd>
          }
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
