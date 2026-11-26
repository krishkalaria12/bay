import { Pressable, View } from "@bay/platform";
import { Symbol } from "@bay/desktop";
import { ScrollView, StyleSheet, Text } from "react-native";
import { create } from "zustand";
import { layout } from "../../lib/constants";
import { selectPluginViewItem } from "../../lib/plugins/pluginActions";
import { activePlugins, pluginKey, usePlugins } from "../../lib/plugins/pluginStore";
import type { ViewItem } from "../../lib/plugins/protocol";
import { useTheme } from "../../lib/theme";
import { reportBrowserCommand } from "../../runtime/commands";
import { newTab } from "../../runtime/tabActions";
import { useWindowId } from "../../store/hooks";
import { IconButton, useHover } from "../ui/primitives";

// A plugin's sidebar view (lib/plugins): a list the plugin fills (bay.views.set), beside the page as an extension's
// side panel is. Its rows open their address in a new tab, or tell the plugin they were chosen.

export const PLUGIN_PANEL_WIDTH = 320;
const HEADER = 40;

type Shown = { pluginId: string; viewId: string };

const usePanels = create<Record<string, Shown>>(() => ({}));

/** Opens a plugin's view in a window, or closes it when it's the one open there. */
export function togglePluginPanel(windowId: string, pluginId: string, viewId: string) {
  const shown = usePanels.getState()[windowId];

  if (shown?.pluginId === pluginId && shown.viewId === viewId) return closePluginPanel(windowId);
  usePanels.setState({ [windowId]: { pluginId, viewId } });
}

export function closePluginPanel(windowId: string) {
  usePanels.setState((s) => {
    const next = { ...s };
    delete next[windowId];

    return next;
  }, true);
}

export const pluginPanelOpen = (windowId: string, pluginId: string, viewId: string) => {
  const shown = usePanels.getState()[windowId];

  return shown?.pluginId === pluginId && shown.viewId === viewId;
};

export function PluginSidePanel() {
  const windowId = useWindowId();
  const shown = usePanels((s) => s[windowId]);
  // A plugin turned off takes its view with it.

  const view = usePlugins((s) => {
    const plugin = shown && activePlugins(s).find((p) => p.manifest.id === shown.pluginId);

    return plugin?.manifest.contributes.sidebarViews.find((v) => v.id === shown?.viewId) ?? null;
  });

  const items = usePlugins((s) => (shown ? s.views[pluginKey(shown.pluginId, shown.viewId)] : undefined));
  const theme = useTheme();

  if (!shown || !view) return null;

  return (
    <View style={{ width: PLUGIN_PANEL_WIDTH + layout.cardInset - 1, paddingLeft: layout.cardInset - 1 }}>
      <View style={{ flex: 1, borderRadius: layout.cardRadius, overflow: "hidden", backgroundColor: theme.card }}>
        <View style={{ height: HEADER, flexDirection: "row", alignItems: "center", paddingLeft: 12, paddingRight: 5, gap: 8 }}>
          <Symbol name={view.icon} size={13} color={theme.textSecondary} style={{ width: 16, height: 16 }} />
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: "500", color: theme.textPrimary }}>
            {view.title}
          </Text>
          <IconButton icon="xmark" size={12} weight="medium" tooltip="Close" onPress={() => closePluginPanel(windowId)} />
        </View>
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)" }} />
        <ScrollView contentContainerStyle={{ padding: 6 }}>
          {items?.length ? (
            items.map((item) => <ItemRow key={item.id} item={item} windowId={windowId} shown={shown} />)
          ) : (
            <Text style={{ fontSize: 12, margin: 10, color: theme.textSecondary }}>{items ? "Nothing here right now." : "Loading…"}</Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function ItemRow({ item, windowId, shown }: { item: ViewItem; windowId: string; shown: Shown }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();

  const choose = () => {
    if (item.url) reportBrowserCommand(newTab(windowId, { url: item.url }));
    else void selectPluginViewItem(shown.pluginId, shown.viewId, item.id).catch(() => {});
  };

  return (
    <View {...hoverProps} tooltip={item.url}>
      <Pressable onPress={choose}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 9,
            paddingHorizontal: 8,
            paddingVertical: 6,
            borderRadius: 7,
            backgroundColor: hovered ? (theme.dark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.05)") : undefined,
          }}
        >
          <Symbol name={item.icon ?? (item.url ? "link" : "circle")} size={12} color={theme.textSecondary} style={{ width: 16, height: 16 }} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ fontSize: 13, color: theme.textPrimary }}>
              {item.title}
            </Text>
            {item.subtitle ? (
              <Text numberOfLines={2} style={{ fontSize: 11.5, marginTop: 1, color: theme.textSecondary }}>
                {item.subtitle}
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>
    </View>
  );
}
