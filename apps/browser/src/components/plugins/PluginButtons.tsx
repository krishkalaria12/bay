import { Pressable, View } from "@bay/platform";
import type { PluginManifest } from "@bay/chromium";
import { Symbol } from "@bay/desktop";
import { useMemo } from "react";
import { Text } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { runPluginCommandIn } from "../../lib/plugins/pluginActions";
import { activePlugins, pluginKey, usePlugins } from "../../lib/plugins/pluginStore";
import { EXTENSION_BUTTON } from "../extensions/constants";
import type { ToolbarPalette } from "../toolbar/colors";
import { useHover } from "../ui/primitives";
import { togglePluginPanel } from "./PluginPanel";

// Plugins' toolbar buttons (lib/plugins), beside the extensions': a command to run or a sidebar view to open, with
// the title and badge the plugin last set (bay.toolbar.set).

type Button = { pluginId: string; button: PluginManifest["contributes"]["toolbar"][number] };

export function usePluginButtons(): Button[] {
  // The entries themselves, which the store keeps until they change: a new list each render would never settle.
  const plugins = usePlugins(useShallow(activePlugins));

  return useMemo(() => plugins.flatMap((p) => p.manifest.contributes.toolbar.map((button) => ({ pluginId: p.manifest.id, button }))), [plugins]);
}

export function PluginButton({ pluginId, button, windowId, palette }: Button & { windowId: string; palette: ToolbarPalette }) {
  const state = usePlugins((s) => s.toolbar[pluginKey(pluginId, button.id)]);
  const { hovered, hoverProps } = useHover();
  const title = state?.title ?? button.title;

  const press = () => {
    if (button.view) togglePluginPanel(windowId, pluginId, button.view);
    else if (button.command) void runPluginCommandIn(windowId, pluginId, button.command, "toolbar").catch(() => {});
  };

  return (
    <View tooltip={title} {...hoverProps}>
      <Pressable onPress={press} accessibilityRole="button" accessibilityLabel={title}>
        {({ pressed }) => (
          <View
            style={{
              width: EXTENSION_BUTTON,
              height: EXTENSION_BUTTON,
              borderRadius: 7,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? palette.pressed : hovered ? palette.hover : undefined,
            }}
          >
            <Symbol name={button.icon} size={14} color={palette.icon} style={{ width: 18, height: 18 }} />
            {state?.badge ? (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  right: 1,
                  bottom: 3,
                  minWidth: 13,
                  height: 11,
                  paddingHorizontal: 2.5,
                  borderRadius: 3,
                  backgroundColor: "#5F6368",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text numberOfLines={1} style={{ fontSize: 8.5, lineHeight: 11, fontWeight: "700", color: "#FFFFFF" }}>
                  {state.badge}
                </Text>
              </View>
            ) : null}
          </View>
        )}
      </Pressable>
    </View>
  );
}
