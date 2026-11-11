import { EngineView, type PageRequest, type Tab } from "@bay/engine";
import { Typography, useThemeColor } from "heroui-native";
import { useEffect, useRef, useState, type JSX } from "react";
import { View } from "react-native";

import { useT } from "@/i18n";
import { ActionRow, PanelSheet } from "./PanelSheet";

export interface LinkMenuProps {
  visible: boolean;
  onClose: () => void;
  url: string;
  title: string;
  /** Matches the tab whose page the link sits on; the preview keeps nothing either way (its engine has no stateKey). */
  privately: boolean;
  /** The linked site keeps its desktop page (B12); the preview shows the desktop one too. */
  desktopMode: boolean;
  /** A bare image's press (B13): `url` is the image's own address, so the rows answer as images. */
  image: boolean;
  onOpenTab: () => void;
  onOpenBackground: () => void;
  onCopy: () => void;
  onShare: () => void;
  /** Only for images (B13): asks the engine to save the image (Photos on iOS, Downloads on Android). */
  onSave: () => void;
  onResolveDestination: () => Promise<string>;
}

export function LinkMenu(props: LinkMenuProps): JSX.Element {
  const t = useT();

  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title={t("linkMenu.title")} testID="link-menu" height="85%">
      {props.visible ? <LinkActions key={props.url} {...props} /> : null}
    </PanelSheet>
  );
}

function LinkActions(props: LinkMenuProps): JSX.Element {
  const [resolving, setResolving] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  function act(action: () => void): void {
    props.onClose();
    action();
  }

  async function resolveDestination(): Promise<void> {
    if (resolving) return;
    setResolving(true);
    setError(null);

    try {
      const url = await props.onResolveDestination();

      if (mounted.current) setDestination(url);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t("linkMenu.failed"));
    } finally {
      if (mounted.current) setResolving(false);
    }
  }

  return (
    <>
      {props.title && props.title !== props.url ? <Typography numberOfLines={2}>{props.title}</Typography> : null}
      <Peek url={props.url} privately={props.privately} desktopMode={props.desktopMode} />
      <Typography testID="link-menu-url" className="mb-3 text-sm text-muted" numberOfLines={3}>
        {props.url}
      </Typography>
      <ActionRow testID="link-open-tab" label={props.image ? t("linkMenu.openImage") : t("linkMenu.openTab")} onPress={() => act(props.onOpenTab)} />
      {props.image ? (
        <>
          <ActionRow testID="link-image-copy" label={t("linkMenu.copyImage")} onPress={() => act(props.onCopy)} />
          <ActionRow testID="link-image-share" label={t("linkMenu.shareImage")} onPress={() => act(props.onShare)} />
          <ActionRow testID="link-image-save" label={t("linkMenu.saveImage")} onPress={() => act(props.onSave)} />
        </>
      ) : (
        <>
          <ActionRow testID="link-open-background" label={t("linkMenu.openBackground")} onPress={() => act(props.onOpenBackground)} />
          <ActionRow testID="link-copy" label={t("linkMenu.copyLink")} onPress={() => act(props.onCopy)} />
          <ActionRow testID="link-share" label={t("linkMenu.share")} onPress={() => act(props.onShare)} />
          <ActionRow
            testID="link-destination"
            label={resolving ? t("linkMenu.checking") : t("linkMenu.where")}
            disabled={resolving}
            onPress={() => {
              void resolveDestination();
            }}
          />
        </>
      )}
      {destination ? (
        <View className="mt-3 rounded-2xl bg-default p-3" accessibilityLiveRegion="polite">
          <Typography className="mb-1 text-sm text-muted">{t("linkMenu.destination")}</Typography>
          <Typography testID="link-destination-result" selectable>
            {destination}
          </Typography>
        </View>
      ) : null}
      {error ? (
        <Typography testID="link-destination-error" accessibilityRole="alert" accessibilityLiveRegion="assertive" className="mt-3 text-sm text-danger">
          {error}
        </Typography>
      ) : null}
    </>
  );
}

const PREVIEW_HEIGHT = 200;

/**
 * Peek (B11): the link's page, live, in a card of its own. Nothing of it stays (no stateKey, a private store when the
 * tab is private) and nothing of it is answerable (dialogs, sign-ins and app links are turned down as soon as they
 * arrive), so a preview can't change the session. Sites that keep their desktop page preview that way too (B12).
 */
function Peek({ url, privately, desktopMode }: { url: string; privately: boolean; desktopMode: boolean }): JSX.Element {
  const accent = useThemeColor("accent");
  const view = useRef<Tab>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);

  // Only the preview's own questions arrive here, and no one is there to answer them: refuse everything at once, or
  // the page sits waiting forever.
  function refuse(request: PageRequest): void {
    void view.current?.answerPageRequest(request.id, false).catch(() => {});
  }

  return (
    <View
      testID="link-preview"
      className="mb-3 overflow-hidden rounded-2xl bg-default"
      style={{ height: PREVIEW_HEIGHT }}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <EngineView
        ref={view}
        initialUrl={url}
        private={privately}
        desktopMode={desktopMode}
        active
        pullToRefreshEnabled={false}
        style={{ flex: 1 }}
        onNavigationStateChange={({ nativeEvent: state }) => {
          setProgress(state.progress);
          setLoading(state.isLoading);
        }}
        onPageRequest={({ nativeEvent }) => refuse(nativeEvent)}
      />
      {loading ? (
        <View className="absolute top-0 left-0 h-0.5 rounded-full" style={{ width: `${Math.max(8, progress * 100)}%`, backgroundColor: accent }} />
      ) : null}
    </View>
  );
}
