import { useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { View } from "react-native";

import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { pageMenu, zoomStep } from "@/chrome/layout";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { iconSize, radius, space } from "@/chrome/tokens";
import { SiteIcon } from "@/browser/SiteIcon";
import { useT } from "@/i18n";
import { TEXT_SIZE } from "@/store/model";
import { ActionRow, Group, PanelSheet, SheetIconButton } from "./PanelSheet";
import { quietWhileClosed } from "./quietWhileClosed";

/** Ad and tracker blocking on this page: on, paused for the site, off for this visit only (restored), or off in Settings. */
export type PageBlocking = "on" | "paused" | "restored" | "off";

export interface PageMenuProps {
  visible: boolean;
  onClose: () => void;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isPinned: boolean;
  isBookmarked: boolean;
  blocking: PageBlocking;
  /** What the blocker stopped on this page, when the engine counts it (C2); null where it can't. */
  blockedCount: number | null;
  onToggleBlocking: () => void;
  /** Shows this page without blocking until the tab leaves the site (C2). */
  onRestore: () => void;
  /** Elements the user hid on this site. */
  hiddenCount: number;
  onShowHidden: () => void;
  /** The page's zoom in percent: this site's own, else Bay's. */
  zoom: number;
  onZoom: (zoom: number) => void;
  /** The site answers with its desktop page (B12). */
  desktop: boolean;
  onDesktop: (desktop: boolean) => void;
  onNewTab: () => void;
  onNewPrivateTab: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onPin: () => void;
  onBookmark: () => void;
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
      className="flex-1 items-center justify-center rounded-full"
      style={{ height: pageMenu.capsuleHeight, opacity: disabled ? 0.35 : 1 }}
    >
      <Icon name={icon} color={foreground} size={iconSize.control} />
    </PressFeedback>
  );
}

/** A square with an icon and its label under it, four to a row (U3). */
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
      className="flex-1 items-center"
      style={{ gap: space.sm }}
    >
      <View
        className={`w-full items-center justify-center ${active ? "bg-accent/15" : "bg-default"}`}
        style={{ height: pageMenu.tileHeight - 24, borderRadius: pageMenu.tileCornerRadius }}
      >
        <Icon name={icon} color={active ? accent : foreground} size={iconSize.control + 2} />
      </View>
      <Text variant="caption" tone={active ? "accent" : "default"} numberOfLines={1}>
        {label}
      </Text>
    </PressFeedback>
  );
}

