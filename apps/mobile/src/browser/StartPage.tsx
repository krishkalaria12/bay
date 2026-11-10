import { hostOf } from "@bay/core/src/input.ts";
import { useThemeColor } from "heroui-native";
import { useRef, type JSX } from "react";
import { Text, View } from "react-native";

import { gridShift, tileArriving, tileLeaving, useReducedMotion } from "@/chrome/motion";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Surface } from "@/chrome/Surface";
import type { HistoryEntry, PinnedSite } from "@/store/types";
import { SiteIcon } from "./SiteIcon";

const PINS = 8;
const RECENT = 3;

export interface StartPageProps {
  pins: readonly PinnedSite[];
  history: readonly HistoryEntry[];
  onOpen: (url: string) => void;
  onUnpin: (site: PinnedSite) => void;
}

const siteName = (url: string) => hostOf(url).replace(/^www\./, "");

/** Pinned sites and the last few pages, over the wallpaper above "Tap to search". */
export function StartPage({ pins, history, onOpen, onUnpin }: StartPageProps): JSX.Element | null {
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  // Unpin when the finger lifts: removing the pressed tile mid-gesture made Android swallow the next tap (the toast's Undo).
  const unpinning = useRef<PinnedSite | null>(null);
  // A tile that is taken away leaves a gap; the rest close it (A5).
  const reduced = useReducedMotion();
  const shift = gridShift(reduced);
  const arriving = tileArriving();
  const leaving = tileLeaving();
  // History is kept newest first; show the latest page of each site that isn't pinned.
  const seen = new Set(pins.map((site) => siteName(site.url)));
  const recent: HistoryEntry[] = [];

  for (const entry of history) {
    if (recent.length === RECENT) break;
    const site = siteName(entry.url);

    if (seen.has(site)) continue;
    seen.add(site);
    recent.push(entry);
  }

  if (!pins.length && !recent.length) return null;

  return (
    <View testID="start-page" className="w-full gap-6 px-5">
      {pins.length ? (
        <View className="flex-row flex-wrap justify-center" style={{ rowGap: 16 }}>
          {pins.slice(0, PINS).map((site, index) => (
            <PressFeedback
              key={site.id}
              testID={`start-pin-${index}`}
              accessibilityRole="button"
              accessibilityLabel={`Open ${site.title || siteName(site.url)}`}
              accessibilityHint="Long press to unpin"
              onPress={() => onOpen(site.url)}
              onLongPress={() => {
                unpinning.current = site;
              }}
              onPressOut={() => {
                if (unpinning.current !== site) return;
                unpinning.current = null;
                onUnpin(site);
              }}
              className="w-1/4 items-center gap-1.5"
              layout={shift}
              entering={arriving}
              exiting={leaving}
            >
              <Surface radius={20} style={{ width: 60, height: 60, alignItems: "center", justifyContent: "center" }}>
                <SiteIcon url={site.url} size={30} />
              </Surface>
              <Text numberOfLines={1} style={{ color: foreground, fontSize: 12, maxWidth: 76 }}>
                {site.title || siteName(site.url)}
              </Text>
            </PressFeedback>
          ))}
        </View>
      ) : null}
      {recent.length ? (
        <Surface radius={22} style={{ paddingVertical: 4 }}>
          {recent.map((entry, index) => (
            <PressFeedback
              key={entry.url}
              testID={`start-recent-${index}`}
              accessibilityRole="button"
              accessibilityLabel={`Open ${entry.title || siteName(entry.url)}`}
              onPress={() => onOpen(entry.url)}
              className="min-h-12 flex-row items-center gap-3 px-4 py-2"
              layout={shift}
              entering={arriving}
              exiting={leaving}
            >
              <SiteIcon url={entry.url} size={22} />
              <View className="flex-1">
                <Text numberOfLines={1} style={{ color: foreground, fontSize: 15 }}>
                  {entry.title || siteName(entry.url)}
                </Text>
                <Text numberOfLines={1} style={{ color: muted, fontSize: 12.5 }}>
                  {siteName(entry.url)}
                </Text>
              </View>
            </PressFeedback>
          ))}
        </Surface>
      ) : null}
    </View>
  );
}
