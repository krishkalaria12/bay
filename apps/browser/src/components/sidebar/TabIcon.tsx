import { View } from "@bay/platform";
import { Symbol } from "@bay/shell";
import { memo } from "react";
import { Text } from "react-native";
import { useIsSleeping } from "../../lib/tabLifecycle";
import { useTheme } from "../../lib/theme";
import { useBrowserRead as useBrowser } from "../../store/read";
import { engineMark, ENGINE_NAMES, ENGINE_SYMBOLS } from "../../store/engines";
import { Favicon } from "../primitives";
import { SYMBOL_PREFIX } from "../../lib/constants";
import { iconColor } from "../symbolColors";
import { useSidebarMetrics } from "./tokens";
import { SLEEPING_OPACITY } from "./constants";

// Memoized: rows re-render on hover and selection, and the icon's props rarely change.
export const TabIcon = memo(function TabIcon({
  tabId,
  url,
  favicon,
  icon,
  size,
  color,
  spaceId: profile,
  direct,
}: {
  tabId?: string;
  url: string;
  favicon?: string | null;
  icon?: string | null;
  size?: number;
  color?: string;
  spaceId?: string;
  direct?: boolean;
}) {
  const metrics = useSidebarMetrics();
  const iconSize = size ?? metrics.iconSize;
  const sleeping = useIsSleeping(tabId ?? "");
  const props = { url, favicon, icon, size: iconSize, color, direct };
  return (
    <View style={{ opacity: sleeping ? SLEEPING_OPACITY : 1 }}>
      {profile || !tabId ? <Icon {...props} spaceId={profile} /> : <TabSpaceIcon {...props} tabId={tabId} />}
      {tabId && iconSize >= 14 ? <EngineMark tabId={tabId} size={iconSize} /> : null}
    </View>
  );
});

// A tab whose page runs in the other engine (store/engines.ts) wears that engine's mark on its icon.
function EngineMark({ tabId, size }: { tabId: string; size: number }) {
  const theme = useTheme();
  const mark = useBrowser((s) => engineMark(s, tabId));
  if (!mark) return null;
  const box = Math.round(size * 0.6);
  return (
    <View
      pointerEvents="none"
      accessibilityLabel={`Opens in ${ENGINE_NAMES[mark]}`}
      style={{
        position: "absolute",
        right: -box / 3,
        bottom: -box / 3,
        width: box,
        height: box,
        borderRadius: box / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.dark ? "#2C2C2E" : "#FFFFFF",
      }}
    >
      <Symbol name={ENGINE_SYMBOLS[mark]} size={box - 3} weight="semibold" color={theme.icon} style={{ width: box, height: box }} />
    </View>
  );
}

// Looks the tab's profile up only when the caller didn't pass it: a subscription per icon adds up in
// the sidebar, where every row runs its selectors on every store update.
function TabSpaceIcon({ tabId, ...props }: Omit<Parameters<typeof Icon>[0], "spaceId"> & { tabId: string }) {
  const spaceId = useBrowser((s) => s.tabs[tabId]?.spaceId);
  return <Icon {...props} spaceId={spaceId} />;
}

function Icon({
  url,
  favicon,
  icon,
  size = 16,
  color,
  spaceId,
  direct,
}: {
  url: string;
  favicon?: string | null;
  icon?: string | null;
  size?: number;
  color?: string;
  spaceId?: string;
  direct?: boolean;
}) {
  const theme = useTheme();
  if (icon?.startsWith(SYMBOL_PREFIX)) {
    // A chosen symbol keeps its colour; `color` is for the plain ones (a folder's own).
    const own = color ? undefined : iconColor(icon, theme.dark);
    return (
      <Symbol
        name={icon.slice(SYMBOL_PREFIX.length)}
        size={size - 3}
        weight="medium"
        color={own ?? color ?? theme.icon}
        rendering={own ? "hierarchical" : undefined}
        style={{ width: size, height: size }}
      />
    );
  }
  if (icon) {
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: size - 3, lineHeight: size }}>{icon}</Text>
      </View>
    );
  }
  return <Favicon url={url} favicon={favicon} size={size} spaceId={spaceId} direct={direct} />;
}
