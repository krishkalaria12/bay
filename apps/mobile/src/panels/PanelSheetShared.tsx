import { BottomSheetScrollView, type BottomSheetBackgroundProps } from "@gorhom/bottom-sheet";
import { BottomSheet, useThemeColor } from "heroui-native";
import { Children, createContext, isValidElement, useContext, useEffect, useState, type FC, type JSX, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { SPRING, useReducedMotion } from "@/chrome/motion";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { Toggle } from "@/chrome/Toggle";
import { fontFor, iconSize, radius, rowHeight, space } from "@/chrome/tokens";
import { useT } from "@/i18n";

import { holdSheetOpen } from "./openSheets";

export interface PanelSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  testID: string;
  children: ReactNode;
  height?: string;
  dismissible?: boolean;
  /** Shows a back arrow before the title, for a sub-page inside the sheet. */
  onBack?: () => void;
  /** Drawn in place of the title (which still names the close button). */
  header?: ReactNode;
  /**
   * Draws the sheet's background surface in place of the solid one (iOS's Liquid Glass). It is the bottom sheet's
   * background layer, so it sits under the handle as well as the content. Pass a stable component, not an inline one.
   */
  background?: FC<BottomSheetBackgroundProps>;
  /** The children bring their own scrolling (a LegendList); the sheet doesn't wrap them in a scroll view. */
  listMode?: boolean;
  /** Round buttons beside the close button (`SheetIconButton`). */
  accessory?: ReactNode;
}

export function PanelSheetShared({
  visible,
  onClose,
  title,
  testID,
  children,
  height = "65%",
  dismissible = true,
  onBack,
  header,
  background,
  listMode = false,
  accessory,
}: PanelSheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const foreground = useThemeColor("foreground");
  const reduced = useReducedMotion();
  const t = useT();
  // HeroUI renders a closed sheet's content anyway, so every panel's rows would render with the browser. Content
  // mounts on open and stays until the sheet finishes animating closed.
  const [shown, setShown] = useState(visible);

  if (visible && !shown) setShown(true);

  // While it is open the browser behind steps out of VoiceOver and TalkBack (openSheets.ts). It counts from the moment
  // it opens to the moment it is asked to close, not to the end of its animation, so the page is back at once.
  useEffect(() => {
    if (!visible) return;

    return holdSheetOpen();
  }, [visible]);

  return (
    <BottomSheet
      isOpen={visible}
      onOpenChange={(open) => {
        if (!open && dismissible) onClose();
      }}
    >
      {/* In the app's own window, not react-native-screens' full-window overlay (iOS only). That overlay hangs off the
          UIWindow with no view controller above it, and Expo UI's Host only draws its SwiftUI when it finds one, so a
          sheet there lost its glass, its icons and its pill buttons. */}
      <BottomSheet.Portal disableFullWindowOverlay>
        <BottomSheet.Overlay variant="default" isCloseOnPress={dismissible} />
        <BottomSheet.Content
          snapPoints={[height]}
          enableDynamicSizing={false}
          enableOverDrag={false}
          enablePanDownToClose={dismissible}
          // Drag by the handle only: a pan gesture over the content competed with taps on its rows and buttons, and
          // on iOS quick taps were sometimes lost. The sheets are short; Done and tapping outside also close them.
          enableContentPanningGesture={false}
          // Every sheet springs the same way (A8), so they all feel like one thing.
          animationConfigs={{
            damping: SPRING.damping,
            stiffness: SPRING.stiffness,
            mass: SPRING.mass,
            reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System,
          }}
          onClose={() => setShown(false)}
          contentContainerClassName="h-full"
          backgroundClassName={background ? "bg-transparent" : "bg-surface"}
          backgroundStyle={{ borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet }}
          backgroundComponent={background}
        >
          {/* Modal for VoiceOver: what sits beside the sheet's content inside the sheet is skipped too. */}
          <View testID={testID} className="flex-1" accessibilityViewIsModal>
            <View
              className="flex-row items-center"
              style={{
                gap: space.md,
                paddingLeft: insets.left + space.gutter,
                paddingRight: insets.right + space.gutter,
                paddingTop: space.xs,
                paddingBottom: space.md,
              }}
            >
              <View className="flex-1 flex-row items-center" style={{ gap: space.xs }}>
                {onBack ? (
                  <View style={{ marginLeft: -space.xs, marginRight: space.xs }}>
                    <SheetIconButton testID={`${testID}-back`} icon="back" label={t("sheet.back")} onPress={onBack} tone="default" />
                  </View>
                ) : null}
                {header && !onBack ? (
                  <View className="flex-1">{header}</View>
                ) : (
                  <BottomSheet.Title accessibilityRole="header" numberOfLines={1} className="flex-1" style={[fontFor("title"), { color: foreground }]}>
                    {title}
                  </BottomSheet.Title>
                )}
              </View>
              <View className={`flex-row ${header && !onBack ? "self-start" : ""}`} style={{ gap: space.sm }}>
                {accessory}
                <SheetIconButton testID={`${testID}-close`} icon="close" label={t("sheet.close", { title })} disabled={!dismissible} onPress={onClose} />
              </View>
            </View>
            {listMode ? (
              <View className="flex-1">{visible || shown ? children : null}</View>
            ) : (
              <BottomSheetScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{
                  paddingLeft: insets.left + space.gutter,
                  paddingRight: insets.right + space.gutter,
                  paddingBottom: Math.max(insets.bottom, space.gutter) + space.md,
                }}
              >
                {visible || shown ? children : null}
              </BottomSheetScrollView>
            )}
          </View>
        </BottomSheet.Content>
      </BottomSheet.Portal>
    </BottomSheet>
  );
}

