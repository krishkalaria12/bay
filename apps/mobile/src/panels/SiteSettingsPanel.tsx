import { Typography, useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { Pressable, View } from "react-native";

import { SiteIcon } from "@/browser/SiteIcon";
import { TEXT_SIZE } from "@/store/model";
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
}

/** Per-site settings (B12): what this host keeps instead of the global choices. */
export function SiteSettingsPanel(props: SiteSettingsPanelProps): JSX.Element {
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
      <PanelSheet visible={props.visible} onClose={props.onClose} onBack={() => setZoom(false)} title="Page zoom" testID="site-settings" height="60%">
        <SiteZoom textSize={props.textSize} globalTextSize={props.globalTextSize} onChange={props.onTextSize} />
      </PanelSheet>
    );
  }

  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title="This site" testID="site-settings" height="60%" header={<SiteHeader url={props.url} />}>
      <Group>
        <ActionRow
          testID="site-text-size"
          icon="textSize"
          label="Page zoom"
          detail={props.textSize === null ? `Follows Bay's ${props.globalTextSize}%` : `${props.textSize}% on this site`}
          value={props.textSize === null ? undefined : `${props.textSize}%`}
          chevron
          onPress={act(() => setZoom(true))}
        />
        <ActionRow
          testID="site-reader"
          icon="reader"
          label="Open Reader automatically"
          detail="As each article here loads"
          toggle={props.reader}
          onPress={() => props.onReader(!props.reader)}
        />
        <ActionRow
          testID="site-desktop"
          icon="desktop"
          label="Desktop site"
          detail="Asks this site for the desktop page"
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
              label="Reset this site"
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
  const foreground = useThemeColor("foreground");
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
        <Typography className="text-muted" style={{ fontSize: (13 * value) / 100, lineHeight: (18 * value) / 100 }}>
          example.com
        </Typography>
        <Typography className="mt-1 font-semibold" style={{ fontSize: (20 * value) / 100, lineHeight: (26 * value) / 100 }}>
          The quiet bay
        </Typography>
        <Typography className="mt-1" style={{ fontSize: (16 * value) / 100, lineHeight: (23 * value) / 100 }}>
          This site shows its text and images at this size, whatever Bay's zoom is.
        </Typography>
      </View>
      <View className="mt-4 flex-row items-center gap-3">
        <Pressable
          testID="site-zoom-smaller"
          accessibilityRole="button"
          accessibilityLabel="Zoom out"
          disabled={value <= TEXT_SIZE.min}
          onPress={() => step(-1)}
          className="h-12 flex-1 items-center justify-center rounded-full bg-default active:opacity-70"
          style={{ opacity: value <= TEXT_SIZE.min ? 0.35 : 1 }}
        >
          <Typography style={{ color: foreground, fontSize: 15 }}>A</Typography>
        </Pressable>
        <Typography testID="site-zoom-value" className="w-16 text-center text-lg font-semibold">
          {`${value}%`}
        </Typography>
        <Pressable
          testID="site-zoom-larger"
          accessibilityRole="button"
          accessibilityLabel="Zoom in"
          disabled={value >= TEXT_SIZE.max}
          onPress={() => step(1)}
          className="h-12 flex-1 items-center justify-center rounded-full bg-default active:opacity-70"
          style={{ opacity: value >= TEXT_SIZE.max ? 0.35 : 1 }}
        >
          <Typography style={{ color: foreground, fontSize: 21 }}>A</Typography>
        </Pressable>
      </View>
      {textSize !== null ? (
        <View className="mt-4">
          <Group>
            <ActionRow testID="site-zoom-follow" label={`Follow Bay's ${globalTextSize}%`} onPress={() => onChange(null)} />
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
      <Typography testID="site-settings-host" numberOfLines={1} className="flex-1 text-lg font-semibold">
        {url
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .replace(/\/.*$/, "")}
      </Typography>
    </View>
  );
}
