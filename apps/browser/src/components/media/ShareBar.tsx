import { changeCaptureSource, stopCapture } from "@bay/nncore";
import { Symbol } from "@bay/shell";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { engineProfile } from "../../store/model";
import { browserIdOf } from "../extensions/state";
import { PromptButton } from "../layout/controls";
import { usePages } from "../layout/pageState";
import { useMedia, type TabShare } from "./state";
import { CAPTURE_RED } from "./tokens";
import { SHARE_BAR_HEIGHT, SHARE_END_MS } from "./constants";

const hostOf = (origin: string) => {
  try {
    return new URL(origin).hostname.replace(/^www\./, "") || origin;
  } catch {
    return origin;
  }
};

function useShareFor(tabId: string): [string, TabShare] | null {
  const shares = useMedia((m) => m.tabShares);
  const capturing = usePages((p) => Object.keys(shares).filter((id) => p.pages[id]?.mediaAccess?.screen).join(","));
  // The capturing tabs in this tab's engine profile, in order; null for a tab no page can share to.
  const capturers = useBrowser((s) => {
    const tab = s.tabs[tabId];
    if (!tab || !/^https?:|^file:/.test(tab.url)) return null;
    const profile = engineProfile(tab.profileId);
    return capturing
      .split(",")
      .filter((id) => {
        const owner = s.tabs[id];
        return !!owner && engineProfile(owner.profileId) === profile;
      })
      .join(",");
  });
  if (capturers === null) return null;
  for (const capturer of capturers ? capturers.split(",") : []) {
    const share = shares[capturer];
    if (share && !share.dismissed[tabId]) return [capturer, share];
  }
  return null;
}

export function noteTabShare(capturerTabId: string, capturedTabId: string, origin: string) {
  useMedia.setState((m) => ({ tabShares: { ...m.tabShares, [capturerTabId]: { capturedTabId, origin, dismissed: {} } } }));
}

export function startTabShareCleanup() {
  return usePages.subscribe((p, prev) => {
    if (p.pages === prev.pages) return;
    const shares = useMedia.getState().tabShares;
    const ended = Object.keys(shares).filter((id) => prev.pages[id]?.mediaAccess?.screen && !p.pages[id]?.mediaAccess?.screen);
    if (!ended.length) return;
    setTimeout(() => {
      const gone = ended.filter((id) => !usePages.getState().pages[id]?.mediaAccess?.screen);
      if (!gone.length) return;
      useMedia.setState((m) => {
        const next = { ...m.tabShares };
        for (const id of gone) delete next[id];
        return { tabShares: next };
      });
    }, SHARE_END_MS);
  });
}

// The engine moves this capturer's share only (each share has its own bar on every tab), and says whether it did.
async function shareInstead(capturer: string, tabId: string): Promise<boolean> {
  const ok = await changeCaptureSource(browserIdOf(capturer), browserIdOf(tabId));
  if (!ok) return false;
  useMedia.setState((m) => {
    const share = m.tabShares[capturer];
    return share ? { tabShares: { ...m.tabShares, [capturer]: { ...share, capturedTabId: tabId, dismissed: {} } } } : m;
  });
  return true;
}

// The NNCore acceptance run presses "Share This Tab Instead" as a click would.
if (__DEV__) (globalThis as { nnShareBar?: unknown }).nnShareBar = { shareInstead, tabShares: () => useMedia.getState().tabShares };

function dismiss(capturer: string, tabId: string) {
  useMedia.setState((m) => {
    const share = m.tabShares[capturer];
    return share ? { tabShares: { ...m.tabShares, [capturer]: { ...share, dismissed: { ...share.dismissed, [tabId]: true } } } } : m;
  });
}

export function ShareBar({ tabId }: { tabId: string }) {
  const theme = useTheme();
  const found = useShareFor(tabId);
  const height = useSharedValue(0);
  const visible = !!found;
  useEffect(() => {
    // A height: it pushes the page down.
    height.set(withTiming(visible ? SHARE_BAR_HEIGHT : 0, { duration: 180, easing: Easing.out(Easing.cubic) }));
  }, [visible]);
  const heightStyle = useAnimatedStyle(() => ({ height: height.get() }));
  // The last share shown stays while the bar closes.
  const [last, setLast] = useState(found);
  if (found && (found[0] !== last?.[0] || found[1] !== last[1])) setLast(found);
  const shown = found ?? last;
  const shownCapturer = shown?.[0];
  const pageOrigin = usePages((p) => (shownCapturer && p.pages[shownCapturer]?.security?.origin) || "");
  const capturerUrl = useBrowser((s) => (shownCapturer && s.tabs[shownCapturer]?.url) || "");
  if (!shown) return null;
  const [capturer, share] = shown;
  const isShared = share.capturedTabId === tabId;
  const host = hostOf(share.origin || pageOrigin || capturerUrl);
  return (
    <Animated.View style={[{ overflow: "hidden" }, heightStyle]}>
      <View
        style={{
          height: SHARE_BAR_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingLeft: 12,
          paddingRight: 8,
          borderBottomWidth: 0.5,
          borderBottomColor: theme.dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
        }}
      >
        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: CAPTURE_RED, alignItems: "center", justifyContent: "center" }}>
          <Symbol name="rectangle.inset.filled" size={9} weight="bold" color="#FFFFFF" style={{ width: 14, height: 14 }} />
        </View>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: theme.textSecondary }}>
          {"Sharing "}
          <Text style={{ fontWeight: "600", color: theme.textPrimary }}>{isShared ? "this tab" : "another tab"}</Text>
          {` with ${host}`}
        </Text>
        {isShared ? (
          <PromptButton title="Stop Sharing" onPress={() => void stopCapture(browserIdOf(capturer))} />
        ) : (
          <PromptButton title="Share This Tab Instead" primary onPress={() => void shareInstead(capturer, tabId)} />
        )}
        <PromptButton title="Dismiss" onPress={() => dismiss(capturer, tabId)} />
      </View>
    </Animated.View>
  );
}
