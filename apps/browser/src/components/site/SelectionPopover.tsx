import { Surface, Symbol, VisualEffect } from "@bay/shell";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { hex, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { defaultSearchEngine } from "../../store/settings";
import { useHover } from "../primitives";
import { searchSelection, setPageSelection, shareSelectionQuote, usePageSelection, type ClickModifiers, type PageSelection } from "./selection";
import { SELECTION_POPOVER_GAP, SELECTION_POPOVER_HEIGHT, SELECTION_SHOW_DELAY_MS } from "./constants";

export function SelectionPopover({ tabId, zoom }: { tabId: string; zoom: number }) {
  const selection = usePageSelection((s) => s[tabId] ?? null);
  const [shown, setShown] = useState<PageSelection | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!selection) return setShown(null);
    const timer = setTimeout(() => setShown(selection), SELECTION_SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [selection]);
  useEffect(() => () => setPageSelection(tabId, null), [tabId]);
  if (!selection && !shown) return null;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} onLayout={(e) => setArea(e.nativeEvent.layout)}>
      {shown && area.width > 0 && <Bar key={`${shown.rect.x},${shown.rect.y}`} tabId={tabId} selection={shown} zoom={zoom} area={area} />}
    </View>
  );
}

function Bar({ tabId, selection, zoom, area }: { tabId: string; selection: PageSelection; zoom: number; area: { width: number; height: number } }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const appear = useSharedValue(0);
  useEffect(() => {
    appear.set(withTiming(1, { duration: 150, easing: Easing.out(Easing.cubic) }));
  }, []);
  const r = selection.rect;
  const top = r.y * zoom;
  const bottom = (r.y + r.height) * zoom;
  const above = top - SELECTION_POPOVER_GAP - SELECTION_POPOVER_HEIGHT >= 4;
  const measured = width > 0;
  const appearStyle = useAnimatedStyle(() => {
    const a = appear.get();
    return {
      opacity: measured ? a : 0,
      transform: [{ scale: interpolate(a, [0, 1], [0.94, 1]) }, { translateY: interpolate(a, [0, 1], [above ? 3 : -3, 0]) }],
    };
  }, [measured, above]);
  if (bottom < 0 || top > area.height) return null;
  const y = above
    ? top - SELECTION_POPOVER_GAP - SELECTION_POPOVER_HEIGHT
    : Math.min(bottom + SELECTION_POPOVER_GAP, area.height - SELECTION_POPOVER_HEIGHT - 4);
  const center = (r.x + r.width / 2) * zoom;
  const x = Math.max(8, Math.min(center - width / 2, area.width - width - 8));

  return (
    <Animated.View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[{ position: "absolute", left: x, top: y, transformOrigin: above ? "center bottom" : "center top" }, appearStyle]}
    >
      <Surface
        fill={hex(theme.dark ? "rgba(38,36,37,0.94)" : "rgba(252,251,252,0.96)")}
        cornerRadius={10}
        borderColor={hex(theme.dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)")}
        borderWidth={0.5}
        shadowColor="#000000"
        shadowOpacity={theme.dark ? 0.45 : 0.16}
        shadowRadius={14}
        shadowOffset={[0, 6]}
        style={{ height: SELECTION_POPOVER_HEIGHT, padding: 3, flexDirection: "row", alignItems: "center" }}
      >
        <VisualEffect material="menu" cornerRadius={10} style={StyleSheet.absoluteFill} />
        <View style={{ ...StyleSheet.absoluteFillObject, borderRadius: 10, backgroundColor: theme.dark ? "rgba(38,36,37,0.72)" : "rgba(252,251,252,0.7)" }} />
        <SearchButton tabId={tabId} text={selection.text} />
        <ShareQuoteButton tabId={tabId} />
      </Surface>
    </Animated.View>
  );
}

function ShareQuoteButton({ tabId }: { tabId: string }) {
  const theme = useTheme();
  const available = useBrowser((s) => /^https?:/.test(s.tabs[tabId]?.url ?? ""));
  const { hovered, hoverProps } = useHover();
  const [busy, setBusy] = useState(false);
  if (!available) return null;
  return (
    <View {...hoverProps} tooltip="Copy the selected text as a card and link">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Share Quote"
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void shareSelectionQuote(tabId).finally(() => setBusy(false));
        }}
      >
        {({ pressed }) => (
          <View
            style={{
              height: SELECTION_POPOVER_HEIGHT - 6,
              paddingHorizontal: 8,
              borderRadius: 7,
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              opacity: busy ? 0.5 : 1,
              backgroundColor:
                pressed || hovered ? (theme.dark ? `rgba(255,255,255,${pressed ? 0.12 : 0.07})` : `rgba(0,0,0,${pressed ? 0.1 : 0.06})`) : undefined,
            }}
          >
            <Symbol name="quote.bubble" size={12} weight="medium" color={theme.icon} style={{ width: 16, height: 16 }} />
            <Text style={{ fontSize: 13, fontWeight: "500", color: theme.textPrimary }}>Share Quote</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

function SearchButton({ tabId, text }: { tabId: string; text: string }) {
  const theme = useTheme();
  const engine = useBrowser((s) => defaultSearchEngine(s.settings).name);
  const { hovered, hoverProps } = useHover();
  const quoted = text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text;
  return (
    <View {...hoverProps} tooltip={`Search ${engine} for “${quoted.replace(/\s+/g, " ")}”`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Search ${engine}`}
        onPress={(e) => searchSelection(tabId, text, e.nativeEvent as unknown as ClickModifiers)}
      >
        {({ pressed }) => (
          <View
            style={{
              height: SELECTION_POPOVER_HEIGHT - 6,
              paddingLeft: 7,
              paddingRight: 9,
              borderRadius: 7,
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              backgroundColor:
                pressed || hovered ? (theme.dark ? `rgba(255,255,255,${pressed ? 0.12 : 0.07})` : `rgba(0,0,0,${pressed ? 0.1 : 0.06})`) : undefined,
            }}
          >
            <Symbol name="magnifyingglass" size={12} weight="medium" color={theme.icon} style={{ width: 16, height: 16 }} />
            <Text style={{ fontSize: 13, fontWeight: "500", color: theme.textPrimary }}>Search</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}
