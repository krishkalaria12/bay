import { View } from "@bay/platform";
import type { SearchScope } from "@bay/core";
import { Text } from "react-native";
import { useTheme } from "../../lib/theme";
import { Favicon } from "../primitives";
import type { ScopeColors } from "./scopeColors";

export function ScopeChip({ scope, large, colors }: { scope: SearchScope; large: boolean; colors?: ScopeColors | null }) {
  const theme = useTheme();
  return (
    <View
      style={{
        height: large ? 28 : 26,
        borderRadius: 8,
        paddingLeft: 7,
        paddingRight: 9,
        gap: 6,
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: colors?.background ?? theme.rowSelected,
      }}
    >
      <Favicon url={`https://${scope.host}`} size={14} />
      <Text numberOfLines={1} style={{ fontSize: large ? 15 : 14, fontWeight: "500", color: colors?.text ?? theme.textPrimary, maxWidth: 220 }}>
        {scope.name}
      </Text>
    </View>
  );
}
