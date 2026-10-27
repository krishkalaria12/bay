import { hasWebKit } from "@bay/nncore";
import { Symbol, WindowDragRegion } from "@bay/shell";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { trackSettingsSection } from "../../telemetry/track";
import { useHover } from "../primitives";
import { Button, SettingsScroll } from "./controls";
import { AdvancedPane } from "./panes/Advanced";
import { AppearancePane } from "./panes/Appearance";
import { CalendarPane } from "./panes/Calendar";
import { GeneralPane } from "./panes/General";
import { LinksPane } from "./panes/Links";
import { EnginesPane } from "./panes/Engines";
import { LiveFoldersPane } from "./panes/LiveFolders";
import { ExtensionsPane } from "./panes/Extensions";
import { PasswordsPane } from "./panes/Passwords";
import { AutofillPane } from "./panes/Autofill";
import { PrivacyPane } from "./panes/Privacy";
import { SpaceDetailsPane, SpacesPane } from "./panes/Spaces";
import { SearchPane } from "./panes/Search";
import { ShortcutsPane } from "./panes/Shortcuts";
import { SyncPane } from "./panes/Sync";
import { TabsPane } from "./panes/Tabs";
import { findSettings, type SettingEntry } from "./search";
import type { SettingId } from "./definitions";
import { useSettingsSheet } from "./sheet";
import { useSettingsNav, type SettingsPane } from "./windows";
import { SETTINGS_SIDEBAR_WIDTH, SETTINGS_TOOLBAR_HEIGHT } from "./constants";

// yab's settings, as macOS's own: a sidebar of the panes (a search field over them, each with its colored icon), and
// the chosen pane beside it under back and forward.
type Item = { id: SettingsPane; title: string; icon: string; color: string; words: string };

const SECTIONS: Item[][] = [
  [
    { id: "general", title: "General", icon: "gearshape.fill", color: "#8E8E93", words: "default browser updates downloads quit login import" },
    { id: "search", title: "Search", icon: "magnifyingglass", color: "#0A84FF", words: "engine google suggestions" },
    { id: "appearance", title: "Appearance", icon: "circle.lefthalf.filled", color: "#5E5CE6", words: "theme dark light icon sidebar toolbar" },
    { id: "tabs", title: "Tabs", icon: "sidebar.left", color: "#30B0C7", words: "clean up archive new tab" },
    { id: "sync", title: "Sync", icon: "arrow.triangle.2.circlepath", color: "#34C759", words: "icloud devices recovery" },
    { id: "shortcuts", title: "Shortcuts", icon: "command", color: "#8E8E93", words: "keyboard keys" },
  ],
  [
    { id: "spaces", title: "Spaces", icon: "square.stack.fill", color: "#AF52DE", words: "profiles theme color pins" },
    { id: "liveFolders", title: "Live Folders", icon: "dot.radiowaves.left.and.right", color: "#FF9F0A", words: "github pull requests notion documents" },
    { id: "links", title: "Links", icon: "macwindow.on.rectangle", color: "#64D2FF", words: "little bay small window other apps" },
    ...(hasWebKit()
      ? [{ id: "engines" as const, title: "Engines", icon: "safari.fill", color: "#0A84FF", words: "webkit chromium netflix streaming drm protected video" }]
      : []),
    { id: "passwords", title: "Passwords", icon: "key.fill", color: "#8E8E93", words: "passkeys logins" },
    { id: "autofill", title: "Autofill", icon: "creditcard.fill", color: "#30D158", words: "addresses cards payment" },
    { id: "privacy", title: "Privacy", icon: "hand.raised.fill", color: "#0A84FF", words: "security cookies tracking permissions clear data ads" },
    { id: "extensions", title: "Extensions", icon: "puzzlepiece.extension.fill", color: "#BF5AF2", words: "chrome web store ublock" },
    { id: "calendar", title: "Calendar", icon: "calendar", color: "#FF453A", words: "meetings events" },
    { id: "advanced", title: "Advanced", icon: "slider.horizontal.3", color: "#636366", words: "developer diagnostics" },
  ],
];

const ITEMS = SECTIONS.flat();
const itemOf = (pane: SettingsPane) => ITEMS.find((i) => i.id === pane) ?? ITEMS[0]!;

