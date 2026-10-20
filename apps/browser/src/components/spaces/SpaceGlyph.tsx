import { Symbol } from "@bay/shell";
import { Text } from "react-native";
import { useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { iconColor } from "../symbolColors";
import { profileSymbol } from "./icons";

/** A space's icon as the sidebar draws it: its symbol (in its color), its emoji, or its name's initial. */
export function SpaceGlyph({ spaceId, size }: { spaceId: string; size: number }) {
  const theme = useTheme();
  const profile = useBrowser((s) => s.spaces[spaceId]);
  if (!profile) return null;
  const ink = theme.dark ? "#FFFFFF" : "#000000";
  const symbol = profileSymbol(profile.icon);
  if (symbol) {
    return (
      <Symbol
        name={symbol}
        size={size - 2}
        weight="semibold"
        color={iconColor(profile.icon, theme.dark) ?? ink}
        rendering="hierarchical"
        style={{ width: size + 2, height: size + 2 }}
      />
    );
  }
  return (
    <Text style={{ fontSize: profile.icon ? size : Math.round(size * 0.8), fontWeight: "700", color: ink }}>
      {profile.icon ?? (profile.name.trim()[0] ?? "?").toUpperCase()}
    </Text>
  );
}
