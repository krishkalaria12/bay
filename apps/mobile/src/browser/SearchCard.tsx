import type { SearchEngine } from "@bay/core/src/engines.ts";
import { displayUrl } from "@bay/core/src/suggest.ts";
import * as Clipboard from "expo-clipboard";
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
  /** Offer the private toggle (false when the engine can't keep a private profile). */
  privateAvailable: boolean;
  /** Start with private on, as when searching from a private tab. */
  initialPrivate: boolean;
  onOpen: (target: OpenTarget, privately: boolean) => void;
  onDismiss: () => void;
}

function targetFor(row: Row): OpenTarget {
  if (row.kind === "page" && row.tabId) return { kind: "tab", id: row.tabId };

  if (row.kind === "page" && row.cleanedId) return { kind: "archived", id: row.cleanedId };

  return { kind: "url", url: row.url };
}

export function SearchCard({ initialText, engine, data, privateAvailable, initialPrivate, onOpen: open, onDismiss }: SearchCardProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [privately, setPrivately] = useState(initialPrivate && privateAvailable);
  const onOpen = (target: OpenTarget): void => open(target, privately);
  // A private search card is dark in both themes, like Lens.
  const text = privately ? "#F4F4F5" : foreground;
  const secondary = privately ? "#A1A1AA" : muted;
  const [query, setQuery] = useState(initialText);
  // No inline completion over a prefilled address, or straight after deleting.
  const [suppressed, setSuppressed] = useState(Boolean(initialText));
  const { rows, completion: suggested } = useSuggestions(query, engine, data, initialText);
  const completion = suppressed ? "" : suggested;
  // A prefilled address starts selected, so typing replaces it (as in Safari and Lens). selectTextOnFocus alone can
  // miss on iOS when typing starts as the card appears, appending to the address instead.
  const [addressSelected, setAddressSelected] = useState(Boolean(initialText));
  // The field holds only what was typed; an inline completion is drawn after it, not inserted into it. Inserting it
  // as selected text raced fast typing: a key pressed before the completion arrived was overwritten and lost.
  const selection = addressSelected ? { start: 0, end: query.length } : undefined;

  const cardPosition = useAnimatedStyle(() => ({ bottom: Math.max(keyboard.height.value, insets.bottom) + 8 }));

  function change(next: string): void {
    setAddressSelected(false);
    // Deleting shows what's left without completing it again.
    setSuppressed(next.length < query.length);
    setQuery(next);
  }

  function fill(text: string): void {
    setAddressSelected(false);
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

  // Read only when tapped: reading the clipboard as the card opens makes iOS ask for paste permission unprompted.
  async function pasteAndGo(): Promise<void> {
    try {
      const text = (await Clipboard.getStringAsync()).trim();
      const url = text ? resolveAddress(text, engine) : null;

      if (url) onOpen({ kind: "url", url });
    } catch {
      // No clipboard access: the field still takes a typed or pasted address.
    }
  }

  const pins = data.pinnedSites.slice(0, 4);

  return (
    <View style={StyleSheet.absoluteFill} testID="search-card">
      <Pressable testID="search-dismiss" accessibilityLabel="Close search" style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <Animated.View style={[{ position: "absolute", left: 8, right: 8 }, cardPosition]}>
        <Surface radius={30} style={{ padding: 10 }} testID={privately ? "search-card-private" : undefined}>
          {privately ? <View className="absolute inset-0 rounded-[30px] bg-neutral-900/95" pointerEvents="none" /> : null}
          <View
            className={
              privately
                ? "flex-row items-center rounded-full border border-white/10 bg-white/10 pl-4"
                : "flex-row items-center rounded-full border border-black/10 bg-white/60 pl-4 dark:border-white/10 dark:bg-white/10"
            }
          >
            <View className="flex-1 justify-center" style={{ minWidth: 0 }}>
              {completion ? (
                <Text
                  testID="address-completion"
                  numberOfLines={1}
                  pointerEvents="none"
                  style={[inputTextStyle, { position: "absolute", left: 0, right: 0, top: 0, height: 46, lineHeight: 46, color: text }]}
                >
                  <Text style={{ color: "transparent" }}>{query}</Text>
                  <Text style={{ backgroundColor: privately ? "rgba(255,255,255,0.18)" : "rgba(10,132,255,0.22)" }}>{completion}</Text>
                </Text>
              ) : null}
              <TextInput
                ref={input}
                testID="address-input"
                accessibilityLabel="Search or enter address"
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="web-search"
                returnKeyType="go"
                placeholder="Search or enter address"
                placeholderTextColor={secondary}
                keyboardAppearance={privately ? "dark" : "default"}
                style={[inputTextStyle, { color: text, height: 46 }]}
                value={query}
                selection={selection}
                onChangeText={change}
                onSubmitEditing={submit}
              />
            </View>
            {query ? (
              <Pressable
                testID="clear-address"
                accessibilityRole="button"
                accessibilityLabel="Clear"
                className="h-11 w-11 items-center justify-center"
                onPress={() => fill("")}
              >
                <Icon name="close" color={secondary} size={20} />
              </Pressable>
            ) : null}
            {privateAvailable ? (
              <Pressable
                testID="private-toggle"
                accessibilityRole="switch"
                accessibilityLabel="Private"
                accessibilityState={{ checked: privately }}
                className="h-11 w-11 items-center justify-center"
                onPress={() => setPrivately((on) => !on)}
              >
                <Icon name="private" color={privately ? "#F4F4F5" : secondary} size={22} />
              </Pressable>
            ) : (
              <View className="w-3" />
            )}
          </View>
          {privately ? (
            <Text testID="private-notice" style={{ color: secondary, fontSize: 13, marginTop: 8, marginLeft: 16 }}>
              You're browsing privately. Nothing you open here is saved.
            </Text>
          ) : null}

          {query ? null : (
            <Pressable
              testID="paste-and-go"
              accessibilityRole="button"
              accessibilityLabel="Paste and Go"
              onPress={() => {
                void pasteAndGo();
              }}
              className="mt-2 h-10 flex-row items-center gap-2 rounded-2xl px-3 active:bg-black/5 dark:active:bg-white/10"
            >
              <Icon name="copy" color={secondary} size={18} />
              <Text style={{ color: text, fontSize: 15 }}>Paste and Go</Text>
            </Pressable>
          )}

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
                <SuggestionRow
                  key={`${row.kind}:${row.url}`}
                  row={row}
                  index={index}
                  engine={engine}
                  colors={privately ? { text, secondary } : undefined}
                  onOpen={() => onOpen(targetFor(row))}
                  onFill={fill}
                />
              ))}
            </View>
          ) : null}
        </Surface>
      </Animated.View>
    </View>
  );
}

// Shared by the field and its completion so the completion lines up after the typed text.
const inputTextStyle = { fontSize: 17, padding: 0, margin: 0, includeFontPadding: false } as const;

function rowText(row: Row, engine: SearchEngine) {
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
  colors,
  onOpen,
  onFill,
}: {
  row: Row;
  index: number;
  engine: SearchEngine;
  /** Overrides for the private card. */
  colors?: { text: string; secondary: string };
  onOpen: () => void;
  onFill: (text: string) => void;
}): JSX.Element {
  const themeForeground = useThemeColor("foreground");
  const themeMuted = useThemeColor("muted");
  const foreground = colors?.text ?? themeForeground;
  const muted = colors?.secondary ?? themeMuted;
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
