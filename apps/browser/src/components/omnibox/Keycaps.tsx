import { Text, View } from "react-native";
import { useTheme } from "../../lib/theme";

export function Keycaps({ hint }: { hint: string }) {
  const theme = useTheme();
  return (
    <View pointerEvents="none" style={{ flexDirection: "row", gap: 3 }}>
      {Array.from(hint.replace(/\s/g, "")).map((key, i) => (
        <View key={i} style={{ minWidth: 20, height: 22, paddingHorizontal: 4, borderRadius: 5, alignItems: "center", justifyContent: "center", backgroundColor: theme.dark ? "#FFFFFF12" : "#00000009" }}>
          <Text style={{ fontSize: 13, color: theme.textSecondary }}>{key}</Text>
        </View>
      ))}
    </View>
  );
}
