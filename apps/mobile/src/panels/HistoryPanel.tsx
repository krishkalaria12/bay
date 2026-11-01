import { hostOf } from "@bay/core/src/omnibox.ts";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { Typography, useThemeColor } from "heroui-native";
import { useState, type JSX } from "react";
import { Pressable, Text, View } from "react-native";

import { Icon } from "@/chrome/Icon";
import { SiteIcon } from "@/browser/SiteIcon";
import type { HistoryEntry } from "@/store/types";
import { groupByDay } from "./historyGroups";
import { ActionRow, PanelSheet, SectionLabel } from "./PanelSheet";

// ponytail: rows render in a plain scroll view; switch to BottomSheetFlatList if 200 rows ever feel slow.
const SHOWN = 200;

export interface HistoryPanelProps {
  visible: boolean;
  onClose: () => void;
  history: readonly HistoryEntry[];
  onOpen: (url: string) => void;
  onRemove: (url: string) => void;
  onClear: () => void;
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function HistoryPanel({ visible, onClose, history, onOpen, onRemove, onClear }: HistoryPanelProps): JSX.Element {
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);
  const needle = query.trim().toLowerCase();
  const matches = needle ? history.filter((entry) => entry.title.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle)) : history;
  const groups = groupByDay(matches.slice(0, SHOWN), Date.now());

  return (
    <PanelSheet visible={visible} onClose={onClose} title="History" testID="history-screen" height="85%">
      <View className="mb-1 flex-row items-center gap-2 rounded-full bg-default px-4">
        <Icon name="search" color={muted} size={18} />
        <BottomSheetTextInput
          testID="history-search"
          value={query}
          onChangeText={setQuery}
          placeholder="Search history"
          placeholderTextColor={muted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={{ flex: 1, color: foreground, fontSize: 16, paddingVertical: 10 }}
        />
      </View>
      {history.length === 0 ? (
        <View testID="history-empty" className="py-12">
          <Typography className="text-center">No history yet</Typography>
          <Typography className="mt-2 text-center text-sm text-muted">Pages you visit show up here. Private tabs never do.</Typography>
        </View>
      ) : groups.length === 0 ? (
        <Typography testID="history-no-matches" className="py-8 text-center text-muted">
          Nothing matches “{query.trim()}”
        </Typography>
      ) : (
        groups.map((group) => (
          <View key={group.label}>
            <SectionLabel>{group.label}</SectionLabel>
            {group.entries.map((entry) => {
              const title = entry.title || hostOf(entry.url);
              return (
                <View key={entry.url} className="min-h-14 flex-row items-center gap-3 border-b border-foreground/5">
                  <Pressable
                    testID={`history-open-${entry.url}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${title}`}
                    onPress={() => {
                      onClose();
                      onOpen(entry.url);
                    }}
                    className="flex-1 flex-row items-center gap-3 py-2 active:opacity-60"
                  >
                    <SiteIcon url={entry.url} size={24} />
                    <View className="flex-1">
                      <Text numberOfLines={1} style={{ color: foreground, fontSize: 15 }}>
                        {title}
                      </Text>
                      <Text numberOfLines={1} style={{ color: muted, fontSize: 12.5 }}>
                        {`${hostOf(entry.url).replace(/^www\./, "")} · ${time(entry.lastVisit)}`}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable
                    testID={`history-remove-${entry.url}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${title} from history`}
                    onPress={() => onRemove(entry.url)}
                    className="h-11 w-11 items-center justify-center active:opacity-60"
                  >
                    <Icon name="close" color={muted} size={18} />
                  </Pressable>
                </View>
              );
            })}
          </View>
        ))
      )}
      {history.length ? (
        confirming ? (
          <View testID="history-clear-confirmation" className="mt-4">
            <ActionRow
              testID="history-clear-confirm"
              icon="delete"
              label="Clear all history"
              detail="Tabs, archive and pins stay."
              destructive
              onPress={() => {
                setConfirming(false);
                onClear();
              }}
            />
            <ActionRow testID="history-clear-cancel" label="Keep history" onPress={() => setConfirming(false)} />
          </View>
        ) : (
          <View className="mt-4">
            <ActionRow testID="history-clear" icon="delete" label="Clear history" destructive onPress={() => setConfirming(true)} />
          </View>
        )
      ) : null}
    </PanelSheet>
  );
}
