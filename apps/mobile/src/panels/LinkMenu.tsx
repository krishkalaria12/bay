import { EngineView, type PageRequest, type Tab } from "@bay/engine";
import { Typography, useThemeColor } from "heroui-native";
import { useEffect, useRef, useState, type JSX } from "react";
import { View } from "react-native";

import { ActionRow, PanelSheet } from "./PanelSheet";

export interface LinkMenuProps {
  visible: boolean;
  onClose: () => void;
  url: string;
  title: string;
  /** Matches the tab whose page the link sits on; the preview keeps nothing either way (its engine has no stateKey). */
  privately: boolean;
  onOpenTab: () => void;
  onOpenBackground: () => void;
  onCopy: () => void;
  onShare: () => void;
  onResolveDestination: () => Promise<string>;
}

export function LinkMenu(props: LinkMenuProps): JSX.Element {
  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title="Link" testID="link-menu" height="85%">
      {props.visible ? <LinkActions key={props.url} {...props} /> : null}
    </PanelSheet>
  );
}

function LinkActions(props: LinkMenuProps): JSX.Element {
  const [resolving, setResolving] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Couldn't check this link. Try again.");
    } finally {
      if (mounted.current) setResolving(false);
    }
  }

  return (
    <>
      {props.title && props.title !== props.url ? <Typography numberOfLines={2}>{props.title}</Typography> : null}
      <Peek url={props.url} privately={props.privately} />
      <Typography testID="link-menu-url" className="mb-3 text-sm text-muted" numberOfLines={3}>
        {props.url}
      </Typography>
      <ActionRow testID="link-open-tab" label="Open in new tab" onPress={() => act(props.onOpenTab)} />
      <ActionRow testID="link-open-background" label="Open in background" onPress={() => act(props.onOpenBackground)} />
      <ActionRow testID="link-copy" label="Copy link" onPress={() => act(props.onCopy)} />
      <ActionRow testID="link-share" label="Share" onPress={() => act(props.onShare)} />
      <ActionRow
        testID="link-destination"
        label={resolving ? "Checking destination…" : "Where does it go?"}
        disabled={resolving}
        onPress={() => {
          void resolveDestination();
        }}
      />
      {destination ? (
        <View className="mt-3 rounded-2xl bg-default p-3">
          <Typography className="mb-1 text-sm text-muted">Destination</Typography>
          <Typography testID="link-destination-result" selectable>
            {destination}
          </Typography>
        </View>
      ) : null}
      {error ? (
        <Typography testID="link-destination-error" accessibilityRole="alert" className="mt-3 text-sm text-danger">
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
 * arrive), so a preview can't change the session.
 */
function Peek({ url, privately }: { url: string; privately: boolean }): JSX.Element {
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
