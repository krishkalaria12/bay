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

export const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const siteName = (url: string) => hostOf(url).replace(/^www\./, "");
/** A page's title, or its site when the title is missing or just an address. */
export const pageTitle = (title: string, url: string) => (!title || /^[a-z][a-z0-9+.-]*:\/\//i.test(title) ? siteName(url) : title);

export function HistoryPanel({ visible, onClose, history, onOpen, onRemove, onClear }: HistoryPanelProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);
  const needle = query.trim().toLowerCase();
  const matches = needle ? history.filter((entry) => entry.title.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle)) : history;
  const groups = groupByDay(matches.slice(0, SHOWN), Date.now(), (entry) => entry.lastVisit);

  return (
    <PanelSheet visible={visible} onClose={onClose} title="History" testID="history-screen" height="85%">
      <SearchField testID="history-search" value={query} onChange={setQuery} placeholder="Search history" />
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
              const title = pageTitle(entry.title, entry.url);
              return (
                <SiteRow
                  key={entry.url}
                  testID={`history-open-${entry.url}`}
                  removeTestID={`history-remove-${entry.url}`}
                  url={entry.url}
                  title={title}
                  detail={`${siteName(entry.url)} · ${time(entry.lastVisit)}`}
                  onPress={() => {
                    onClose();
                    onOpen(entry.url);
                  }}
                  onRemove={() => onRemove(entry.url)}
                  removeLabel={`Remove ${title} from history`}
                />
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

export function SearchField({
  testID,
  value,
  onChange,
  placeholder,
}: {
  testID: string;
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
}) {
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  return (
    <View className="mb-1 flex-row items-center gap-2 rounded-full bg-default px-4">
      <Icon name="search" color={muted} size={18} />
      <BottomSheetTextInput
        testID={testID}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={muted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={{ flex: 1, color: foreground, fontSize: 16, paddingVertical: 10 }}
      />
    </View>
  );
}

/** A site's icon, title and detail line that opens it, with a remove button. */
export function SiteRow(props: {
  testID: string;
  removeTestID: string;
  url: string;
  title: string;
  detail: string;
  onPress: () => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  return (
    <View className="min-h-14 flex-row items-center gap-3 border-b border-foreground/5">
      <Pressable
        testID={props.testID}
        accessibilityRole="button"
        accessibilityLabel={`Open ${props.title}`}
        onPress={props.onPress}
        className="flex-1 flex-row items-center gap-3 py-2 active:opacity-60"
      >
        <SiteIcon url={props.url} size={28} />
        <View className="flex-1">
          <Text numberOfLines={1} style={{ color: foreground, fontSize: 15 }}>
            {props.title}
          </Text>
          <Text numberOfLines={1} style={{ color: muted, fontSize: 12.5 }}>
            {props.detail}
          </Text>
        </View>
      </Pressable>
      <Pressable
        testID={props.removeTestID}
        accessibilityRole="button"
        accessibilityLabel={props.removeLabel}
        onPress={props.onRemove}
        className="h-11 w-11 items-center justify-center active:opacity-60"
      >
        <Icon name="close" color={muted} size={18} />
      </Pressable>
    </View>
  );
}
