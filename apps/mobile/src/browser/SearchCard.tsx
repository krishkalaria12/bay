import type { SearchEngine } from "@bay/core/src/engines.ts";
import { displayUrl } from "@bay/core/src/suggest.ts";
import { startListening } from "@bay/engine";
import * as Clipboard from "expo-clipboard";
import { useThemeColor } from "heroui-native";
import { useEffect, useRef, useState, type ComponentRef, type JSX } from "react";
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text as Span, TextInput, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  FadeIn,
  interpolate,
  ReduceMotion,
  useAnimatedKeyboard,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/chrome/Icon";
import { SPRING, useReducedMotion } from "@/chrome/motion";
import { PressFeedback } from "@/chrome/PressFeedback";
import { searchSheet, searchSheetHeight, searchSheetRows } from "@/chrome/layout";
import { Text } from "@/chrome/Text";
import { iconSize, inputFont, radius, space } from "@/chrome/tokens";
import { useT, type Translate } from "@/i18n";
import type { BrowserData } from "@/store/types";
import { resolveAddress } from "./address";
import { SiteIcon } from "./SiteIcon";
import { siteName } from "./siteName";
import { useSuggestions, type Row } from "./useSuggestions";

export type OpenTarget = { kind: "url"; url: string } | { kind: "tab"; id: string } | { kind: "archived"; id: string };

export interface SearchCardProps {
  /** The current page's address, selected so typing replaces it. Empty on a new tab. */
  initialText: string;
  engine: SearchEngine;
  data: BrowserData;
  /** Offer the private toggle (false when the engine can't keep a private profile). */
  /** Start with private on, as when searching from a private tab. */
  initialPrivate: boolean;
  /** Starts listening as it opens: the widget's microphone (C7). */
  listenOnOpen?: boolean;
  onOpen: (target: OpenTarget, privately: boolean) => void;
  onDismiss: () => void;
}

function targetFor(row: Row): OpenTarget {
  if (row.kind === "page" && row.tabId) return { kind: "tab", id: row.tabId };

  if (row.kind === "page" && row.cleanedId) return { kind: "archived", id: row.cleanedId };

  return { kind: "url", url: row.url };
}

