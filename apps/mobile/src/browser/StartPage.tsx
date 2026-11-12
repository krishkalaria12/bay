import { useThemeColor } from "heroui-native";
import { Fragment, useEffect, useRef, useState, type JSX } from "react";
import { AppState, StyleSheet, useWindowDimensions, View, type TextStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { gridShift, tileArriving, tileLeaving, useReducedMotion } from "@/chrome/motion";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Surface } from "@/chrome/Surface";
import { Text } from "@/chrome/Text";
import { radius, rowHeight, space } from "@/chrome/tokens";
import { formatDate, useT, type MessageKey } from "@/i18n";
import type { HistoryEntry, PinnedSite } from "@/store/types";
import { SiteIcon } from "./SiteIcon";
import { siteName } from "./siteName";

const PINS = 8;
const COLUMNS = 4;
const PIN_TILE = 64;
const PIN_ICON = 32;
const RECENT = 3;
const RECENT_ICON = 28;

/** Below this height the greeting gives its room to a full grid of pins and the recent pages. */
const ROOM_FOR_GREETING = 700;

// Text straight on the user's photo: light, with a soft shadow, the way a lock screen sets its clock.
const ON_PHOTO = "#FFFFFF";
export const ON_PHOTO_MUTED = "rgba(255,255,255,0.78)";
const photoShadow: TextStyle = { textShadowColor: "rgba(0,0,0,0.35)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6 };

export interface StartPageProps {
  pins: readonly PinnedSite[];
  history: readonly HistoryEntry[];
  /** The wallpaper is the user's photo, so text on it is drawn light. */
  onPhoto: boolean;
  onOpen: (url: string) => void;
  onUnpin: (site: PinnedSite) => void;
}

/** A greeting, the pinned sites and the last few pages, over the wallpaper above "Tap to search". */
export function StartPage({ pins, history, onPhoto, onOpen, onUnpin }: StartPageProps): JSX.Element {
  const t = useT();
  const now = useNow();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
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

  const shown = pins.slice(0, PINS);
  // The pins span the same width as the recent card below them: the first tile starts at the gutter, the last ends at it.
  const width = window.width - insets.left - insets.right - space.gutter * 2;
  const columnGap = Math.max((width - PIN_TILE * COLUMNS) / (COLUMNS - 1), space.sm);
  const greet = window.height >= ROOM_FOR_GREETING || shown.length <= COLUMNS || !recent.length;
  const ink = onPhoto ? ON_PHOTO : foreground;
  const inkMuted = onPhoto ? ON_PHOTO_MUTED : muted;
  const shadow = onPhoto ? photoShadow : null;
  const greeting = t(greetingFor(new Date(now).getHours()));
  const date = formatDate(now, { weekday: "long", day: "numeric", month: "long" });

  return (
    // Touches between the tiles fall through to the start screen behind, which opens search.
    <View testID="start-page" className="w-full" style={{ gap: space.section, paddingHorizontal: space.gutter }} pointerEvents="box-none">
      {greet ? (
        <View testID="start-greeting" accessible accessibilityRole="header" accessibilityLabel={`${greeting}, ${date}`} pointerEvents="none">
          <Text variant="display" color={ink} style={shadow}>
            {greeting}
          </Text>
          <Text variant="subhead" weight="medium" color={inkMuted} style={shadow}>
            {date}
          </Text>
        </View>
      ) : null}
      {shown.length ? (
        <View className="flex-row flex-wrap" style={{ columnGap, rowGap: space.lg }} pointerEvents="box-none">
          {shown.map((site, index) => (
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
              className="items-center"
              style={{ width: PIN_TILE, gap: space.sm }}
              layout={shift}
              entering={arriving}
              exiting={leaving}
            >
              <Surface radius={radius.tile} style={styles.tile}>
                <SiteIcon url={site.url} size={PIN_ICON} />
              </Surface>
              {/* The label may run past its tile, into the gap beside it, but never into the next label. */}
              <Text numberOfLines={1} variant="caption" color={ink} style={[{ width: PIN_TILE + columnGap - space.xs, textAlign: "center" }, shadow]}>
                {site.title || siteName(site.url)}
              </Text>
            </PressFeedback>
          ))}
        </View>
      ) : null}
      {recent.length ? (
        <View style={{ gap: space.sm }} pointerEvents="box-none">
          <Text variant="footnote" weight="semibold" color={inkMuted} style={shadow}>
            {t("start.recent")}
          </Text>
          <Surface radius={radius.card} style={{ paddingVertical: space.xs }}>
            {recent.map((entry, index) => (
              <Fragment key={entry.url}>
                {index ? <View className="bg-foreground/10" style={styles.separator} /> : null}
                <PressFeedback
                  testID={`start-recent-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={t("start.openSite", { name: entry.title || siteName(entry.url) })}
                  onPress={() => onOpen(entry.url)}
                  className="flex-row items-center"
                  style={styles.row}
                  layout={shift}
                  entering={arriving}
                  exiting={leaving}
                >
                  <SiteIcon url={entry.url} size={RECENT_ICON} />
                  <View className="flex-1">
                    <Text variant="callout" weight="medium" numberOfLines={1}>
                      {entry.title || siteName(entry.url)}
                    </Text>
                    <Text variant="footnote" tone="muted" numberOfLines={1}>
                      {siteName(entry.url)}
                    </Text>
                  </View>
                </PressFeedback>
              </Fragment>
            ))}
          </Surface>
        </View>
      ) : null}
    </View>
  );
}

function greetingFor(hour: number): MessageKey {
  if (hour >= 5 && hour < 12) return "start.morning";

  if (hour >= 12 && hour < 17) return "start.afternoon";

  return "start.evening";
}

/** The time, kept to the minute while the start page shows and caught up when Bay comes back to the front. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now());
    });

    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);

  return now;
}

const styles = StyleSheet.create({
  tile: { width: PIN_TILE, height: PIN_TILE, alignItems: "center", justifyContent: "center" },
  row: { minHeight: rowHeight, gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  // Starts under the titles, past the icons, the way grouped rows are divided.
  separator: { height: StyleSheet.hairlineWidth, marginLeft: space.lg + RECENT_ICON + space.md },
});
