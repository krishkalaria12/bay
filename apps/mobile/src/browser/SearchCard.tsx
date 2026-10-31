import type { SearchEngine } from "@bay/core/src/engines.ts";
import { displayUrl } from "@bay/core/src/suggest.ts";
import { useThemeColor } from "heroui-native";
import { useRef, useState, type ComponentRef, type JSX } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/chrome/Icon";
import { Surface } from "@/chrome/Surface";
import type { BrowserData } from "@/store/types";
import { resolveAddress } from "./address";
import { SiteIcon } from "./SiteIcon";
import { useSuggestions, type Row } from "./useSuggestions";

export type OpenTarget = { kind: "url"; url: string } | { kind: "tab"; id: string } | { kind: "archived"; id: string };

export interface SearchCardProps {
  /** The current page's address, selected so typing replaces it. Empty on a new tab. */
  initialText: string;
  engine: SearchEngine;
  data: BrowserData;
  onOpen: (target: OpenTarget) => void;
  onDismiss: () => void;
}

function targetFor(row: Row): OpenTarget {
  if (row.kind === "page" && row.tabId) return { kind: "tab", id: row.tabId };
  if (row.kind === "page" && row.cleanedId) return { kind: "archived", id: row.cleanedId };
  return { kind: "url", url: row.url };
}

export function SearchCard({ initialText, engine, data, onOpen, onDismiss }: SearchCardProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [query, setQuery] = useState(initialText);
  // No inline completion over a prefilled address, or straight after deleting.
  const [suppressed, setSuppressed] = useState(Boolean(initialText));
  const { rows, completion: suggested } = useSuggestions(query, engine, data, initialText);
  const completion = suppressed ? "" : suggested;
  const value = query + completion;

  const cardPosition = useAnimatedStyle(() => ({ bottom: Math.max(keyboard.height.value, insets.bottom) + 8 }));

  function change(next: string): void {
    if (completion && next === query) {
      setSuppressed(true); // Backspace removed the selected completion.
      return;
    }
    setSuppressed(next.length < query.length);
    setQuery(next);
  }

  function fill(text: string): void {
    setSuppressed(true);
    setQuery(text);
    input.current?.focus();
  }

  function submit(): void {
    const first = rows[0];
    if (completion && first) return onOpen(targetFor(first));
    const url = resolveAddress(query, engine);
    if (url) onOpen({ kind: "url", url });
  }

  const pins = data.pinnedSites.slice(0, 4);
  return (
    <View style={StyleSheet.absoluteFill} testID="search-card">
      <Pressable testID="search-dismiss" accessibilityLabel="Close search" style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <Animated.View style={[{ position: "absolute", left: 8, right: 8 }, cardPosition]}>
        <Surface radius={30} style={{ padding: 10 }}>
          <View className="flex-row items-center rounded-full border border-black/10 bg-white/60 pl-4 dark:border-white/10 dark:bg-white/10">
            <TextInput
              ref={input}
              testID="address-input"
              accessibilityLabel="Search or enter address"
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="web-search"
              returnKeyType="go"
              selectTextOnFocus={Boolean(initialText)}
              placeholder="Search or enter address"
              placeholderTextColor={muted}
              style={{ color: foreground, height: 46, fontSize: 17, flex: 1, minWidth: 0 }}
              value={value}
              selection={completion ? { start: query.length, end: value.length } : undefined}
              onChangeText={change}
              onSubmitEditing={submit}
            />
            {value ? (
              <Pressable
                testID="clear-address"
                accessibilityRole="button"
                accessibilityLabel="Clear"
                className="h-11 w-11 items-center justify-center"
                onPress={() => fill("")}
              >
                <Icon name="close" color={muted} size={20} />
              </Pressable>
            ) : (
              <View className="w-3" />
            )}
          </View>

          {pins.length && !query ? (
            <View className="mt-2.5 flex-row gap-2.5">
              {pins.map((site, index) => (
                <Pressable
                  key={site.id}
                  testID={`pinned-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={site.title || displayUrl(site.url)}
                  onPress={() => onOpen({ kind: "url", url: site.url })}
                  className="h-14 flex-1 items-center justify-center rounded-2xl bg-black/5 active:bg-black/10 dark:bg-white/10"
                >
                  <SiteIcon url={site.url} size={26} />
                </Pressable>
              ))}
              {Array.from({ length: 4 - pins.length }, (_, index) => (
                <View key={`empty-${index}`} className="flex-1" />
              ))}
            </View>
          ) : null}

          {rows.length ? (
            <View className="mt-1.5">
              {rows.map((row, index) => (
                <SuggestionRow key={`${row.kind}:${row.url}`} row={row} index={index} engine={engine} onOpen={() => onOpen(targetFor(row))} onFill={fill} />
              ))}
            </View>
          ) : null}
        </Surface>
      </Animated.View>
    </View>
  );
}

function rowText(row: Row, engine: SearchEngine): { title: string; detail: string } {
  switch (row.kind) {
    case "page": {
      const address = displayUrl(row.url);
      return { title: row.title || address, detail: row.tabId ? `Switch to tab · ${address}` : address };
    }
    case "search":
      return { title: row.query, detail: `Search ${engine.name}` };
    case "calc":
      return { title: `= ${row.value}`, detail: row.expression };
  }
}

function SuggestionRow({
  row,
  index,
  engine,
  onOpen,
  onFill,
}: {
  row: Row;
  index: number;
  engine: SearchEngine;
  onOpen: () => void;
  onFill: (text: string) => void;
}): JSX.Element {
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const { title, detail } = rowText(row, engine);
  return (
    <Pressable
      testID={`suggestion-${index}`}
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onOpen}
      className="min-h-[52px] flex-row items-center gap-3 rounded-2xl pl-2 active:bg-black/5"
    >
      <View className="w-7 items-center">{row.kind === "page" ? <SiteIcon url={row.url} /> : <Icon name="search" color={muted} size={20} />}</View>
      <View className="flex-1 py-1.5">
        <Text numberOfLines={1} style={{ color: foreground, fontSize: 16 }}>
          {title}
        </Text>
        <Text numberOfLines={1} style={{ color: muted, fontSize: 12.5 }}>
          {detail}
        </Text>
      </View>
      {row.kind !== "calc" ? (
        <Pressable
          testID={`suggestion-fill-${index}`}
          accessibilityRole="button"
          accessibilityLabel={`Fill in ${title}`}
          onPress={() => onFill(row.kind === "page" ? row.url : row.query)}
          className="h-11 w-11 items-center justify-center"
        >
          <Icon name="fill" color={muted} size={18} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}