export function SettingsWindow() {
  const theme = useTheme();
  const nav = useSettingsNav();
  const profileName = useBrowser((s) => (nav.spaceId ? s.spaces[nav.spaceId]?.name : undefined));
  const details = nav.pane === "spaces" && !!nav.spaceId;
  const title = details && profileName ? profileName : itemOf(nav.pane).title;
  const sheet = useSettingsSheet((s) => s.sheet);
  useEffect(() => trackSettingsSection(nav.pane), [nav.pane]);
  const scroll = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const scrollTo = useCallback((target: View) => {
    if (!content.current) return;
    target.measureLayout(
      content.current,
      (_x, y) => scroll.current?.scrollTo({ y: Math.max(0, y - 60), animated: true }),
      () => {},
    );
  }, []);

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.dark ? "#1E1E1E" : "#F2F2F2" }}>
      <SettingsSidebar />
      <View style={{ flex: 1 }}>
        <View style={{ height: SETTINGS_TOOLBAR_HEIGHT, flexDirection: "row", alignItems: "center", paddingHorizontal: 14, gap: 12 }}>
          <WindowDragRegion style={StyleSheet.absoluteFill} />
          <BackForward />
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: theme.textPrimary }}>
            {title}
          </Text>
        </View>
        <ScrollView ref={scroll} key={`${nav.pane}:${nav.spaceId}`} contentContainerStyle={{ alignItems: "center", paddingBottom: 40 }}>
          <View ref={content} style={{ width: "100%", maxWidth: 640, paddingHorizontal: 24 }}>
            {details ? (
              <View style={{ flexDirection: "row", marginTop: 6 }}>
                <Button title="All Spaces" kind="plain" icon="chevron.left" onPress={() => nav.go("spaces")} />
              </View>
            ) : null}
            <SettingsScroll.Provider value={scrollTo}>
              <Pane pane={nav.pane} spaceId={nav.spaceId} />
            </SettingsScroll.Provider>
          </View>
        </ScrollView>
      </View>
      {sheet}
    </View>
  );
}

function SettingsSidebar() {
  const theme = useTheme();
  const nav = useSettingsNav();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  // A search lists the panes it names first, then a few of the settings in them.
  const sections = q ? [ITEMS.filter((i) => i.title.toLowerCase().includes(q) || i.words.includes(q))] : SECTIONS;
  const settings = findSettings(q);
  // Passwords and Autofill keep the space they were opened for.
  const open = (pane: SettingsPane, highlight?: SettingId) => nav.go(pane, pane === "passwords" || pane === "autofill" ? nav.spaceId : null, highlight);
  const submit = () => {
    const pane = sections[0]?.[0];
    if (pane) open(pane.id);
    else if (settings[0]) open(settings[0].pane, settings[0].id);
  };
  return (
    <View
      style={{
        width: SETTINGS_SIDEBAR_WIDTH,
        backgroundColor: theme.dark ? "#2A2A2A" : "#E8E8E8",
        borderRightWidth: StyleSheet.hairlineWidth * 2,
        borderRightColor: theme.dark ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.08)",
      }}
    >
      <WindowDragRegion style={{ position: "absolute", left: 0, right: 0, top: 0, height: SETTINGS_TOOLBAR_HEIGHT }} />
      <View style={{ marginTop: SETTINGS_TOOLBAR_HEIGHT, paddingHorizontal: 10 }}>
        <View
          style={{
            height: 28,
            borderRadius: 8,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 8,
            backgroundColor: theme.dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
          }}
        >
          <Symbol name="magnifyingglass" size={12} color={theme.textSecondary} style={{ width: 14, height: 14 }} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={theme.placeholder}
            enableFocusRing={false}
            onSubmitEditing={submit}
            style={{ flex: 1, marginLeft: 6, fontSize: 13, color: theme.textPrimary, paddingVertical: 0 }}
          />
        </View>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 10, paddingTop: 10, paddingBottom: 16 }}>
        {sections.map((items, i) => (
          <View key={i} style={{ marginTop: i ? 18 : 0, gap: 2 }}>
            {items.map((item) => (
              <SidebarItem key={item.id} item={item} selected={item.id === nav.pane} onPress={() => open(item.id)} />
            ))}
          </View>
        ))}
        {settings.length ? (
          <View style={{ marginTop: sections[0]?.length ? 18 : 0, gap: 2 }}>
            <Text style={{ paddingHorizontal: 6, paddingBottom: 4, fontSize: 11, fontWeight: "600", color: theme.textTertiary }}>Settings</Text>
            {settings.map((entry) => (
              <SettingResult key={entry.id} entry={entry} onPress={() => open(entry.pane, entry.id)} />
            ))}
          </View>
        ) : null}
        {sections.every((items) => !items.length) && !settings.length ? (
          <Text style={{ padding: 8, fontSize: 12, color: theme.textTertiary }}>No Results</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SidebarItem({ item, selected, onPress }: { item: Item; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  // The chosen pane's row is filled; a hovered one, faintly.
  const ink = theme.dark ? "255,255,255" : "0,0,0";
  let fill: string | undefined;
  if (selected) fill = `rgba(${ink},${theme.dark ? 0.12 : 0.08})`;
  else if (hovered) fill = `rgba(${ink},${theme.dark ? 0.05 : 0.035})`;
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={item.title}>
        <View style={{ height: 30, borderRadius: 8, flexDirection: "row", alignItems: "center", paddingHorizontal: 6, gap: 9, backgroundColor: fill }}>
          <View style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: item.color, alignItems: "center", justifyContent: "center" }}>
            <Symbol name={item.icon} size={12} weight="semibold" color="#FFFFFF" style={{ width: 16, height: 16 }} />
          </View>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: selected ? "600" : "400", color: theme.textPrimary }}>
            {item.title}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

