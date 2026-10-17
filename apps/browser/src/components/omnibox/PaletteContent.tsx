import { ScrollView } from "@bay/platform";
import { Pressable, View } from "@bay/platform";
import { displayUrl, type Suggestion } from "@bay/core";
import { ContextMenuArea, Symbol } from "@bay/shell";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, Text } from "react-native";
import { Easing, ReduceMotion, runOnJS, useSharedValue, withTiming } from "@bay/platform/motion";
import { useTheme } from "../../lib/theme";
import { useWindowId } from "../../store/hooks";
import { tourAnchorRef } from "../onboarding/tour/anchors";
import { modifiersOf } from "../layout/controls";
import { dispositionFor, type Disposition } from "./open";
import { Keycaps } from "./Keycaps";
import { PaletteActionMenu, type PaletteMenuAction } from "./PaletteActionMenu";
import { useHover } from "../primitives";
import { SuggestionIcon } from "./SuggestionRow";
import { usePointerHover } from "./usePointerHover";
import type { PaletteSection, PaletteSuggestion } from "./paletteStart";

export type PaletteMenu = { side: "left" | "right"; title: string; actions: PaletteMenuAction[] };

const FIELD_HEIGHT = 58;
const FOOTER_HEIGHT = 44;
const ROW_HEIGHT = 38;
// As yab's: one height whatever it lists (room for about nine rows), the list scrolling inside, so the palette
// neither grows nor moves as you type.
const PALETTE_HEIGHT = 470;
const LIST_TOP = 6;
// A section's title over its rows (Recent Tabs, Frequent), as yab labels them.
const TITLE_HEIGHT = 26;

// Keeps a closed menu on screen while it animates out; `closing` is set until it's gone.
export function useMenuPresence<T>(menu: T | null) {
  const progress = useSharedValue(0);
  const [shown, setShown] = useState(menu);
  useEffect(() => {
    if (menu) setShown(menu);
    const timing = menu
      ? { duration: 170, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }
      : { duration: 110, easing: Easing.in(Easing.quad), reduceMotion: ReduceMotion.System };
    progress.set(withTiming(menu ? 1 : 0, timing, (finished) => {
      if (finished && !menu) runOnJS(setShown)(null);
    }));
  }, [menu, progress]);
  return { shown: menu ?? shown, progress, closing: !menu };
}

export function PaletteContent({ field, leadingIcon, pageContext = false, sections, selectedIndex, current, maxHeight, width, menu, onCloseMenu, onAppMenu, onRowMenu, onHover, onChoose, onSubmit }: {
  field: ReactNode;
  leadingIcon?: ReactNode;
  pageContext?: boolean;
  sections: PaletteSection[];
  selectedIndex: number;
  current: Suggestion | undefined;
  maxHeight: number;
  width: number;
  menu: PaletteMenu | null;
  onCloseMenu(): void;
  onAppMenu(): void;
  onRowMenu(s?: Suggestion): void;
  onHover(index: number): void;
  onChoose(s: Suggestion, disposition: Disposition): void;
  onSubmit(): void;
}) {
  const theme = useTheme();
  const windowId = useWindowId();
  const scroll = useRef<ScrollView>(null);
  const viewport = useRef({ height: 0, y: 0 });
  const rows = useRef(new Map<number, { y: number; height: number }>());
  const [height, setHeight] = useState(maxHeight);
  const presence = useMenuPresence(menu);
  const hover = usePointerHover(sections);
  const keepSelectedVisible = () => {
    const row = rows.current.get(selectedIndex);
    const visible = viewport.current;
    if (!row || !visible.height) return;
    const y = row.y < visible.y ? row.y : row.y + row.height > visible.y + visible.height ? row.y + row.height - visible.height : visible.y;
    if (visible.y !== y) {
      visible.y = y;
      scroll.current?.scrollTo({ y, animated: false });
    }
  };
  useEffect(keepSelectedVisible, [selectedIndex, sections]);
  // Each section's first row's index among all the rows.
  const firsts = sections.map((_, i) => sections.slice(0, i).reduce((count, s) => count + s.items.length, 0));
  const label = current?.kind === "page" && current.tabId ? "Switch to Tab" : current?.kind === "action" ? current.title : current?.kind === "calc" ? "Copy Answer" : "Open";

  return (
    <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)} style={{ height: Math.min(PALETTE_HEIGHT, maxHeight) }}>
      <View ref={tourAnchorRef(windowId, "commandBar")} style={{ height: FIELD_HEIGHT, flexDirection: "row", alignItems: "center", paddingHorizontal: 18, gap: 12 }}>
        {leadingIcon ?? <Symbol name="magnifyingglass" size={16} color={theme.textSecondary} style={{ width: 20, height: 20 }} />}
        {field}
      </View>
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 7, paddingTop: LIST_TOP, paddingBottom: 6 }}
        keyboardShouldPersistTaps="always"
        onLayout={(e) => { viewport.current.height = e.nativeEvent.layout.height; keepSelectedVisible(); }}
        onScroll={(e) => { viewport.current.y = e.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
      >
        {sections.map((section, sectionIndex) => {
          const titled = !!section.title && section.items.length > 0;
          return (
          <View key={section.id} onLayout={(e) => {
            const top = e.nativeEvent.layout.y + (titled ? TITLE_HEIGHT : 0);
            const first = firsts[sectionIndex]!;
            section.items.forEach((_, offset) => rows.current.set(first + offset, { y: top + offset * ROW_HEIGHT, height: ROW_HEIGHT }));
            keepSelectedVisible();
          }}>
            {titled ? (
              <Text style={{ height: TITLE_HEIGHT, paddingHorizontal: 10, paddingTop: sectionIndex > 0 ? 9 : 4, fontSize: 11, fontWeight: "500", color: theme.textTertiary }}>{section.title}</Text>
            ) : null}
            {section.items.map((suggestion, offset) => {
              const rowIndex = firsts[sectionIndex]! + offset;
              return <PaletteResultRow key={`${suggestion.kind}:${"id" in suggestion ? suggestion.id : suggestion.url}:${rowIndex}`} suggestion={suggestion} pageContext={pageContext} selected={rowIndex === selectedIndex} onHover={(e) => hover(e, () => onHover(rowIndex))} onChoose={(disposition) => onChoose(suggestion, disposition)} onMenu={() => onRowMenu(suggestion)} />;
            })}
          </View>
          );
        })}
        {!sections.some((section) => section.items.length) ? <Text style={{ fontSize: 13, color: theme.textSecondary, paddingHorizontal: 10, paddingVertical: 10 }}>Type an address or search.</Text> : null}
      </ScrollView>
      <View style={{ height: FOOTER_HEIGHT, paddingHorizontal: 7, paddingBottom: 7, flexDirection: "row", alignItems: "center" }}>
        <FooterButton label="Bay menu" icon="line.3.horizontal" onPress={onAppMenu} round />
        <View style={{ flex: 1 }} />
        {!pageContext && <View style={{ flexDirection: "row", alignItems: "center", gap: 2, borderRadius: 18, padding: 2, backgroundColor: theme.dark ? "#FFFFFF09" : "#00000006", borderWidth: 0.5, borderColor: theme.dark ? "#FFFFFF13" : "#0000000C" }}>
          <FooterButton label={label} hint="↩" onPress={onSubmit} />
          <FooterButton label="Actions" hint="⌘K" onPress={onRowMenu} />
        </View>}
      </View>
      {presence.shown ? (
        <>
          {menu ? <Pressable accessibilityLabel="Close actions" onPress={onCloseMenu} style={[StyleSheet.absoluteFill, { borderRadius: 22 }]} /> : null}
          <PaletteActionMenu key={`${presence.shown.side}:${presence.shown.title}`} title={presence.shown.title} actions={presence.shown.actions} side={presence.shown.side} width={Math.min(320, width - 16)} maxHeight={Math.min(height - 16, maxHeight - 16)} onClose={onCloseMenu} progress={presence.progress} closing={presence.closing} />
        </>
      ) : null}
    </View>
  );
}