function PageMenuSheet(props: PageMenuProps): JSX.Element {
  const t = useT();
  const foreground = useThemeColor("foreground");
  // Rarely used page tools sit one step away, and the display options open in place, so the menu fits.
  const [tools, setTools] = useState(false);
  const [display, setDisplay] = useState(false);

  useEffect(() => {
    if (!props.visible) return;
    setTools(false);
    setDisplay(false);
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
        height="80%"
      >
        <View style={{ gap: space.lg }}>
          <Group>
            <ActionRow
              testID="page-pin"
              icon={props.isPinned ? "unpin" : "pin"}
              label={props.isPinned ? t("pageMenu.unpin") : t("pageMenu.pinToStart")}
              onPress={act(props.onPin)}
            />
            <ActionRow testID="page-copy" icon="link" label={t("pageMenu.copyLink")} onPress={act(props.onCopy)} />
            <ActionRow testID="page-new-private" icon="private" label={t("pageMenu.privateTab")} onPress={act(props.onNewPrivateTab)} />
            <ActionRow
              testID="page-hide-elements"
              icon="hide"
              label={t("pageMenu.hideElements")}
              detail={t("pageMenu.hideElements.detail")}
              onPress={act(props.onHideElements)}
            />
            <ActionRow
              testID="page-inspect"
              icon="inspect"
              label={t("pageMenu.inspect")}
              detail={t("pageMenu.inspect.detail")}
              onPress={act(props.onInspect)}
            />
            <ActionRow
              testID="page-markdown"
              icon="markdown"
              label={t("pageMenu.markdown")}
              detail={t("pageMenu.markdown.detail")}
              onPress={act(props.onCopyMarkdown)}
            />
          </Group>
          <Group>
            <ActionRow testID="page-history" icon="history" label={t("pageMenu.history")} chevron onPress={act(props.onHistory)} />
            <ActionRow testID="page-downloads" icon="download" label={t("pageMenu.downloads")} chevron onPress={act(props.onDownloads)} />
            <ActionRow testID="page-close-tab" icon="archive" label={t("pageMenu.archiveTab")} onPress={act(props.onCloseTab)} />
          </Group>
        </View>
      </PanelSheet>
    );
  }

  const zoomed = props.zoom !== 100;

  return (
    <PanelSheet
      visible={props.visible}
      onClose={props.onClose}
      title={t("pageMenu.title")}
      testID="page-menu"
      height="88%"
      header={<SiteHeader title={props.title} url={props.url} blocking={props.blocking} />}
      accessory={<SheetIconButton testID="page-settings" icon="settings" label={t("pageMenu.settings")} onPress={act(props.onSettings)} tone="default" />}
    >
      {/* The address capsule's controls: where to go, and a fresh tab. */}
      <View className="flex-row bg-default" style={{ marginTop: space.xs, borderRadius: pageMenu.capsuleHeight / 2, paddingHorizontal: space.xs }}>
        <NavigationAction id="page-back" icon="back" label={t("pageMenu.back")} disabled={!props.canGoBack} onPress={act(props.onBack)} />
        <NavigationAction id="page-forward" icon="forward" label={t("pageMenu.forward")} disabled={!props.canGoForward} onPress={act(props.onForward)} />
        <NavigationAction
          id={props.isLoading ? "page-stop" : "page-reload"}
          icon={props.isLoading ? "close" : "reload"}
          label={props.isLoading ? t("pageMenu.stop") : t("pageMenu.reload")}
          onPress={act(props.isLoading ? props.onStop : props.onReload)}
        />
        <NavigationAction id="page-new-tab" icon="add" label={t("pageMenu.newTab")} onPress={act(props.onNewTab)} />
      </View>

      <View className="flex-row" style={{ marginTop: pageMenu.tilesGap, gap: pageMenu.tileSpacing - space.xs }}>
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
          id="page-bookmark"
          icon={props.isBookmarked ? "bookmarked" : "bookmark"}
          // The filled icon and the highlight say it's bookmarked; "Bookmarked" doesn't fit a tile in every language.
          label={t("pageMenu.bookmark")}
          accessibilityLabel={props.isBookmarked ? t("pageMenu.removeBookmark") : t("pageMenu.bookmark")}
          active={props.isBookmarked}
          onPress={act(props.onBookmark)}
        />
        <Tile id="page-share" icon="share" label={t("pageMenu.share")} onPress={act(props.onShare)} />
      </View>

      <View style={{ marginTop: space.lg }}>
        <Group>
          <ActionRow
            testID="page-display-options"
            icon="textSize"
            label={t("pageMenu.displayOptions")}
            value={zoomed ? `${props.zoom}%` : undefined}
            chevron={!display}
            onPress={() => setDisplay((open) => !open)}
          />
          {display ? (
            <>
              <ActionRow testID="page-translate" icon="translate" label={t("pageMenu.translate")} onPress={act(props.onTranslate)} />
              <ZoomRow zoom={props.zoom} onZoom={props.onZoom} />
              <ActionRow
                testID="page-desktop"
                icon="desktop"
                label={t("site.desktop")}
                toggle={props.desktop}
                onPress={() => props.onDesktop(!props.desktop)}
              />
            </>
          ) : null}
          <ActionRow testID="page-site-settings" icon="tune" label={t("pageMenu.siteSettings")} chevron onPress={act(props.onSiteSettings)} />
          <ActionRow testID="page-more-tools" icon="more" label={t("pageMenu.tools")} chevron onPress={() => setTools(true)} />
          {props.hiddenCount ? (
            <ActionRow
              testID="page-show-hidden"
              icon="visibility"
              label={props.hiddenCount === 1 ? t("pageMenu.hiddenOne") : t("pageMenu.hiddenMany", { count: props.hiddenCount })}
              onPress={act(props.onShowHidden)}
            />
          ) : null}
        </Group>
      </View>

      {props.blocking === "off" ? null : (
        <BlockingCard
          blocking={props.blocking}
          blockedCount={props.blockedCount}
          onToggle={props.onToggleBlocking}
          onRestore={act(props.onRestore)}
          foreground={foreground}
        />
      )}
    </PanelSheet>
  );
}

