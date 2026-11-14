import { EngineView, type PageRequest, type Tab } from "@bay/engine";
import { useThemeColor } from "heroui-native";
import { useRef, useState, type JSX } from "react";
import { View } from "react-native";

import { LinkResolver } from "@/browser/linkResolver";
import { Text } from "@/chrome/Text";
import { radius, space } from "@/chrome/tokens";
import type { CommandResult } from "@/effect/commands";
import { useScopedWork } from "@/effect/react";
import { useT, type Translate } from "@/i18n";
import { ActionRow, Group, PanelSheet } from "./PanelSheet";

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
}

export function LinkMenu(props: LinkMenuProps): JSX.Element {
  const t = useT();

  return (
    <PanelSheet visible={props.visible} onClose={props.onClose} title={t("linkMenu.title")} testID="link-menu" height="85%">
      {props.visible ? <LinkActions key={props.url} {...props} /> : null}
    </PanelSheet>
  );
}

/** What the menu says when it couldn't find where a link goes: unreachable, or something going wrong on the way. */
function answerError(answer: CommandResult<string | null> | null, t: Translate): string | null {
  if (answer?._tag === "Failed") return t("linkMenu.failed");

  return answer?._tag === "Done" && answer.value === null ? t("linkMenu.unreachable") : null;
}

function LinkActions(props: LinkMenuProps): JSX.Element {
  const t = useT();
  // Resolving belongs to the menu: closing it (or opening it on another link) aborts the request.
  const { run, result } = useScopedWork<string | null>(props.url);
  // The answer that was showing when the user last asked: until a newer one arrives, the menu is still checking.
  const [askedOver, setAskedOver] = useState<CommandResult<string | null> | null | undefined>(undefined);
  const resolving = askedOver !== undefined && result === askedOver;
  const answer = resolving ? null : result;
  const destination = answer?._tag === "Done" ? answer.value : null;
  const error = answerError(answer, t);

  function act(action: () => void): void {
    props.onClose();
    action();
  }

  function resolveDestination(): void {
    if (resolving) return;
    setAskedOver(result);
    run(LinkResolver.use((resolver) => resolver.resolve(props.url)));
  }

  return (
    <>
      <Peek url={props.url} privately={props.privately} desktopMode={props.desktopMode} />
      {props.title && props.title !== props.url ? (
        <Text variant="callout" weight="medium" numberOfLines={2} style={{ paddingHorizontal: space.xs }}>
          {props.title}
        </Text>
      ) : null}
      <Text testID="link-menu-url" variant="footnote" tone="muted" numberOfLines={3} style={{ paddingHorizontal: space.xs, marginBottom: space.lg }}>
        {props.url}
      </Text>
      {props.image ? (
        <Group>
          <ActionRow testID="link-open-tab" icon="add" label={t("linkMenu.openImage")} onPress={() => act(props.onOpenTab)} />
          <ActionRow testID="link-image-copy" icon="copy" label={t("linkMenu.copyImage")} onPress={() => act(props.onCopy)} />
          <ActionRow testID="link-image-share" icon="share" label={t("linkMenu.shareImage")} onPress={() => act(props.onShare)} />
          <ActionRow testID="link-image-save" icon="download" label={t("linkMenu.saveImage")} onPress={() => act(props.onSave)} />
        </Group>
      ) : (
        <Group>
          <ActionRow testID="link-open-tab" icon="add" label={t("linkMenu.openTab")} onPress={() => act(props.onOpenTab)} />
          <ActionRow testID="link-open-background" icon="tabs" label={t("linkMenu.openBackground")} onPress={() => act(props.onOpenBackground)} />
          <ActionRow testID="link-copy" icon="link" label={t("linkMenu.copyLink")} onPress={() => act(props.onCopy)} />
          <ActionRow testID="link-share" icon="share" label={t("linkMenu.share")} onPress={() => act(props.onShare)} />
          <ActionRow
            testID="link-destination"
            icon="forward"
            label={resolving ? t("linkMenu.checking") : t("linkMenu.where")}
            disabled={resolving}
            onPress={resolveDestination}
          />
        </Group>
      )}
      {destination ? (
        <View className="mt-3 bg-default p-4" style={{ borderRadius: radius.card }} accessibilityLiveRegion="polite">
          <Text variant="subhead" tone="muted" className="mb-1">
            {t("linkMenu.destination")}
          </Text>
          <Text testID="link-destination-result" selectable>
            {destination}
          </Text>
        </View>
      ) : null}
      {error ? (
        <Text testID="link-destination-error" accessibilityRole="alert" accessibilityLiveRegion="assertive" variant="subhead" tone="danger" className="mt-3">
          {error}
        </Text>
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
      className="overflow-hidden bg-default"
      style={{ height: PREVIEW_HEIGHT, borderRadius: radius.card, marginBottom: space.md }}
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
