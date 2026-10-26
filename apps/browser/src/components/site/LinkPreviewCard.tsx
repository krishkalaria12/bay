import { Surface, Symbol } from "@bay/shell";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { hex, useTheme } from "../../lib/theme";

import { useHover } from "../primitives";
import { copyLinkPreview, fetchLinkSummary, openLinkPreview, peekLinkPreview, setLinkPreview, useLinkPreview } from "./linkPreview";

export function LinkPreview({ tabId }: { tabId: string }) {
  const preview = useLinkPreview((s) => s[tabId] ?? null);
  const theme = useTheme();
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [area, setArea] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!preview) {
      setSummary("");
      return;
    }
    let live = true;
    setLoading(true);
    void fetchLinkSummary(preview.url).then((s) => {
      if (live) {
        setSummary(s);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [preview?.url]);

  if (!preview || area.width === 0) {
    return <View pointerEvents="box-none" style={StyleSheet.absoluteFill} onLayout={(e) => setArea(e.nativeEvent.layout)} />;
  }

  const { url, rect } = preview;
  const width = 320;
  const left = Math.max(8, Math.min(rect.x + rect.width + 8, area.width - width - 8));
  const top = Math.max(8, Math.min(rect.y, area.height - 180));

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} onLayout={(e) => setArea(e.nativeEvent.layout)}>
      <Surface
        style={{ position: "absolute", left, top, width, padding: 12 }}
        fill={hex(theme.panel)}
        cornerRadius={12}
        borderColor={hex(theme.panelBorder)}
        borderWidth={0.5}
        shadowColor="#000000"
        shadowOpacity={0.18}
        shadowRadius={16}
        shadowOffset={[0, 6]}
      >
        <Text numberOfLines={2} style={{ fontSize: 13, fontWeight: "600", color: theme.textPrimary, marginBottom: 6 }}>
          {loading ? "Loading preview…" : summary}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 11.5, color: theme.textSecondary, marginBottom: 8 }}>
          {url}
        </Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <ActionButton label="Open" icon="arrow.up.right" onPress={() => openLinkPreview(tabId, url)} />
          <ActionButton label="Peek" icon="eye" onPress={() => peekLinkPreview(tabId, url)} />
          <ActionButton label="Copy" icon="link" onPress={() => copyLinkPreview(tabId, url)} />
          <ActionButton label="Close" icon="xmark" onPress={() => setLinkPreview(tabId, null)} />
        </View>
      </Surface>
    </View>
  );
}

function ActionButton({ label, icon, onPress }: { label: string; icon: string; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: hovered ? theme.rowHover : undefined,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Symbol name={icon} size={11} color={theme.textSecondary} style={{ width: 13, height: 13 }} />
          <Text style={{ fontSize: 12, color: theme.textPrimary }}>{label}</Text>
        </View>
      </Pressable>
    </View>
  );
}