export function SearchCard({ initialText, engine, data, initialPrivate, listenOnOpen = false, onOpen: open, onDismiss }: SearchCardProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const t = useT();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [privately, setPrivately] = useState(initialPrivate);
  const onOpen = (target: OpenTarget): void => open(target, privately);
  // A private search card is dark in both themes, like Lens.
  const text = privately ? "#F4F4F5" : foreground;
  const secondary = privately ? "#A1A1AA" : muted;
  const [query, setQuery] = useState(initialText);
  // No inline completion over a prefilled address, or straight after deleting.
  const [suppressed, setSuppressed] = useState(Boolean(initialText));
  const [listening, setListening] = useState(false);
  const { rows, completion: suggested } = useSuggestions(query, engine, data, initialText);
  const completion = suppressed ? "" : suggested;
  // A prefilled address starts selected, so typing replaces it (as in Safari and Lens). selectTextOnFocus alone can
  // miss on iOS when typing starts as the card appears, appending to the address instead.
  const [addressSelected, setAddressSelected] = useState(Boolean(initialText));
  // The field holds only what was typed; an inline completion is drawn after it, not inserted into it. Inserting it
  // as selected text raced fast typing: a key pressed before the completion arrived was overwritten and lost.
  const selection = addressSelected ? { start: 0, end: query.length } : undefined;

  // The sheet sits on the keyboard (U4): full width, a fixed height that holds the field and four rows (fewer in
  // landscape), so it never jumps while typing. It reaches down behind the keyboard, so no gap opens while the
  // keyboard moves; its rows scroll inside it.
  const { height: screenHeight } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const event = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const subscription = Keyboard.addListener(event, (shown) => setKeyboardHeight(shown.endCoordinates.height));

    return () => subscription.remove();
  }, []);

  const rowsInView = keyboardHeight ? searchSheetRows(screenHeight, keyboardHeight, insets.top) : searchSheet.visibleRows;
  const sheetHeight = searchSheetHeight(rowsInView);
  const dragged = useSharedValue(0);

  const sheetPosition = useAnimatedStyle(() => ({
    height: Math.max(keyboard.height.get(), insets.bottom) + sheetHeight,
    transform: [{ translateY: dragged.get() }],
  }));

  // Swiping the sheet down puts it away; the keyboard leaves as the finger lets go.
  const drag = usePanGesture({
    activeOffsetY: [-1000, 12],
    failOffsetX: [-16, 16],
    onUpdate: (event) => {
      "worklet";
      dragged.set(Math.max(0, event.translationY));
    },
    onDeactivate: (event) => {
      "worklet";

      if (!event.canceled && (event.translationY > 80 || event.velocityY > 600)) {
        scheduleOnRN(dismiss);

        return;
      }

      dragged.set(withSpring(0, SPRING));
    },
  });

  function dismiss(): void {
    Keyboard.dismiss();
    onDismiss();
  }

  // The field grows out of the capsule it replaces (A2): the pill widens from the capsule's width to the field's,
  // and what is written in it comes in as it widens.
  const [fieldWidth, setFieldWidth] = useState(0);
  const grown = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    grown.set(withSpring(1, { ...SPRING, reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System }));
  }, [grown, reduced]);

  const pill = useAnimatedStyle(() => ({
    width: fieldWidth ? interpolate(grown.get(), [0, 1], [fieldWidth / 2, fieldWidth]) : fieldWidth,
    alignSelf: "center",
  }));

  const contents = useAnimatedStyle(() => ({ opacity: interpolate(grown.get(), [0.25, 1], [0, 1], Extrapolation.CLAMP) }));

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

  // Voice search (B16): asks the engine to listen once; what it hears replaces the field, like a paste.
  async function listen(): Promise<void> {
    if (listening) return;
    setListening(true);
    const text = await startListening().catch(() => null);
    setListening(false);

    if (text) fill(text);
  }

  // Opened from the widget's microphone: listen at once, as if the mic had been tapped.
  useEffect(() => {
    if (listenOnOpen) void listen();
    // Once, as the card opens.
  }, []);

  function submit(): void {
    const first = rows[0];

    if (completion && first) return onOpen(targetFor(first));
    const url = resolveAddress(query, engine);

    if (url) onOpen({ kind: "url", url });
  }

  // Paste and Go shows only while the clipboard holds text. Asking whether it does reads nothing: iOS doesn't ask for
  // paste permission and Android shows no "pasted" note, so it is checked as the card opens and whenever it changes.
  const [canPaste, setCanPaste] = useState(false);

  useEffect(() => {
    let open = true;

    const check = () => {
      Clipboard.hasStringAsync().then(
        (has) => open && setCanPaste(has),
        () => open && setCanPaste(false),
      );
    };

    check();
    const subscription = Clipboard.addClipboardListener(check);

    return () => {
      open = false;
      subscription.remove();
    };
  }, []);

  async function pasteAndGo(): Promise<void> {
    const url = await clipboardAddress(engine);

    if (url) onOpen({ kind: "url", url });
  }

  // The space's Essentials, as on the start page.
  const pins = data.pinnedSites.filter((site) => site.spaceId === data.activeSpaceId && site.kind === "essential").slice(0, 4);

  return (
    <View style={StyleSheet.absoluteFill} testID="search-card">
      {/* Dims what's behind, so the sheet and its suggestions stand clear of a busy page. */}
      <Animated.View entering={FadeIn.duration(SCRIM_FADE)} className="bg-black/20 dark:bg-black/45" style={StyleSheet.absoluteFill} pointerEvents="none" />
      <Pressable testID="search-dismiss" accessibilityRole="button" accessibilityLabel={t("search.close")} style={StyleSheet.absoluteFill} onPress={dismiss} />
      <Animated.View
        testID={privately ? "search-card-private" : undefined}
        className={privately ? "bg-neutral-900" : "bg-background"}
        style={[
          {
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            borderTopLeftRadius: searchSheet.cornerRadius,
            borderTopRightRadius: searchSheet.cornerRadius,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
          sheetPosition,
        ]}
      >
        <View style={{ height: sheetHeight }}>
          <GestureDetector gesture={drag}>
            <View style={{ paddingTop: searchSheet.topInset, paddingHorizontal: space.lg }}>
              <View
                className="relative"
                onLayout={(event) => {
                  const width = event.nativeEvent.layout.width;

                  if (width && width !== fieldWidth) setFieldWidth(width);
                }}
              >
                {/* The pill the capsule grows into (A2): it starts as wide as the capsule and widens into the field. */}
                <Animated.View
                  pointerEvents="none"
                  className={privately ? "absolute top-0 bottom-0 rounded-full bg-white/10" : "absolute top-0 bottom-0 rounded-full bg-default"}
                  style={pill}
                />
                <Animated.View style={[contents, { height: searchSheet.fieldHeight }]} className="flex-row items-center pl-4">
                  <View className="flex-1 justify-center" style={{ minWidth: 0 }}>
                    {completion ? (
                      <Text
                        testID="address-completion"
                        numberOfLines={1}
                        pointerEvents="none"
                        // The completion is read with the field's own value, not as a second line.
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={[inputTextStyle, { position: "absolute", left: 0, right: 0, top: 0, height: FIELD, lineHeight: FIELD, color: text }]}
                      >
                        {/* Spans: they take the line's font and colour from the text around them. */}
                        <Span style={{ color: "transparent" }}>{query}</Span>
                        <Span style={{ backgroundColor: privately ? "rgba(255,255,255,0.18)" : "rgba(10,132,255,0.22)" }}>{completion}</Span>
                      </Text>
                    ) : null}
                    <TextInput
                      ref={input}
                      testID="address-input"
                      accessibilityLabel={t("search.placeholder")}
                      autoFocus
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="web-search"
                      returnKeyType="go"
                      placeholder={t("search.placeholder")}
                      placeholderTextColor={secondary}
                      keyboardAppearance={privately ? "dark" : "default"}
                      // The field's height is fixed (U4): its text grows with the phone's text size only as far as it fits.
                      maxFontSizeMultiplier={1.4}
                      style={[inputTextStyle, { color: text, height: FIELD }]}
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
                      accessibilityLabel={t("search.clear")}
                      className="h-11 w-11 items-center justify-center"
                      onPress={() => fill("")}
                    >
                      <Icon name="close" color={secondary} size={iconSize.row} />
                    </Pressable>
                  ) : null}
                  <Pressable
                    testID="voice-search"
                    accessibilityRole="button"
                    accessibilityLabel={listening ? t("search.listening") : t("search.voice")}
                    accessibilityState={{ disabled: listening }}
                    disabled={listening}
                    className="h-11 w-11 items-center justify-center"
                    onPress={() => void listen()}
                  >
                    <Icon name="mic" color={listening ? (privately ? "#F4F4F5" : foreground) : secondary} size={iconSize.control} />
                  </Pressable>
                  <Pressable
                    testID="private-toggle"
                    accessibilityRole="switch"
                    accessibilityLabel={t("search.private")}
                    accessibilityState={{ checked: privately }}
                    className="h-11 w-11 items-center justify-center"
                    onPress={() => setPrivately((on) => !on)}
                  >
                    <Icon name="private" color={privately ? "#F4F4F5" : secondary} size={iconSize.control} />
                  </Pressable>
                </Animated.View>
              </View>
            </View>
          </GestureDetector>

          {/* The rows: four in view, more a scroll away. Taps reach a row while the keyboard stays up. */}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={{ flex: 1, marginTop: searchSheet.rowsTopGap }}
            contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: searchSheet.bottomInset }}
          >
            {privately ? (
              <Text
                testID="private-notice"
                accessibilityLiveRegion="polite"
                variant="footnote"
                color={secondary}
                style={{ marginTop: 2, marginLeft: space.lg }}
              >
                {t("search.privateNotice")}
              </Text>
            ) : null}

            {query || !canPaste ? null : (
              <Pressable
                testID="paste-and-go"
                accessibilityRole="button"
                accessibilityLabel={t("search.pasteAndGo")}
                onPress={() => {
                  void pasteAndGo();
                }}
                className="flex-row items-center active:bg-black/5 dark:active:bg-white/10"
                style={{ minHeight: 44, gap: space.md, paddingHorizontal: space.md, borderRadius: radius.control }}
              >
                <Icon name="copy" color={secondary} size={iconSize.row} />
                <Text variant="callout" color={text}>
                  {t("search.pasteAndGo")}
                </Text>
              </Pressable>
            )}

            {pins.length && !query ? (
              <View className="flex-row" style={{ marginTop: space.xs, marginHorizontal: space.sm, gap: space.sm }}>
                {pins.map((site, index) => (
                  <PressFeedback
                    key={site.id}
                    testID={`pinned-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={site.title || displayUrl(site.url)}
                    onPress={() => onOpen({ kind: "url", url: site.url })}
                    className={privately ? "flex-1 items-center bg-white/10" : "flex-1 items-center bg-default"}
                    style={{ gap: space.sm, paddingVertical: space.md, borderRadius: radius.tile }}
                  >
                    <SiteIcon url={site.url} size={iconSize.control} bare color={text} />
                    <Text variant="caption" color={text} numberOfLines={1} style={{ paddingHorizontal: space.xs }}>
                      {site.title || siteName(site.url)}
                    </Text>
                  </PressFeedback>
                ))}
                {Array.from({ length: 4 - pins.length }, (_, index) => (
                  <View key={`empty-${index}`} className="flex-1" />
                ))}
              </View>
            ) : null}

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
          </ScrollView>
        </View>
      </Animated.View>
    </View>
  );
}

// Shared by the field and its completion so the completion lines up after the typed text.
const SCRIM_FADE = 160;

const inputTextStyle = { ...inputFont("headline", "regular"), padding: 0, margin: 0 } as const;

/** The field's text line: the field less a hair, so its text sits in the middle. */
const FIELD = searchSheet.fieldHeight - 2;

/**
 * The clipboard's text as an address to open, or null when it holds none. It is read only when Paste and Go is tapped:
 * reading it as the card opens makes iOS ask for paste permission unprompted. No access reads as nothing; the field
 * still takes a typed or pasted address.
 */
async function clipboardAddress(engine: SearchEngine): Promise<string | null> {
  try {
    const text = (await Clipboard.getStringAsync()).trim();

    return text ? resolveAddress(text, engine) : null;
  } catch {
    return null;
  }
}

function rowText(row: Row, engine: SearchEngine, t: Translate) {
  switch (row.kind) {
    case "page": {
      const address = displayUrl(row.url);

      return { title: row.title || address, detail: row.tabId ? t("search.switchToTab", { address }) : address };
    }

    case "search":
      return { title: row.query, detail: t("search.withEngine", { engine: engine.name }) };
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
  const t = useT();
  const { title, detail } = rowText(row, engine, t);
  const fillText = row.kind === "page" ? row.url : row.kind === "search" ? row.query : null;

  return (
    <Pressable
      testID={`suggestion-${index}`}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${detail}`}
      // VoiceOver can't reach the fill button inside the row, so the row offers it as an action too.
      accessibilityActions={fillText === null ? undefined : [{ name: "fill", label: t("search.fillIn", { title }) }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "fill" && fillText !== null) onFill(fillText);
      }}
      onPress={onOpen}
      className="flex-row items-center gap-3 pl-2 active:bg-black/5 dark:active:bg-white/10"
      style={{ minHeight: searchSheet.rowHeight, borderRadius: radius.tile }}
    >
      <View className="w-7 items-center">{row.kind === "page" ? <SiteIcon url={row.url} /> : <Icon name="search" color={muted} size={iconSize.row} />}</View>
      <View className="flex-1 py-1.5">
        <Text numberOfLines={1} color={foreground}>
          {title}
        </Text>
        <Text numberOfLines={1} variant="footnote" color={muted}>
          {detail}
        </Text>
      </View>
      {row.kind !== "calc" ? (
        <Pressable
          testID={`suggestion-fill-${index}`}
          accessibilityRole="button"
          accessibilityLabel={t("search.fillIn", { title })}
          onPress={() => onFill(row.kind === "page" ? row.url : row.query)}
          className="h-11 w-11 items-center justify-center"
        >
          <Icon name="fill" color={muted} size={iconSize.small} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}
