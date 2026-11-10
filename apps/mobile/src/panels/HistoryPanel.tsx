import { hostOf } from "@bay/core/src/input.ts";
import { BottomSheetTextInput, useBottomSheetScrollableCreator } from "@gorhom/bottom-sheet";
import { LegendList } from "@legendapp/list/react-native";
import { Typography, useThemeColor } from "heroui-native";
import { useState, type JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { Icon } from "@/chrome/Icon";
import { SPRING } from "@/chrome/motion";
import { PressFeedback } from "@/chrome/PressFeedback";
import { SiteIcon } from "@/browser/SiteIcon";
import type { HistoryEntry } from "@/store/types";
import { groupByDay } from "./historyGroups";
import { ActionRow, PanelSheet, SectionLabel } from "./PanelSheet";

const SHOWN = 200;

/** How far a row is swiped before it is removed, and how fast a flick has to be to count (A7). */
const REMOVE_DISTANCE = 96;
const REMOVE_WIDTH = 400;
const REMOVE_VELOCITY = -900;

const styles = StyleSheet.create({
  cover: {
    position: "absolute",
    right: 20,
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
});

type Row = { kind: "label"; label: string } | { kind: "entry"; entry: HistoryEntry };

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
  const insets = useSafeAreaInsets();
  const Scrollable = useBottomSheetScrollableCreator();
  const needle = query.trim().toLowerCase();
  const matches = needle ? history.filter((entry) => entry.title.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle)) : history;
  const groups = groupByDay(matches.slice(0, SHOWN), Date.now(), (entry) => entry.lastVisit);

  const rows: Row[] = groups.flatMap((group) => [
    { kind: "label" as const, label: group.label },
    ...group.entries.map((entry) => ({ kind: "entry" as const, entry })),
  ]);

  function clearFooter(): JSX.Element | null {
    if (!history.length) return null;

    return confirming ? (
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
    );
  }

  return (
    <PanelSheet visible={visible} onClose={onClose} title="History" testID="history-screen" height="85%" listMode>
      {history.length === 0 ? (
        <>
          <SearchField testID="history-search" value={query} onChange={setQuery} placeholder="Search history" />
          <View testID="history-empty" className="py-12">
            <Typography className="text-center">No history yet</Typography>
            <Typography className="mt-2 text-center text-sm text-muted">Pages you visit show up here. Private tabs never do.</Typography>
          </View>
        </>
      ) : groups.length === 0 ? (
        <>
          <SearchField testID="history-search" value={query} onChange={setQuery} placeholder="Search history" />
          <Typography testID="history-no-matches" className="py-8 text-center text-muted">
            Nothing matches “{query.trim()}”
          </Typography>
          {clearFooter()}
        </>
      ) : (
        <LegendList
          data={rows}
          keyExtractor={(row) => (row.kind === "label" ? `label-${row.label}` : row.entry.url)}
          estimatedItemSize={56}
          keyboardShouldPersistTaps="handled"
          renderScrollComponent={Scrollable}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 20) + 12 }}
          ListHeaderComponent={<SearchField testID="history-search" value={query} onChange={setQuery} placeholder="Search history" />}
          ListFooterComponent={clearFooter()}
          renderItem={({ item }) => {
            if (item.kind === "label") return <SectionLabel>{item.label}</SectionLabel>;
            const entry = item.entry;
            const title = pageTitle(entry.title, entry.url);

            return (
              <SiteRow
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
          }}
          style={{ flex: 1 }}
        />
      )}
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
  const danger = useThemeColor("danger");
  // How far the row goes when it is swiped away, and how far it has to go to count.
  const offset = useSharedValue(0);

  const pan = usePanGesture({
    // Sideways only: a vertical drag scrolls the list, and a tap still opens the page.
    activeOffsetX: [-18, 18],
    failOffsetY: [-14, 14],
    onUpdate: (event) => {
      "worklet";
      // The row only goes left, where the remove button waits.
      offset.value = Math.min(0, event.translationX);
    },
    onDeactivate: (event) => {
      "worklet";

      if (!event.canceled && (offset.value < -REMOVE_DISTANCE || event.velocityX < -REMOVE_VELOCITY)) {
        offset.value = withTiming(-REMOVE_WIDTH, { duration: 160 }, (finished) => {
          if (finished) scheduleOnRN(props.onRemove);
        });

        return;
      }

      offset.value = withSpring(0, SPRING);
    },
  });

  const row = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  const cover = useAnimatedStyle(() => ({ opacity: interpolate(-offset.value, [0, REMOVE_DISTANCE], [0, 1], Extrapolation.CLAMP) }));

  return (
    <View className="relative">
      {/* What the swipe uncovers. */}
      <Animated.View pointerEvents="none" style={[styles.cover, cover]}>
        <Icon name="delete" color={danger} size={20} />
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={row}>
          <View className="min-h-14 flex-row items-center gap-3 border-b border-foreground/5">
            <PressFeedback
              testID={props.testID}
              accessibilityRole="button"
              accessibilityLabel={`Open ${props.title}`}
              onPress={props.onPress}
              className="flex-1 flex-row items-center gap-3 py-2"
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
            </PressFeedback>
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
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
