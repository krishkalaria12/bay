import { useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { View } from "react-native";

import { Icon } from "@/chrome/Icon";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { iconSize, rowHeight, space } from "@/chrome/tokens";
import { SiteIcon } from "@/browser/SiteIcon";
import { useT, type MessageKey } from "@/i18n";
import { TILE } from "@/settings/content";
import { SWIPE_MODES, TEXT_SIZE } from "@/store/model";
import type { SiteBlockGroup, SwipeMode } from "@/store/types";
import { ActionRow, Group, PanelSheet } from "./PanelSheet";

export interface SiteSettingsPanelProps {
  visible: boolean;
  onClose: () => void;
  url: string;
  /** This site's own zoom, or null while it follows Bay's. */
  textSize: number | null;
  /** The global zoom, shown as what this site follows. */
  globalTextSize: number;
  /** Reader opening by itself on this site. */
  reader: boolean;
  /** The site answering with its desktop page. */
  desktop: boolean;
  onTextSize: (textSize: number | null) => void;
  onReader: (reader: boolean) => void;
  onDesktop: (desktop: boolean) => void;
  /** Ad and tracker blocking here (U6): its switch sits with the site's other choices. */
  blocking: "on" | "paused" | "restored" | "off";
  onToggleBlocking: () => void;
  /** What this site doesn't block (C3): ads, trackers or cookie banners. */
  blockOff: readonly SiteBlockGroup[];
  onBlockOff: (groups: SiteBlockGroup[]) => void;
  /** Swipe to navigate here (C20), or null while it follows Bay's. */
  swipe: SwipeMode | null;
  /** Bay's own swipe to navigate, shown as what this site follows. */
  globalSwipe: SwipeMode;
  onSwipe: (swipe: SwipeMode | null) => void;
  /** Files downloaded from this site, and the downloads they're in. */
  downloadedHere: number;
  onDownloads: () => void;
  /** Bay's own Settings, at the foot as Yab has them. */
  onSettings: () => void;
}

const SWIPE_LABELS: Record<SwipeMode, MessageKey> = {
  anywhere: "settings.swipe.anywhere",
  edges: "settings.swipe.edges",
  off: "settings.swipe.off",
};

const GROUP_ROWS: { group: SiteBlockGroup; label: MessageKey }[] = [
  { group: "ads", label: "site.block.ads" },
  { group: "trackers", label: "site.block.trackers" },
  { group: "cookies", label: "site.block.cookies" },
];

/**
 * Per-site settings (B12), laid out as Yab's Site Settings (Phone/Sources/Chrome/SiteSettingsPage.swift, Apache-2.0):
 * cards of rows with white glyphs on coloured squares, as iOS Settings draws them. This site's zoom and desktop page and
 * its blocking first, then how Bay behaves here, what was downloaded from it, the connection, and Bay's Settings at the
 * foot.
 */
export function SiteSettingsPanel(props: SiteSettingsPanelProps): JSX.Element {
  const t = useT();
  // Swipe's choices sit one step away, so the sheet fits without scrolling.
  const [page, setPage] = useState<"main" | "swipe">("main");
  useEffect(() => {
    if (props.visible) setPage("main");
  }, [props.visible]);

  if (page === "swipe") {
    return (
      <PanelSheet
        visible={props.visible}
        onClose={props.onClose}
        onBack={() => setPage("main")}
        title={t("settings.swipe")}
        testID="site-settings"
        height="60%"
      >
        <Group>
          <ActionRow
            testID="site-swipe-follow"
            label={t("site.swipe.follow", { mode: t(SWIPE_LABELS[props.globalSwipe]) })}
            selected={props.swipe === null}
            onPress={() => props.onSwipe(null)}
          />
          {SWIPE_MODES.map((mode) => (
            <ActionRow
              key={mode}
              testID={`site-swipe-${mode}`}
              label={t(SWIPE_LABELS[mode])}
              selected={props.swipe === mode}
              onPress={() => props.onSwipe(mode)}
            />
          ))}
        </Group>
        <Text testID="site-swipe-note" variant="footnote" tone="muted" className="mt-2 px-4">
          {t("site.swipe.note")}
        </Text>
      </PanelSheet>
    );
  }

  const secure = props.url.startsWith("https://");
  const changed = props.textSize !== null || props.reader || props.desktop || props.swipe !== null;

  return (
    <PanelSheet
      visible={props.visible}
      onClose={props.onClose}
      title={t("site.title")}
      testID="site-settings"
      height="85%"
      header={<SiteHeader url={props.url} />}
    >
      <View style={{ gap: space.md }}>
        <Group>
          <ZoomRow textSize={props.textSize} globalTextSize={props.globalTextSize} onChange={props.onTextSize} />
          <ActionRow
            testID="site-desktop"
            icon="desktop"
            tint={TILE.teal}
            label={t("site.desktop")}
            toggle={props.desktop}
            onPress={() => props.onDesktop(!props.desktop)}
          />
          {props.blocking === "off" ? null : (
            <ActionRow
              testID="site-blocking"
              icon="shield"
              tint={TILE.green}
              label={t("pageMenu.blocking")}
              detail={props.blocking === "paused" ? t("pageMenu.blocking.paused") : props.blocking === "restored" ? t("pageMenu.blocking.restored") : undefined}
              toggle={props.blocking === "on"}
              onPress={props.onToggleBlocking}
            />
          )}
        </Group>
        {props.blocking === "on" ? (
          <Group label={t("site.blockingHere")}>
            {GROUP_ROWS.map(({ group, label }) => (
              <ActionRow
                key={group}
                testID={`site-block-${group}`}
                label={t(label)}
                toggle={!props.blockOff.includes(group)}
                onPress={() =>
                  props.onBlockOff(props.blockOff.includes(group) ? props.blockOff.filter((entry) => entry !== group) : [...props.blockOff, group])
                }
              />
            ))}
          </Group>
        ) : null}
        <Group label={t("site.bayHere")}>
          <ActionRow
            testID="site-reader"
            icon="reader"
            tint={TILE.orange}
            label={t("site.reader")}
            toggle={props.reader}
            onPress={() => props.onReader(!props.reader)}
          />
          <ActionRow
            testID="site-swipe"
            icon="back"
            tint={TILE.grey}
            label={t("settings.swipe")}
            value={t(SWIPE_LABELS[props.swipe ?? props.globalSwipe])}
            chevron
            onPress={() => setPage("swipe")}
          />
        </Group>
        {props.downloadedHere ? (
          <Group>
            <ActionRow
              testID="site-downloaded"
              icon="download"
              tint={TILE.blue}
              label={t("site.downloaded")}
              value={String(props.downloadedHere)}
              chevron
              onPress={props.onDownloads}
            />
          </Group>
        ) : null}
        {props.url ? (
          <Group>
            <Connection secure={secure} />
          </Group>
        ) : null}
        {changed ? (
          <Group>
            <ActionRow
              testID="site-reset"
              icon="delete"
              tint={TILE.red}
              destructive
              label={t("site.reset")}
              onPress={() => {
                props.onTextSize(null);
                props.onReader(false);
                props.onDesktop(false);
                props.onSwipe(null);
              }}
            />
          </Group>
        ) : null}
        <Group>
          <ActionRow testID="site-bay-settings" icon="settings" tint={TILE.grey} label={t("site.settings")} chevron onPress={props.onSettings} />
        </Group>
      </View>
    </PanelSheet>
  );
}

/** Page zoom in its row, with − and + at its end as Yab's compact stepper; the % goes back to Bay's zoom. */
function ZoomRow({
  textSize,
  globalTextSize,
  onChange,
}: {
  textSize: number | null;
  globalTextSize: number;
  onChange: (textSize: number | null) => void;
}): JSX.Element {
  const t = useT();
  const foreground = useThemeColor("foreground");
  const value = textSize ?? globalTextSize;
  const step = (dir: 1 | -1) => onChange(Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, value + dir * TEXT_SIZE.step)));

  return (
    <View className="flex-row items-center" style={{ minHeight: rowHeight, paddingLeft: space.lg, paddingRight: space.sm, gap: 14 }}>
      <View className="items-center justify-center" style={{ width: 29, height: 29, borderRadius: 8, backgroundColor: TILE.blue }}>
        <Icon name="textSize" color="#FFFFFF" size={iconSize.small} />
      </View>
      <Text variant="body" className="flex-1" numberOfLines={1}>
        {t("site.zoom")}
      </Text>
      <View className="flex-row items-center rounded-full bg-default">
        <PressFeedback
          testID="site-zoom-smaller"
          accessibilityRole="button"
          accessibilityLabel={t("site.zoom.out")}
          accessibilityState={{ disabled: value <= TEXT_SIZE.min }}
          disabled={value <= TEXT_SIZE.min}
          onPress={() => step(-1)}
          className="h-9 w-10 items-center justify-center"
          style={{ opacity: value <= TEXT_SIZE.min ? 0.35 : 1 }}
        >
          <Icon name="minus" color={foreground} size={iconSize.small} />
        </PressFeedback>
        <PressFeedback
          testID="site-zoom-value"
          accessibilityRole="button"
          accessibilityLabel={t("site.zoom.reset", { size: globalTextSize })}
          accessibilityValue={{ text: `${value}%` }}
          accessibilityState={{ disabled: textSize === null }}
          disabled={textSize === null}
          onPress={() => onChange(null)}
          className="h-9 items-center justify-center"
          style={{ minWidth: 52 }}
        >
          <Text variant="subhead" weight={textSize === null ? "regular" : "semibold"} tone={textSize === null ? "muted" : "default"}>
            {`${value}%`}
          </Text>
        </PressFeedback>
        <PressFeedback
          testID="site-zoom-larger"
          accessibilityRole="button"
          accessibilityLabel={t("site.zoom.in")}
          accessibilityState={{ disabled: value >= TEXT_SIZE.max }}
          disabled={value >= TEXT_SIZE.max}
          onPress={() => step(1)}
          className="h-9 w-10 items-center justify-center"
          style={{ opacity: value >= TEXT_SIZE.max ? 0.35 : 1 }}
        >
          <Icon name="add" color={foreground} size={iconSize.small} />
        </PressFeedback>
      </View>
    </View>
  );
}