// A setting the search found: its title, under its pane's name.
function SettingResult({ entry, onPress }: { entry: SettingEntry; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const pane = itemOf(entry.pane);
  const ink = theme.dark ? "255,255,255" : "0,0,0";
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${entry.title}, ${pane.title}`}>
        <View
          style={{
            borderRadius: 8,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 6,
            paddingVertical: 5,
            gap: 9,
            backgroundColor: hovered ? `rgba(${ink},${theme.dark ? 0.05 : 0.035})` : undefined,
          }}
        >
          <View style={{ width: 22, height: 22, borderRadius: 6, backgroundColor: pane.color, alignItems: "center", justifyContent: "center", opacity: 0.85 }}>
            <Symbol name={pane.icon} size={12} weight="semibold" color="#FFFFFF" style={{ width: 16, height: 16 }} />
          </View>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={2} style={{ fontSize: 12.5, color: theme.textPrimary }}>
              {entry.title}
            </Text>
            <Text numberOfLines={1} style={{ fontSize: 11, color: theme.textTertiary }}>
              {pane.title}
            </Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

// yab's pair in a pill: the panes seen before and after this one.
function BackForward() {
  const theme = useTheme();
  const nav = useSettingsNav();
  const line = theme.dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)";
  return (
    <View style={{ height: 30, borderRadius: 15, flexDirection: "row", alignItems: "center", borderWidth: StyleSheet.hairlineWidth * 2, borderColor: line }}>
      <ArrowButton icon="chevron.left" label="Back" enabled={nav.back.length > 0} onPress={nav.goBack} />
      <View style={{ width: StyleSheet.hairlineWidth * 2, height: 16, backgroundColor: line }} />
      <ArrowButton icon="chevron.right" label="Forward" enabled={nav.forward.length > 0} onPress={nav.goForward} />
    </View>
  );
}

function ArrowButton({ icon, label, enabled, onPress }: { icon: string; label: string; enabled: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} disabled={!enabled} accessibilityLabel={label} tooltip={label}>
      {({ pressed }) => (
        <View style={{ width: 34, height: 28, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 }}>
          <Symbol name={icon} size={13} weight="semibold" color={enabled ? theme.textPrimary : theme.iconDisabled} style={{ width: 16, height: 16 }} />
        </View>
      )}
    </Pressable>
  );
}

function Pane({ pane, spaceId }: { pane: SettingsPane; spaceId: string | null }): ReactNode {
  switch (pane) {
    case "general":
      return <GeneralPane />;
    case "spaces":
      return spaceId ? <SpaceDetailsPane spaceId={spaceId} /> : <SpacesPane />;
    case "sync":
      return <SyncPane />;
    case "tabs":
      return <TabsPane />;
    case "appearance":
      return <AppearancePane />;
    case "privacy":
      return <PrivacyPane />;
    case "passwords":
      return <PasswordsPane spaceId={spaceId} />;
    case "autofill":
      return <AutofillPane spaceId={spaceId} />;
    case "extensions":
      return <ExtensionsPane />;
    case "search":
      return <SearchPane />;
    case "shortcuts":
      return <ShortcutsPane />;
    case "links":
      return <LinksPane />;
    case "engines":
      return hasWebKit() ? <EnginesPane /> : <GeneralPane />;
    case "liveFolders":
      return <LiveFoldersPane />;
    case "calendar":
      return <CalendarPane />;
    case "advanced":
      return <AdvancedPane />;
  }
}
