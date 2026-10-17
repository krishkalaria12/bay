import { View, isMac, shortcutLabel } from "@bay/platform";
import { Text } from "react-native";
import { useTheme } from "../../lib/theme";

export function Keycaps({ hint }: { hint: string }) {
  const theme = useTheme();
  const label = shortcutLabel(hint);
  const keys = isMac
    ? Array.from(hint.replace(/\s/g, ""))
    : label.endsWith("++")
      ? [...label.slice(0, -1).split("+").filter(Boolean), "+"]
      : label.split("+").filter(Boolean);
  return (
    <View pointerEvents="none" style={{ flexDirection: "row", gap: 3 }}>
      {keys.map((key, i) => (
        <View
          key={i}
          style={{
            minWidth: 19,
            height: 20,
            paddingHorizontal: 4,
            borderRadius: 5,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.dark ? "#FFFFFF12" : "#00000009",
          }}
        >
          <Text style={{ fontSize: 12, color: theme.textSecondary }}>{key}</Text>
        </View>
      ))}
    </View>
  );
}