export function ActionRow({
  testID,
  icon,
  label,
  detail,
  onPress,
  disabled = false,
  selected = false,
  destructive = false,
  value,
  chevron = false,
  toggle,
}: {
  testID: string;
  icon?: IconName;
  label: string;
  detail?: string;
  onPress: () => void;
  disabled?: boolean;
  /** A check mark, for one choice in a list. */
  selected?: boolean;
  destructive?: boolean;
  /** The current setting, before the chevron. */
  value?: string;
  /** Opens a sub-page. */
  chevron?: boolean;
  /** A switch showing this state; the whole row flips it. */
  toggle?: boolean;
}): JSX.Element {
  const muted = useThemeColor("muted");
  const danger = useThemeColor("danger");
  const foreground = useThemeColor("foreground");
  const accent = useThemeColor("accent");
  const grouped = useContext(InGroup);
  const t = useT();
  // The row reads as one control, so its current setting and its explanation are read after the label.
  const spoken = [value, detail].filter(Boolean).join(", ");

  return (
    <PressFeedback
      testID={testID}
      accessibilityRole={toggle === undefined ? "button" : "switch"}
      accessibilityLabel={label}
      accessibilityState={toggle === undefined ? { disabled, selected } : { disabled, checked: toggle }}
      accessibilityValue={spoken ? { text: spoken } : undefined}
      disabled={disabled}
      onPress={onPress}
      className={grouped ? "flex-row items-center active:bg-foreground/5" : "flex-row items-center border-b border-foreground/5"}
      style={{
        minHeight: rowHeight,
        gap: ROW_GAP,
        paddingHorizontal: grouped ? ROW_INSET : 0,
        paddingVertical: space.md,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {icon ? <Icon name={icon} color={destructive ? danger : foreground} size={iconSize.control} /> : null}
      <View className="flex-1" style={{ gap: 1 }}>
        <Text variant="body" tone={destructive ? "danger" : "default"}>
          {label}
        </Text>
        {detail ? (
          <Text testID={`${testID}-detail`} variant="subhead" tone="muted" numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text testID={`${testID}-value`} variant="subhead" tone="muted" numberOfLines={1} style={{ maxWidth: "45%" }}>
          {value}
        </Text>
      ) : null}
      {chevron ? <Icon name="chevron" color={muted} size={iconSize.small} /> : null}
      {toggle !== undefined ? <Toggle value={toggle} disabled={disabled} /> : null}
      {selected ? (
        <View accessible accessibilityLabel={t("sheet.selected")}>
          <Icon name="tick" color={accent} size={iconSize.row} />
        </View>
      ) : null}
    </PressFeedback>
  );
}

/** A round button in a sheet's header: close, back, or one of the sheet's own (`accessory`). */
export function SheetIconButton({
  testID,
  icon,
  label,
  onPress,
  disabled = false,
  tone = "muted",
}: {
  testID: string;
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "default" | "muted";
}): JSX.Element {
  const color = useThemeColor(tone === "muted" ? "muted" : "foreground");

  return (
    <PressFeedback
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      className="h-9 w-9 items-center justify-center rounded-full bg-default"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Icon name={icon} color={color} size={iconSize.small} />
    </PressFeedback>
  );
}

/** A row's side padding inside a group, and the space between its icon and its text. */
const ROW_INSET = space.lg;
const ROW_GAP = 14;

/**
 * A section's heading: small, quiet, and lined up with what follows it. Over a group it steps in to the rows' inset;
 * over a plain list it starts where the list does.
 */
export function SectionLabel({ children, inset = false }: { children: ReactNode; inset?: boolean }): JSX.Element {
  return (
    <Text
      accessibilityRole="header"
      variant="footnote"
      weight="semibold"
      tone="muted"
      style={{ marginTop: space.section, marginBottom: space.sm, paddingHorizontal: inset ? ROW_INSET : 0 }}
    >
      {children}
    </Text>
  );
}

const InGroup = createContext(false);

/** Rows on one rounded card, split by hairlines that start where the rows' text does. */
export function Group({ label, children, testID }: { label?: string; children: ReactNode; testID?: string }): JSX.Element {
  const rows = Children.toArray(children).filter(isValidElement);

  // SAFETY: rows are the card's ActionRow children, whose props carry the icon name exactly when an icon is drawn.
  return (
    <View testID={testID}>
      {label ? <SectionLabel inset>{label}</SectionLabel> : null}
      <InGroup.Provider value>
        <View className="overflow-hidden bg-default" style={{ borderRadius: radius.card }}>
          {rows.map((row, index) => (
            <View key={row.key ?? index}>
              {index ? (
                <View
                  className="bg-foreground/10"
                  style={{
                    height: StyleSheet.hairlineWidth,
                    marginLeft: (row.props as { icon?: unknown }).icon ? ROW_INSET + iconSize.control + ROW_GAP : ROW_INSET,
                  }}
                />
              ) : null}
              {row}
            </View>
          ))}
        </View>
      </InGroup.Provider>
    </View>
  );
}
