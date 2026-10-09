import { Symbol, VisualEffect, WindowDragRegion } from "@bay/shell";
import { useEffect, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { trackSettingsSection } from "../../telemetry/track";
import { useHover } from "../primitives";
import { Button, useFormColors } from "./controls";
import { AdvancedPane } from "./panes/Advanced";
import { AppearancePane } from "./panes/Appearance";
import { CalendarPane } from "./panes/Calendar";
import { GeneralPane } from "./panes/General";
import { LinksPane } from "./panes/Links";
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
import { useSettingsSheet } from "./sheet";
import { useSettingsNav, type SettingsPane } from "./windows";
import { SETTINGS_TAB_BAR_HEIGHT, SETTINGS_TAB_MIN_WIDTH, SETTINGS_TITLE_HEIGHT } from "./constants";

// Arc's settings: a row of tabs across the top, each holding one or more panes. A tab with several panes picks
// between them with a segmented control at the top of its page.
type Tab = { title: string; icon: string; panes: { id: SettingsPane; title: string }[] };

const TABS: Tab[] = [
  { title: "Sync", icon: "arrow.triangle.2.circlepath", panes: [{ id: "sync", title: "Sync" }] },
  {
    title: "General",
    icon: "gearshape",
    panes: [
      { id: "general", title: "General" },
      { id: "search", title: "Search Engine" },
    ],
  },
  { title: "Spaces", icon: "square.stack", panes: [{ id: "spaces", title: "Spaces" }] },
  {
    title: "Appearance",
    icon: "circle.lefthalf.filled",
    panes: [
      { id: "appearance", title: "Appearance" },
      { id: "tabs", title: "Tabs" },
    ],
  },
  {
    title: "Privacy",
    icon: "hand.raised",
    panes: [
      { id: "privacy", title: "Privacy & Security" },
      { id: "passwords", title: "Passwords" },
      { id: "autofill", title: "Autofill" },
    ],
  },
  { title: "Shortcuts", icon: "keyboard", panes: [{ id: "shortcuts", title: "Shortcuts" }] },
  { title: "Links", icon: "macwindow.on.rectangle", panes: [{ id: "links", title: "Links" }] },
  {
    title: "Advanced",
    icon: "slider.horizontal.3",
    panes: [
      { id: "advanced", title: "Advanced" },
      { id: "extensions", title: "Extensions" },
      { id: "liveFolders", title: "Live Folders" },
      { id: "calendar", title: "Calendar" },
    ],
  },
];

const tabOf = (pane: SettingsPane) => TABS.find((t) => t.panes.some((p) => p.id === pane))!;

export function SettingsWindow() {
  const theme = useTheme();
  const nav = useSettingsNav();
  const profileName = useBrowser((s) => (nav.spaceId ? s.spaces[nav.spaceId]?.name : undefined));
  const tab = tabOf(nav.pane);
  const details = nav.pane === "spaces" && !!nav.spaceId;
  const title = details && profileName ? profileName : tab.title;
  const sheet = useSettingsSheet((s) => s.sheet);
  useEffect(() => trackSettingsSection(nav.pane), [nav.pane]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.dark ? "#1E1E1E" : "#ECECEC" }}>
      <View style={{ height: SETTINGS_TITLE_HEIGHT + SETTINGS_TAB_BAR_HEIGHT }}>
        <VisualEffect material="titlebar" blendingMode="behindWindow" style={StyleSheet.absoluteFill} />
        <WindowDragRegion style={StyleSheet.absoluteFill} />
        <View pointerEvents="none" style={{ height: SETTINGS_TITLE_HEIGHT, alignItems: "center", justifyContent: "center" }}>
          <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>
            {title}
          </Text>
        </View>
        <View style={{ flexDirection: "row", justifyContent: "center", gap: 2, paddingHorizontal: 12 }}>
          {TABS.map((t) => (
            <TabButton key={t.title} title={t.title} icon={t.icon} selected={t === tab} onPress={() => nav.go(t.panes[0]!.id)} />
          ))}
        </View>
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: StyleSheet.hairlineWidth * 2,
            backgroundColor: theme.dark ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.1)",
          }}
        />
      </View>
      <ScrollView key={`${nav.pane}:${nav.spaceId}`} contentContainerStyle={{ alignItems: "center", paddingBottom: 40 }}>
        <View style={{ width: "100%", maxWidth: 600, paddingHorizontal: 24 }}>
          <PaneHeader tab={tab} details={details} />
          <Pane pane={nav.pane} spaceId={nav.spaceId} />
        </View>
      </ScrollView>
      {sheet}
    </View>
  );
}

// Above the pane: the way back from a space's details, or the switcher between the tab's panes.
function PaneHeader({ tab, details }: { tab: Tab; details: boolean }) {
  const nav = useSettingsNav();
  if (details) {
    return (
      <View style={{ flexDirection: "row", marginTop: 18 }}>
        <Button title="All Spaces" kind="plain" icon="chevron.left" onPress={() => nav.go("spaces")} />
      </View>
    );
  }
  if (tab.panes.length < 2) return null;
  // Passwords and Autofill keep the space they were opened for.
  const profileFor = (pane: SettingsPane) => (pane === "passwords" || pane === "autofill" ? nav.spaceId : null);
  return (
    <View style={{ alignItems: "center", marginTop: 18 }}>
      <Segmented options={tab.panes} value={nav.pane} onChange={(pane) => nav.go(pane, profileFor(pane))} />
    </View>
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
    case "liveFolders":
      return <LiveFoldersPane />;
    case "calendar":
      return <CalendarPane />;
    case "advanced":
      return <AdvancedPane />;
  }
}

// A toolbar tab, as in Arc and the older macOS preference windows: the symbol over its name, tinted when chosen.
function TabButton({ title, icon, selected, onPress }: { title: string; icon: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  const { hovered, hoverProps } = useHover();
  const tint = selected ? colors.accent : theme.icon;
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>
        {({ pressed }) => (
          <View
            style={{
              minWidth: SETTINGS_TAB_MIN_WIDTH,
              height: 50,
              paddingHorizontal: 8,
              borderRadius: 7,
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
              backgroundColor: selected || pressed ? colors.selected : hovered ? colors.group : undefined,
            }}
          >
            <Symbol name={icon} size={17} color={tint} style={{ width: 24, height: 22 }} />
            <Text numberOfLines={1} style={{ fontSize: 11, color: selected ? colors.accent : theme.textSecondary }}>
              {title}
            </Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

function Segmented<T extends string>({ options, value, onChange }: { options: { id: T; title: string }[]; value: T; onChange: (value: T) => void }) {
  const theme = useTheme();
  const colors = useFormColors();
  return (
    <View
      style={{
        flexDirection: "row",
        padding: 2,
        borderRadius: 8,
        backgroundColor: theme.dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
      }}
    >
      {options.map((o) => {
        const selected = o.id === value;
        return (
          <Pressable key={o.id} onPress={() => onChange(o.id)}>
            <View
              style={{
                height: 22,
                paddingHorizontal: 14,
                borderRadius: 6,
                justifyContent: "center",
                backgroundColor: selected ? (theme.dark ? "rgba(255,255,255,0.16)" : "#FFFFFF") : undefined,
                borderWidth: selected && !theme.dark ? StyleSheet.hairlineWidth * 2 : 0,
                borderColor: colors.groupBorder,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: selected ? "500" : "400", color: selected ? theme.textPrimary : theme.textSecondary }}>{o.title}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