/** Page zoom, a tenth at a time, kept for this site (the stepper in Display Options). */
function ZoomRow({ zoom, onZoom }: { zoom: number; onZoom: (zoom: number) => void }): JSX.Element {
  const t = useT();
  const foreground = useThemeColor("foreground");
  const step = (up: boolean) => onZoom(zoomStep(zoom, up, TEXT_SIZE.min, TEXT_SIZE.max));

  return (
    <View className="flex-row items-center" style={{ minHeight: pageMenu.rowHeight + 4, paddingLeft: space.lg, paddingRight: space.sm, gap: 14 }}>
      <Icon name="textSize" color={foreground} size={iconSize.control} />
      <Text className="flex-1">{t("site.zoom")}</Text>
      <Text testID="page-zoom-value" variant="subhead" tone="muted">{`${zoom}%`}</Text>
      <View className="flex-row bg-default" style={{ borderRadius: radius.control }}>
        <PressFeedback
          testID="page-zoom-out"
          accessibilityRole="button"
          accessibilityLabel={t("site.zoom.out")}
          disabled={zoom <= TEXT_SIZE.min}
          onPress={() => step(false)}
          className="h-9 w-11 items-center justify-center"
          style={{ opacity: zoom <= TEXT_SIZE.min ? 0.35 : 1 }}
        >
          <Text weight="semibold">−</Text>
        </PressFeedback>
        <PressFeedback
          testID="page-zoom-in"
          accessibilityRole="button"
          accessibilityLabel={t("site.zoom.in")}
          disabled={zoom >= TEXT_SIZE.max}
          onPress={() => step(true)}
          className="h-9 w-11 items-center justify-center"
          style={{ opacity: zoom >= TEXT_SIZE.max ? 0.35 : 1 }}
        >
          <Text weight="semibold">+</Text>
        </PressFeedback>
      </View>
    </View>
  );
}

/**
 * What blocking did on this page (C2): the count where the engine has one, the switch for this site, and a way to see
 * the page as the site made it when blocking broke something.
 */
function BlockingCard({
  blocking,
  blockedCount,
  onToggle,
  onRestore,
  foreground,
}: {
  blocking: Exclude<PageBlocking, "off">;
  blockedCount: number | null;
  onToggle: () => void;
  onRestore: () => void;
  foreground: string;
}): JSX.Element {
  const t = useT();
  const counted = blocking === "on" && blockedCount !== null && blockedCount > 0;

  return (
    <View style={{ marginTop: space.lg }}>
      <Group>
        <ActionRow
          testID="page-blocking"
          icon="shield"
          label={counted ? (blockedCount === 1 ? t("pageMenu.blockedOne") : t("pageMenu.blockedCount", { count: blockedCount })) : t("pageMenu.blocking")}
          detail={blocking === "paused" ? t("pageMenu.blocking.paused") : blocking === "restored" ? t("pageMenu.blocking.restored") : t("pageMenu.blocking.on")}
          toggle={blocking === "on"}
          onPress={onToggle}
        />
        {blocking === "on" ? (
          <PressFeedback
            testID="page-restore"
            accessibilityRole="button"
            accessibilityLabel={t("pageMenu.restore")}
            onPress={onRestore}
            className="flex-row items-center"
            style={{ minHeight: pageMenu.rowHeight - 4, paddingHorizontal: space.lg, gap: 14 }}
          >
            <Icon name="reload" color={foreground} size={iconSize.control} />
            <Text variant="subhead" tone="muted" className="flex-1">
              {t("pageMenu.restore")}
            </Text>
          </PressFeedback>
        ) : null}
      </Group>
    </View>
  );
}

/** The page's title and address, its site behind a lock (or a warning when it isn't encrypted), and what's blocked. */
function SiteHeader({ title, url, blocking }: { title: string; url: string; blocking: PageBlocking }): JSX.Element {
  const muted = useThemeColor("muted");
  const danger = useThemeColor("danger");
  const t = useT();
  const web = /^https?:/.test(url);
  const insecure = url.startsWith("http:");

  const status = [
    web ? (insecure ? t("pageMenu.notSecure") : t("pageMenu.secure")) : "",
    blocking === "on" ? t("pageMenu.blocked") : blocking === "off" ? "" : t("pageMenu.blockingPaused"),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View className="flex-row items-center" style={{ gap: space.md }}>
      {url ? <SiteIcon url={url} size={44} /> : null}
      <View className="flex-1">
        <Text variant="headline" numberOfLines={1} accessibilityRole="header">
          {title || url}
        </Text>
        <Text testID="page-menu-url" variant="footnote" tone="muted" numberOfLines={1}>
          {url}
        </Text>
        {status ? (
          <View className="flex-row items-center" style={{ gap: space.xs, marginTop: space.xxs }} accessible accessibilityLabel={status}>
            {web ? <Icon name={insecure ? "error" : "lock"} color={insecure ? danger : muted} size={iconSize.inline - 2} /> : null}
            <Text variant="caption" weight="regular" tone={insecure ? "danger" : "muted"} numberOfLines={1}>
              {status}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export const PageMenu = quietWhileClosed(PageMenuSheet);
