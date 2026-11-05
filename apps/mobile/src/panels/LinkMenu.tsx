import { Typography } from "heroui-native";
import { useEffect, useRef, useState, type JSX } from "react";
import { View } from "react-native";

import { ActionRow, PanelSheet } from "./PanelSheet";

export interface LinkMenuProps {
  visible: boolean;
  onClose: () => void;
  url: string;
  title: string;
  onOpenTab: () => void;
  onOpenBackground: () => void;
  onCopy: () => void;
  onShare: () => void;
  onResolveDestination: () => Promise<string>;
}

export function LinkMenu(props: LinkMenuProps): JSX.Element {
  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title="Link" testID="link-menu" height="65%">
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
