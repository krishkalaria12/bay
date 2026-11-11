import { Typography, useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { View } from "react-native";

import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { PressFeedback } from "@/chrome/PressFeedback";
import { SiteIcon } from "@/browser/SiteIcon";
import { useT } from "@/i18n";
import { ActionRow, Group, PanelSheet } from "./PanelSheet";

export interface PageMenuProps {
  visible: boolean;
  onClose: () => void;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isPinned: boolean;
  /** Ad and tracker blocking on this site; "off" when it's turned off in Settings. */
  blocking: "on" | "paused" | "off";
  onToggleBlocking: () => void;
  /** Elements the user hid on this site. */
  hiddenCount: number;
  onShowHidden: () => void;
  privateAvailable: boolean;
  onNewTab: () => void;
  onNewPrivateTab: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onPin: () => void;
  onShare: () => void;
  onCopy: () => void;
  onTranslate: () => void;
  onCloseTab: () => void;
  readerActive: boolean;
  onReader: () => void;
  onHideElements: () => void;
  onCopyMarkdown: () => void;
  onFind: () => void;
  onInspect: () => void;
  /** This site's own settings (B12): zoom, Reader and desktop mode, kept for this host. */
  onSiteSettings: () => void;
  onSettings: () => void;
  onHistory: () => void;
  onDownloads: () => void;
}

/** A round icon button for the navigation row: the icons say enough on their own. */
function NavigationAction({
  id,
  icon,
  label,
  disabled,
  onPress,
}: {
  id: string;
  icon: IconName;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}): JSX.Element {
  const foreground = useThemeColor("foreground");

  return (
    <PressFeedback
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="h-12 flex-1 items-center justify-center rounded-full bg-default"
      style={{ opacity: disabled ? 0.35 : 1 }}
    >
      <Icon name={icon} color={foreground} size={22} />
    </PressFeedback>
  );
}

/** An icon over a short label, four to a row. */
function Tile({
  id,
  icon,
  label,
  accessibilityLabel = label,
  active,
  onPress,
}: {
  id: string;
  icon: IconName;
  label: string;
  /** When the short label needs more words to say what a tap does. */
  accessibilityLabel?: string;
  active?: boolean;
  onPress: () => void;
}): JSX.Element {
  const foreground = useThemeColor("foreground");
  const accent = useThemeColor("accent");

  return (
    <PressFeedback
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`h-[72px] items-center justify-center gap-1.5 rounded-2xl ${active ? "bg-accent/15" : "bg-default"}`}
      style={{ width: "23.5%" }}
    >
      <Icon name={icon} color={active ? accent : foreground} size={22} />
      <Typography numberOfLines={1} className={`px-1 text-[12px] ${active ? "text-accent" : "text-foreground"}`}>
        {label}
      </Typography>
    </PressFeedback>
  );
}

function TileGrid({ children }: { children: JSX.Element | (JSX.Element | null)[] }): JSX.Element {
  return (
    <View className="mt-3 flex-row flex-wrap" style={{ columnGap: "2%", rowGap: 8 }}>
      {children}
    </View>
  );
}

