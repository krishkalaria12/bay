import { useEffect, useState, type JSX } from "react";
import { View } from "react-native";

import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { radius, rowTint } from "@/chrome/tokens";
import { SiteIcon } from "@/browser/SiteIcon";
import { useT, type MessageKey } from "@/i18n";
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

/** Per-site settings (B12): what this host keeps instead of the global choices. */
export function SiteSettingsPanel(props: SiteSettingsPanelProps): JSX.Element {
  const t = useT();
  // Rarely needed controls (zoom, swipe) sit one step away, so the panel fits without scrolling.
  const [page, setPage] = useState<"main" | "zoom" | "swipe">("main");
  useEffect(() => {
    if (props.visible) setPage("main");
  }, [props.visible]);

  if (page === "zoom") {
    return (
      <PanelSheet visible={props.visible} onClose={props.onClose} onBack={() => setPage("main")} title={t("site.zoom")} testID="site-settings" height="60%">
        <SiteZoom textSize={props.textSize} globalTextSize={props.globalTextSize} onChange={props.onTextSize} />
      </PanelSheet>
    );
  }

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

  return (
    <PanelSheet
      visible={props.visible}
      onClose={props.onClose}
      title={t("site.title")}
      testID="site-settings"
      height="60%"
      header={<SiteHeader url={props.url} />}
    >
      {props.blocking === "off" ? null : (
        <View className="mb-3">
          <Group>
            <ActionRow
              testID="site-blocking"
              icon="shield"
              tint={rowTint.blocking}
              label={t("pageMenu.blocking")}
              detail={
                props.blocking === "paused"
                  ? t("pageMenu.blocking.paused")
                  : props.blocking === "restored"
                    ? t("pageMenu.blocking.restored")
                    : t("pageMenu.blocking.on")
              }
              toggle={props.blocking === "on"}
              onPress={props.onToggleBlocking}
            />
            {props.blocking === "on"
              ? GROUP_ROWS.map(({ group, label }) => (
                  <ActionRow
                    key={group}
                    testID={`site-block-${group}`}
                    label={t(label)}
                    toggle={!props.blockOff.includes(group)}
                    onPress={() =>
                      props.onBlockOff(props.blockOff.includes(group) ? props.blockOff.filter((entry) => entry !== group) : [...props.blockOff, group])
                    }
                  />
                ))
              : null}
          </Group>
        </View>
      )}
      <Group>
        <ActionRow
          testID="site-text-size"
          icon="textSize"
          tint={rowTint.display}
          label={t("site.zoom")}
          detail={props.textSize === null ? t("site.zoom.follows", { size: props.globalTextSize }) : t("site.zoom.onSite", { size: props.textSize })}
          value={props.textSize === null ? undefined : `${props.textSize}%`}
          chevron
          onPress={() => setPage("zoom")}
        />
        <ActionRow
          testID="site-swipe"
          icon="back"
          tint={rowTint.browsing}
          label={t("settings.swipe")}
          detail={props.swipe === null ? t("site.swipe.follows", { mode: t(SWIPE_LABELS[props.globalSwipe]) }) : undefined}
          value={props.swipe === null ? undefined : t(SWIPE_LABELS[props.swipe])}
          chevron
          onPress={() => setPage("swipe")}
        />
        <ActionRow
          testID="site-reader"
          icon="reader"
          tint={rowTint.language}
          label={t("site.reader")}
          detail={t("site.reader.detail")}
          toggle={props.reader}
          onPress={() => props.onReader(!props.reader)}
        />
        <ActionRow
          testID="site-desktop"
          icon="desktop"
          tint={rowTint.site}
          label={t("site.desktop")}
          detail={t("site.desktop.detail")}
          toggle={props.desktop}
          onPress={() => props.onDesktop(!props.desktop)}
        />
      </Group>
      {props.textSize !== null || props.reader || props.desktop || props.swipe !== null ? (
        <View className="mt-3">
          <Group>
            <ActionRow
              testID="site-reset"
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
        </View>
      ) : null}
    </PanelSheet>
  );
}

/** The site's zoom, with the same steps as the global one and a way back to following it. */
function SiteZoom({
  textSize,
  globalTextSize,
  onChange,
}: {
  textSize: number | null;
  globalTextSize: number;
  onChange: (textSize: number | null) => void;
}): JSX.Element {
  const t = useT();
  // Untouched zooms stay null until the buttons are used, so a look costs nothing.
  const [value, setValue] = useState(textSize ?? globalTextSize);

  const step = (dir: 1 | -1): void => {
    const next = Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, value + dir * TEXT_SIZE.step));
    setValue(next);
    onChange(next);
  };

  return (
    <>
      <View className="bg-default p-4" style={{ borderRadius: radius.card }}>
        <Text tone="muted" style={{ fontSize: (13 * value) / 100, lineHeight: (18 * value) / 100 }}>
          example.com
        </Text>
        <Text weight="semibold" className="mt-1" style={{ fontSize: (20 * value) / 100, lineHeight: (26 * value) / 100 }}>
          {t("settings.zoom.previewTitle")}
        </Text>
        <Text className="mt-1" style={{ fontSize: (16 * value) / 100, lineHeight: (23 * value) / 100 }}>
          {t("site.zoom.previewBody")}
        </Text>
      </View>
      <View className="mt-4 flex-row items-center gap-3">
        <PressFeedback
          testID="site-zoom-smaller"
          accessibilityRole="button"
          accessibilityLabel={t("site.zoom.out")}
          accessibilityState={{ disabled: value <= TEXT_SIZE.min }}
          disabled={value <= TEXT_SIZE.min}
          onPress={() => step(-1)}
          className="h-12 flex-1 items-center justify-center rounded-full bg-default"
          style={{ opacity: value <= TEXT_SIZE.min ? 0.35 : 1 }}
        >
          <Text variant="callout" weight="medium">
            A
          </Text>
        </PressFeedback>
        <Text testID="site-zoom-value" accessibilityLiveRegion="polite" variant="headline" className="w-16 text-center">
          {`${value}%`}
        </Text>
        <PressFeedback
          testID="site-zoom-larger"
          accessibilityRole="button"
          accessibilityLabel={t("site.zoom.in")}
          accessibilityState={{ disabled: value >= TEXT_SIZE.max }}
          disabled={value >= TEXT_SIZE.max}
          onPress={() => step(1)}
          className="h-12 flex-1 items-center justify-center rounded-full bg-default"
          style={{ opacity: value >= TEXT_SIZE.max ? 0.35 : 1 }}
        >
          <Text variant="title" weight="medium">
            A
          </Text>
        </PressFeedback>
      </View>
      {textSize !== null ? (
        <View className="mt-4">
          <Group>
            <ActionRow testID="site-zoom-follow" label={t("site.zoom.follow", { size: globalTextSize })} onPress={() => onChange(null)} />
          </Group>
        </View>
      ) : null}
    </>
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