/** Whether pages from here travel encrypted: said, not tapped. */
function Connection({ secure }: { secure: boolean }): JSX.Element {
  const t = useT();
  const label = secure ? t("site.secure") : t("site.notSecure");
  const detail = secure ? t("site.secure.detail") : t("site.notSecure.detail");

  return (
    <View
      testID="site-connection"
      accessible
      accessibilityLabel={label}
      accessibilityValue={{ text: detail }}
      className="flex-row items-center"
      style={{ minHeight: rowHeight, paddingHorizontal: space.lg, paddingVertical: space.md, gap: 14 }}
    >
      <View className="items-center justify-center" style={{ width: 29, height: 29, borderRadius: 8, backgroundColor: secure ? TILE.green : TILE.red }}>
        <Icon name="lock" color="#FFFFFF" size={iconSize.small} />
      </View>
      <View className="flex-1" style={{ gap: 1 }}>
        <Text variant="body" tone={secure ? "default" : "danger"}>
          {label}
        </Text>
        <Text variant="subhead" tone="muted">
          {detail}
        </Text>
      </View>
    </View>
  );
}

/** The site's icon and address, so the panel says which host it is editing. */
function SiteHeader({ url }: { url: string }): JSX.Element {
  return (
    <View className="flex-1 flex-row items-center gap-2.5">
      {url ? <SiteIcon url={url} size={30} /> : null}
      <Text testID="site-settings-host" numberOfLines={1} accessibilityRole="header" variant="headline" className="flex-1">
        {url
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .replace(/\/.*$/, "")}
      </Text>
    </View>
  );
}
