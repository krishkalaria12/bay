import { useEffect, useState, type JSX } from "react";
import { Pressable, View } from "react-native";

import { SiteIcon } from "@/browser/SiteIcon";
import { useT } from "@/i18n";
import { TEXT_SIZE } from "@/store/model";
import { ActionRow, Group, PanelSheet } from "./PanelSheet";
import { Text } from "@/chrome/Text";

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
}

/** Per-site settings (B12): what this host keeps instead of the global choices. */
export function SiteSettingsPanel(props: SiteSettingsPanelProps): JSX.Element {
  const t = useT();
  // Rarely needed zoom control sits one step away, so the panel fits without scrolling.
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (props.visible) setZoom(false);
  }, [props.visible]);

  function act(action: () => void): () => void {
    return () => {
      props.onClose();
      action();
    };
  }

  if (zoom) {
    return (
      <PanelSheet visible={props.visible} onClose={props.onClose} onBack={() => setZoom(false)} title={t("site.zoom")} testID="site-settings" height="60%">
        <SiteZoom textSize={props.textSize} globalTextSize={props.globalTextSize} onChange={props.onTextSize} />
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
      <Group>
        <ActionRow
          testID="site-text-size"
          icon="textSize"
          label={t("site.zoom")}
          detail={props.textSize === null ? t("site.zoom.follows", { size: props.globalTextSize }) : t("site.zoom.onSite", { size: props.textSize })}
          value={props.textSize === null ? undefined : `${props.textSize}%`}
          chevron
          onPress={act(() => setZoom(true))}
        />
        <ActionRow
          testID="site-reader"
          icon="reader"
          label={t("site.reader")}
          detail={t("site.reader.detail")}
          toggle={props.reader}
          onPress={() => props.onReader(!props.reader)}
        />
        <ActionRow
          testID="site-desktop"
          icon="desktop"
          label={t("site.desktop")}
          detail={t("site.desktop.detail")}
          toggle={props.desktop}
          onPress={() => props.onDesktop(!props.desktop)}
        />
      </Group>
      {props.textSize !== null || props.reader || props.desktop ? (
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
      <View className="rounded-[20px] bg-default p-4">
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
        <Pressable
          testID="site-zoom-smaller"
          accessibilityRole="button"
          accessibilityLabel={t("site.zoom.out")}
          accessibilityState={{ disabled: value <= TEXT_SIZE.min }}
          disabled={value <= TEXT_SIZE.min}
          onPress={() => step(-1)}
          className="h-12 flex-1 items-center justify-center rounded-full bg-default active:opacity-70"
          style={{ opacity: value <= TEXT_SIZE.min ? 0.35 : 1 }}
        >
          <Text variant="callout" weight="medium">
            A
          </Text>
        </Pressable>
        <Text testID="site-zoom-value" accessibilityLiveRegion="polite" variant="headline" className="w-16 text-center">
          {`${value}%`}
        </Text>
        <Pressable
          testID="site-zoom-larger"
          accessibilityRole="button"
          accessibilityLabel={t("site.zoom.in")}
          accessibilityState={{ disabled: value >= TEXT_SIZE.max }}
          disabled={value >= TEXT_SIZE.max}
          onPress={() => step(1)}
          className="h-12 flex-1 items-center justify-center rounded-full bg-default active:opacity-70"
          style={{ opacity: value >= TEXT_SIZE.max ? 0.35 : 1 }}
        >
          <Text variant="title" weight="medium">
            A
          </Text>
        </Pressable>
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
