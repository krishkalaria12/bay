import { useRef, type JSX } from "react";
import { View } from "react-native";

import { gridShift, tileArriving, tileLeaving, useReducedMotion } from "@/chrome/motion";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Surface } from "@/chrome/Surface";
import { Text } from "@/chrome/Text";
import { radius, rowHeight, space } from "@/chrome/tokens";
import { useT } from "@/i18n";
import type { HistoryEntry, PinnedSite } from "@/store/types";
import { SiteIcon } from "./SiteIcon";
import { siteName } from "./siteName";

const PINS = 8;
const PIN_TILE = 60;
const RECENT = 3;

export interface StartPageProps {
  pins: readonly PinnedSite[];
  history: readonly HistoryEntry[];
  onOpen: (url: string) => void;
  onUnpin: (site: PinnedSite) => void;
}

/** Pinned sites and the last few pages, over the wallpaper above "Tap to search". */
export function StartPage({ pins, history, onOpen, onUnpin }: StartPageProps): JSX.Element | null {
  const t = useT();
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
    // Touches between the tiles fall through to the start screen behind, which opens search.
    <View testID="start-page" className="w-full gap-6 px-5" pointerEvents="box-none">
      {pins.length ? (
        <View className="flex-row flex-wrap justify-center" style={{ rowGap: 16 }} pointerEvents="box-none">
          {pins.slice(0, PINS).map((site, index) => (
            <PressFeedback
              key={site.id}
              testID={`start-pin-${index}`}
              accessibilityRole="button"
              accessibilityLabel={t("start.openSite", { name: site.title || siteName(site.url) })}
              accessibilityHint={t("start.longPressToUnpin")}
              onPress={() => onOpen(site.url)}
              onLongPress={() => {
                unpinning.current = site;
              }}
              onPressOut={() => {
                if (unpinning.current !== site) return;
                unpinning.current = null;
                onUnpin(site);
              }}
              className="w-1/4 items-center"
              style={{ gap: space.sm }}
              layout={shift}
              entering={arriving}
              exiting={leaving}
            >
              <Surface radius={radius.tile} style={{ width: PIN_TILE, height: PIN_TILE, alignItems: "center", justifyContent: "center" }}>
                <SiteIcon url={site.url} size={30} />
              </Surface>
              <Text numberOfLines={1} variant="caption" weight="regular" style={{ maxWidth: 76 }}>
                {site.title || siteName(site.url)}
              </Text>
            </PressFeedback>
          ))}
        </View>
      ) : null}
      {recent.length ? (
        <Surface radius={radius.card} style={{ paddingVertical: space.xs }}>
          {recent.map((entry, index) => (
            <PressFeedback
              key={entry.url}
              testID={`start-recent-${index}`}
              accessibilityRole="button"
              accessibilityLabel={t("start.openSite", { name: entry.title || siteName(entry.url) })}
              onPress={() => onOpen(entry.url)}
              className="flex-row items-center"
              style={{ minHeight: rowHeight, gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm }}
              layout={shift}
              entering={arriving}
              exiting={leaving}
            >
              <SiteIcon url={entry.url} size={28} />
              <View className="flex-1">
                <Text variant="callout" weight="medium" numberOfLines={1}>
                  {entry.title || siteName(entry.url)}
                </Text>
                <Text variant="footnote" tone="muted" numberOfLines={1}>
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