function PaletteResultRow({ suggestion: s, pageContext, selected, onHover, onChoose, onMenu }: {
  suggestion: PaletteSuggestion;
  pageContext: boolean;
  selected: boolean;
  onHover(event: { nativeEvent: { pageX: number; pageY: number } }): void;
  onChoose(disposition: Disposition): void;
  onMenu(): void;
}) {
  const theme = useTheme();
  const title = s.kind === "page" ? s.title || displayUrl(s.url) : s.kind === "search" ? s.query : s.kind === "calc" ? s.value : s.title;
  const shownUrl = s.kind === "page" || s.kind === "create" ? displayUrl(s.url) : "";
  // The typed search names its engine, as yab's does ("how to  Google"); the engine's own suggestions don't.
  const engine = s.kind === "search" && !s.suggested ? s.engine : "";
  const detail = s.detail ?? (s.kind === "calc" ? s.expression : engine || (shownUrl !== title ? shownUrl : ""));
  return (
    <View onMouseEnter={onHover}>
      <ContextMenuArea onContextMenu={onMenu}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${title}${s.kind === "page" && s.tabId ? ", switch to tab" : ""}`} accessibilityState={{ selected }} onPress={(e) => onChoose(dispositionFor(modifiersOf(e)))}>
        <View style={{ height: ROW_HEIGHT, flexDirection: "row", alignItems: "center", gap: 11, borderRadius: 9, paddingHorizontal: 10, backgroundColor: selected ? (theme.dark ? "#FFFFFF10" : "#0000000B") : undefined }}>
          {pageContext ? <View style={{ width: 20, height: 20, borderRadius: 5, alignItems: "center", justifyContent: "center", backgroundColor: theme.toolbarHover, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.panelBorder }}><SuggestionIcon suggestion={s} /></View> : <SuggestionIcon suggestion={s} />}
          <Text numberOfLines={1} style={{ flexShrink: 1, maxWidth: detail ? "53%" : "85%", fontSize: 13, color: theme.textPrimary }}>{title}</Text>
          {detail ? <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: theme.textSecondary }}>{detail}</Text> : <View style={{ flex: 1 }} />}
          {s.kind === "action" && s.hint && pageContext ? <Keycaps hint={s.hint} /> : selected ? <Keycaps hint="↩" /> : s.kind === "action" && s.hint ? <Keycaps hint={s.hint} /> : null}
        </View>
      </Pressable>
      </ContextMenuArea>
    </View>
  );
}

export function FooterButton({ label, icon, hint, onPress, round }: { label: string; icon?: string; hint?: string; onPress(): void; round?: boolean }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} tooltip={round ? "Bay Menu  ⌘/" : undefined}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => onPress()}>
        <View style={{ height: 30, width: round ? 30 : undefined, borderRadius: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: round ? 0 : 9, backgroundColor: hovered ? theme.rowHover : round ? (theme.dark ? "#FFFFFF0C" : "#00000006") : undefined, borderColor: theme.dark ? "#FFFFFF16" : "#00000010", borderWidth: round ? 0.5 : 0 }}>
          {icon ? <Symbol name={icon} size={13} color={theme.textSecondary} style={{ width: 16, height: 16 }} /> : <Text numberOfLines={1} style={{ color: theme.textPrimary, fontSize: 12 }}>{label}</Text>}
          {hint ? <Keycaps hint={hint} /> : null}
        </View>
      </Pressable>
    </View>
  );
}
