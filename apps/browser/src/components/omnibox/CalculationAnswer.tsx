import type { Suggestion } from "@bay/core";
import { Symbol } from "@bay/shell";
import { Text, View } from "react-native";
import { useTheme } from "../../lib/theme";
import { Keycaps } from "./Keycaps";

export function CalculationAnswer({ suggestion: s, selected }: { suggestion: Extract<Suggestion, { kind: "calc" }>; selected: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 9,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.toolbarHover,
        }}
      >
        <Symbol name={s.detail ? "arrow.left.arrow.right" : "equal"} size={17} color={theme.textSecondary} style={{ width: 20, height: 20 }} />
      </View>
      <View tooltip={s.detail} style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: theme.textSecondary }}>
          {s.expression}
        </Text>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.65}
          style={{ fontSize: 24, lineHeight: 29, fontWeight: "600", fontVariant: ["tabular-nums"], color: theme.textPrimary }}
        >
          {s.value}
        </Text>
        {s.detail ? (
          <Text numberOfLines={1} style={{ fontSize: 11, lineHeight: 15, color: theme.textSecondary }}>
            {s.detail}
          </Text>
        ) : null}
      </View>
      <View tooltip="Copy answer" style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Symbol name="doc.on.doc" size={13} color={theme.textSecondary} style={{ width: 16, height: 18 }} />
        {selected ? <Keycaps hint="↩" /> : null}
      </View>
    </View>
  );
}