export function PageMenu(props: PageMenuProps): JSX.Element {
  const t = useT();
  // Rarely used page tools sit one step away, so the menu fits without scrolling.
  const [tools, setTools] = useState(false);
  useEffect(() => {
    if (props.visible) setTools(false);
  }, [props.visible]);

  function act(action: () => void): () => void {
    return () => {
      props.onClose();
      action();
    };
  }

  if (tools) {
    return (
      <PanelSheet
        visible={props.visible}
        onClose={props.onClose}
        onBack={() => setTools(false)}
        title={t("pageMenu.toolsTitle")}
        testID="page-menu"
        height="70%"
      >
        <Group>
          <ActionRow
            testID="page-hide-elements"
            icon="hide"
            label={t("pageMenu.hideElements")}
            detail={t("pageMenu.hideElements.detail")}
            onPress={act(props.onHideElements)}
          />
          <ActionRow testID="page-inspect" icon="inspect" label={t("pageMenu.inspect")} detail={t("pageMenu.inspect.detail")} onPress={act(props.onInspect)} />
          <ActionRow
            testID="page-markdown"
            icon="markdown"
            label={t("pageMenu.markdown")}
            detail={t("pageMenu.markdown.detail")}
            onPress={act(props.onCopyMarkdown)}
          />
        </Group>
      </PanelSheet>
    );
  }

  return (
    <PanelSheet
      visible={props.visible}
      onClose={props.onClose}
      title={t("pageMenu.title")}
      testID="page-menu"
      height="70%"
      header={<SiteHeader title={props.title} url={props.url} blocking={props.blocking} />}
    >
      {props.blocking !== "off" || props.hiddenCount ? (
        <Group>
          {props.blocking !== "off" ? (
            <ActionRow
              testID="page-blocking"
              icon="shield"
              label={t("pageMenu.blocking")}
              detail={props.blocking === "paused" ? t("pageMenu.blocking.paused") : t("pageMenu.blocking.on")}
              toggle={props.blocking === "on"}
              onPress={props.onToggleBlocking}
            />
          ) : null}
          {props.hiddenCount ? (
            <ActionRow
              testID="page-show-hidden"
              icon="visibility"
              label={props.hiddenCount === 1 ? t("pageMenu.hiddenOne") : t("pageMenu.hiddenMany", { count: props.hiddenCount })}
              onPress={act(props.onShowHidden)}
            />
          ) : null}
        </Group>
      ) : null}
      <View className="mt-3 flex-row gap-2">
        <NavigationAction id="page-back" icon="back" label={t("pageMenu.back")} disabled={!props.canGoBack} onPress={act(props.onBack)} />
        <NavigationAction id="page-forward" icon="forward" label={t("pageMenu.forward")} disabled={!props.canGoForward} onPress={act(props.onForward)} />
        <NavigationAction
          id={props.isLoading ? "page-stop" : "page-reload"}
          icon={props.isLoading ? "close" : "reload"}
          label={props.isLoading ? t("pageMenu.stop") : t("pageMenu.reload")}
          onPress={act(props.isLoading ? props.onStop : props.onReload)}
        />
        <NavigationAction id="page-share" icon="share" label={t("pageMenu.share")} onPress={act(props.onShare)} />
      </View>
      <TileGrid>
        <Tile id="page-new-tab" icon="add" label={t("pageMenu.newTab")} onPress={act(props.onNewTab)} />
        {props.privateAvailable ? <Tile id="page-new-private" icon="private" label={t("pageMenu.privateTab")} onPress={act(props.onNewPrivateTab)} /> : null}
        <Tile id="page-find" icon="find" label={t("pageMenu.find")} onPress={act(props.onFind)} />
        <Tile
          id="page-reader"
          icon="reader"
          label={t("pageMenu.reader")}
          accessibilityLabel={props.readerActive ? t("pageMenu.readerSettings") : t("pageMenu.reader")}
          active={props.readerActive}
          onPress={act(props.onReader)}
        />
        <Tile
          id="page-pin"
          icon={props.isPinned ? "unpin" : "pin"}
          label={props.isPinned ? t("pageMenu.unpin") : t("pageMenu.pin")}
          active={props.isPinned}
          onPress={act(props.onPin)}
        />
        <Tile id="page-translate" icon="translate" label={t("pageMenu.translate")} onPress={act(props.onTranslate)} />
        <Tile id="page-copy" icon="link" label={t("pageMenu.copyLink")} onPress={act(props.onCopy)} />
        <Tile id="page-more-tools" icon="more" label={t("pageMenu.tools")} onPress={() => setTools(true)} />
        <Tile id="page-site-settings" icon="tune" label={t("pageMenu.thisSite")} onPress={act(props.onSiteSettings)} />
        <Tile id="page-history" icon="history" label={t("pageMenu.history")} onPress={act(props.onHistory)} />
        <Tile id="page-downloads" icon="download" label={t("pageMenu.downloads")} onPress={act(props.onDownloads)} />
        <Tile id="page-close-tab" icon="archive" label={t("pageMenu.archive")} onPress={act(props.onCloseTab)} />
        <Tile id="page-settings" icon="settings" label={t("pageMenu.settings")} onPress={act(props.onSettings)} />
      </TileGrid>
    </PanelSheet>
  );
}

/** The page's title and address, its site behind a lock (or a warning when it isn't encrypted), and what's blocked. */
function SiteHeader({ title, url, blocking }: { title: string; url: string; blocking: PageMenuProps["blocking"] }): JSX.Element {
  const muted = useThemeColor("muted");
  const danger = useThemeColor("danger");
  const t = useT();
  const web = /^https?:/.test(url);
  const insecure = url.startsWith("http:");

  const status = [
    web ? (insecure ? t("pageMenu.notSecure") : t("pageMenu.secure")) : "",
    blocking === "on" ? t("pageMenu.blocked") : blocking === "paused" ? t("pageMenu.blockingPaused") : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View className="flex-row items-center gap-3">
      {url ? <SiteIcon url={url} size={40} /> : null}
      <View className="flex-1">
        <Typography numberOfLines={1} accessibilityRole="header" className="text-[17px] font-semibold">
          {title || url}
        </Typography>
        <Typography testID="page-menu-url" numberOfLines={1} className="text-[13px] text-muted">
          {url}
        </Typography>
        {status ? (
          <View className="mt-0.5 flex-row items-center gap-1" accessible accessibilityLabel={status}>
            {web ? <Icon name={insecure ? "error" : "lock"} color={insecure ? danger : muted} size={12} /> : null}
            <Typography numberOfLines={1} className={insecure ? "text-xs text-danger" : "text-xs text-muted"}>
              {status}
            </Typography>
          </View>
        ) : null}
      </View>
    </View>
  );
}
