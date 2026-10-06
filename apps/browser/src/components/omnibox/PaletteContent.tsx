import { displayUrl, type Suggestion } from "@bay/core";
import { ContextMenuArea, Symbol } from "@bay/shell";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../../lib/theme";
import { useWindowId } from "../../store/hooks";
import { tourAnchorRef } from "../onboarding/tour/anchors";
import { useHover } from "../primitives";
import { modifiersOf } from "../layout/controls";
import { dispositionFor, type Disposition } from "./open";
import { Keycaps } from "./Keycaps";
import { PaletteActionMenu, type PaletteMenuAction } from "./PaletteActionMenu";
import { SuggestionIcon } from "./SuggestionRow";
import type { PaletteSection } from "./paletteStart";

export type PaletteMenu = { side: "left" | "right"; title: string; actions: PaletteMenuAction[] };

export function PaletteContent({ field, sections, selectedIndex, current, maxHeight, width, menu, onCloseMenu, onAppMenu, onRowMenu, onHover, onChoose, onSubmit }: {
  field: ReactNode;
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
  const listHeight = Math.max(72, maxHeight - 124);
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
  let index = 0;
  const label = current?.kind === "page" && current.tabId ? "Switch to Tab" : current?.kind === "action" ? current.title : current?.kind === "calc" ? "Copy Answer" : "Open";

  return (
    <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      <View ref={tourAnchorRef(windowId, "commandBar")} style={{ height: 72, flexDirection: "row", alignItems: "center", paddingHorizontal: 21, gap: 13 }}>
        <Symbol name="magnifyingglass" size={19} color={theme.textSecondary} style={{ width: 23, height: 23 }} />
        {field}
      </View>
      <ScrollView
        ref={scroll}
        style={{ maxHeight: listHeight, flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}
        keyboardShouldPersistTaps="always"
        onLayout={(e) => { viewport.current.height = e.nativeEvent.layout.height; keepSelectedVisible(); }}
        onScroll={(e) => { viewport.current.y = e.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
      >
        {sections.map((section, sectionIndex) => (
          <View key={section.title || "results"} onLayout={(e) => {
            const sectionY = e.nativeEvent.layout.y;
            const first = sections.slice(0, sectionIndex).reduce((count, s) => count + s.items.length, 0);
            section.items.forEach((_, offset) => rows.current.set(first + offset, { y: sectionY + (section.title ? 30 : 0) + offset * 40, height: 40 }));
            keepSelectedVisible();
          }} style={{ marginBottom: sectionIndex < sections.length - 1 ? 9 : 0 }}>
            {section.title ? <Text style={{ fontSize: 12, color: theme.textSecondary, height: 30, paddingTop: 9, paddingHorizontal: 8 }}>{section.title}</Text> : null}
            {section.items.map((suggestion) => {
              const rowIndex = index++;
              return <PaletteResultRow key={`${suggestion.kind}:${"id" in suggestion ? suggestion.id : suggestion.url}:${rowIndex}`} suggestion={suggestion} selected={rowIndex === selectedIndex} onHover={() => onHover(rowIndex)} onChoose={(disposition) => onChoose(suggestion, disposition)} onMenu={() => onRowMenu(suggestion)} />;
            })}
          </View>
        ))}
        {!sections.some((section) => section.items.length) ? <Text style={{ fontSize: 14, color: theme.textSecondary, padding: 16 }}>Type an address or search.</Text> : null}
      </ScrollView>
      <View style={{ height: 52, paddingHorizontal: 8, paddingBottom: 8, flexDirection: "row", alignItems: "center" }}>
        <FooterButton label="Bay menu" icon="line.3.horizontal" onPress={onAppMenu} round />
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 22, padding: 3, backgroundColor: theme.dark ? "#FFFFFF09" : "#00000006", borderWidth: 0.5, borderColor: theme.dark ? "#FFFFFF13" : "#0000000C" }}>
          <FooterButton label={label} hint="↩" onPress={onSubmit} />
          <FooterButton label="Actions" hint="⌘K" onPress={onRowMenu} />
        </View>
      </View>
      {menu ? (
        <>
          <Pressable accessibilityLabel="Close actions" onPress={onCloseMenu} style={[StyleSheet.absoluteFill, { borderRadius: 22 }]} />
          <PaletteActionMenu title={menu.title} actions={menu.actions} side={menu.side} width={Math.min(350, width - 16)} maxHeight={Math.min(height - 16, maxHeight - 16)} onClose={onCloseMenu} />
        </>
      ) : null}
    </View>
  );
}

function PaletteResultRow({ suggestion: s, selected, onHover, onChoose, onMenu }: {
  suggestion: Suggestion;
  selected: boolean;
  onHover(): void;
  onChoose(disposition: Disposition): void;
  onMenu(): void;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const title = s.kind === "page" ? s.title || displayUrl(s.url) : s.kind === "search" ? s.query : s.kind === "calc" ? s.value : s.title;
  const detail = s.kind === "page" ? displayUrl(s.url) : s.kind === "create" ? displayUrl(s.url) : s.kind === "calc" ? s.expression : "";
  return (
    <View onMouseEnter={() => { hoverProps.onMouseEnter(); onHover(); }} onMouseLeave={hoverProps.onMouseLeave}>
      <ContextMenuArea onContextMenu={onMenu}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${title}${s.kind === "page" && s.tabId ? ", switch to tab" : ""}`} accessibilityState={{ selected }} onPress={(e) => onChoose(dispositionFor(modifiersOf(e)))}>
        <View style={{ height: 40, flexDirection: "row", alignItems: "center", gap: 13, borderRadius: 11, paddingHorizontal: 11, backgroundColor: selected ? (theme.dark ? "#FFFFFF10" : "#0000000B") : hovered ? theme.rowHover : undefined }}>
          <SuggestionIcon suggestion={s} />
          <Text numberOfLines={1} style={{ flexShrink: 1, maxWidth: detail ? "53%" : "85%", fontSize: 14, color: theme.textPrimary }}>{title}</Text>
          {detail ? <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: theme.textSecondary }}>{detail}</Text> : <View style={{ flex: 1 }} />}
          {selected ? <Keycaps hint="↩" /> : s.kind === "action" && s.hint ? <Keycaps hint={s.hint} /> : null}
        </View>
      </Pressable>
      </ContextMenuArea>
    </View>
  );
}

function FooterButton({ label, icon, hint, onPress, round }: { label: string; icon?: string; hint?: string; onPress(): void; round?: boolean }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} tooltip={round ? "Bay menu" : undefined}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => onPress()}>
        <View style={{ height: 34, width: round ? 34 : undefined, borderRadius: 18, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: round ? 0 : 10, backgroundColor: hovered ? theme.rowHover : round ? (theme.dark ? "#FFFFFF0C" : "#00000006") : undefined, borderColor: theme.dark ? "#FFFFFF16" : "#00000010", borderWidth: round ? 0.5 : 0 }}>
          {icon ? <Symbol name={icon} size={15} color={theme.textSecondary} style={{ width: 18, height: 18 }} /> : <Text numberOfLines={1} style={{ color: theme.textPrimary, fontSize: 13 }}>{label}</Text>}
          {hint ? <Keycaps hint={hint} /> : null}
        </View>
      </Pressable>
    </View>
  );
}
