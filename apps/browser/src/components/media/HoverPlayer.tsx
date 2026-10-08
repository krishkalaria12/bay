import { Surface } from "@bay/shell";
import { hex, layout, useTheme } from "../../lib/theme";
import { besideRow, useSidebarOnRight } from "../layout/windowLayout";
import { useBrowser } from "../../store/browser";
import { clickTab } from "../sidebar/actions";
import { dismissHover, hoverLeave, keepHover } from "../sidebar/hover";
import { measureRow, setSidebarUi, type Anchor } from "../sidebar/state";
import { useSidebarWidth } from "../sidebar/tokens";
import { MINI_PLAYER_HEIGHT, MINI_PLAYER_WIDTH, MiniPlayer } from "./MiniPlayer";
import { useMedia } from "./state";
import { useMediaTokens } from "./tokens";

export function useShowsMiniPlayer(tabId: string | undefined): boolean {
  const pinned = useBrowser((s) => !!tabId && !!s.tabs[tabId]?.pinned);
  const hasSession = useMedia((s) => {
    const session = tabId ? s.sessions[tabId] : undefined;
    return !!session && session.playbackState !== "none" && !!(session.title || session.artwork);
  });
  return pinned && hasSession;
}

export function HoverPlayer({ tabId, windowId, anchor, windowWidth }: { tabId: string; windowId: string; anchor: Anchor; windowWidth: number }) {
  const theme = useTheme();
  const tokens = useMediaTokens();
  const right = useSidebarOnRight();
  const sidebarWidth = useSidebarWidth(windowId);
  // Clear of the sidebar's inner edge, as a pinned tile's anchor can stop short of it.
  const left = right
    ? besideRow({ x: Math.min(anchor.x, windowWidth - sidebarWidth + layout.sidebarInset), width: 0 }, MINI_PLAYER_WIDTH, true)
    : Math.max(anchor.x + anchor.width, sidebarWidth - layout.sidebarInset) + 8;
  return (
    <Surface
      onMouseEnter={keepHover}
      onMouseLeave={hoverLeave}
      fill={tokens.background}
      cornerRadius={12}
      borderColor={hex(tokens.border)}
      borderWidth={0.5}
      shadowColor="#000000"
      shadowOpacity={theme.panelShadowOpacity * 0.8}
      shadowRadius={16}
      shadowOffset={[0, 6]}
      style={{ position: "absolute", left, top: Math.max(8, anchor.y - 6), width: MINI_PLAYER_WIDTH, height: MINI_PLAYER_HEIGHT }}
    >
      <MiniPlayer
        tabId={tabId}
        onBackToTab={() => {
          dismissHover();
          clickTab(windowId, tabId);
        }}
      />
    </Surface>
  );
}

if (__DEV__) {
  (globalThis as { nnMediaHover?: unknown }).nnMediaHover = async (windowId: string, tabId: string | null) => {
    if (!tabId) return setSidebarUi({ hover: null });
    const anchor = await measureRow(windowId, tabId);
    if (anchor) setSidebarUi({ hover: { windowId, kind: "tab", id: tabId, anchor } });
    return anchor;
  };
}
