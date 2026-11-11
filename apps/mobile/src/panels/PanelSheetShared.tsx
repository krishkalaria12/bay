import { BottomSheetScrollView, type BottomSheetBackgroundProps } from "@gorhom/bottom-sheet";
import { BottomSheet, Typography, useThemeColor } from "heroui-native";
import { Children, createContext, isValidElement, useContext, useEffect, useState, type FC, type JSX, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { SPRING, useReducedMotion } from "@/chrome/motion";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Toggle } from "@/chrome/Toggle";
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
}: PanelSheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
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
          backgroundClassName={background ? "rounded-t-[28px] bg-transparent" : "rounded-t-[28px] bg-background"}
          backgroundComponent={background}
        >
          {/* Modal for VoiceOver: what sits beside the sheet's content inside the sheet is skipped too. */}
          <View testID={testID} className="flex-1" accessibilityViewIsModal>
            <View className="flex-row items-center gap-3 px-5 pb-3" style={{ paddingLeft: insets.left + 20, paddingRight: insets.right + 20 }}>
              <View className="flex-1 flex-row items-center gap-1">
                {onBack ? (
                  <Pressable
                    testID={`${testID}-back`}
                    accessibilityRole="button"
                    accessibilityLabel={t("sheet.back")}
                    onPress={onBack}
                    className="-ml-2.5 h-11 w-11 items-center justify-center rounded-full active:opacity-60"
                  >
                    <Icon name="back" color={foreground} size={22} />
                  </Pressable>
                ) : null}
                {header && !onBack ? (
                  <View className="flex-1">{header}</View>
                ) : (
                  <BottomSheet.Title accessibilityRole="header" className="text-xl font-semibold">
                    {title}
                  </BottomSheet.Title>
                )}
              </View>
              <Pressable
                testID={`${testID}-close`}
                accessibilityRole="button"
                accessibilityLabel={t("sheet.close", { title })}
                accessibilityState={{ disabled: !dismissible }}
                disabled={!dismissible}
                onPress={onClose}
                hitSlop={6}
                className={`h-9 w-9 items-center justify-center rounded-full bg-default active:opacity-60 ${header && !onBack ? "self-start" : ""}`}
                style={{ opacity: dismissible ? 1 : 0.4 }}
              >
                <Icon name="close" color={muted} size={18} />
              </Pressable>
            </View>
            {listMode ? (
              <View className="flex-1">{visible || shown ? children : null}</View>
            ) : (
              <BottomSheetScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingLeft: insets.left + 20, paddingRight: insets.right + 20, paddingBottom: Math.max(insets.bottom, 20) + 12 }}
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
      // Always an object: Android keeps the last value when the prop goes away, so a row reused for another setting
      // would still read the old one ("Pull to refresh, Google").
      accessibilityValue={{ text: spoken }}
      disabled={disabled}
      onPress={onPress}
      className={
        grouped
          ? "min-h-[52px] flex-row items-center gap-3.5 px-4 py-3 active:bg-foreground/5"
          : "min-h-12 flex-row items-center gap-3 border-b border-foreground/5 py-3"
      }
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      {icon ? <Icon name={icon} color={destructive ? danger : grouped ? foreground : muted} size={22} /> : null}
      <View className="flex-1">
        <Typography className={destructive ? "text-danger" : "text-foreground"} style={{ fontSize: 16, lineHeight: 22 }}>
          {label}
        </Typography>
        {detail ? (
          <Typography testID={`${testID}-detail`} className="text-sm text-muted" numberOfLines={2}>
            {detail}
          </Typography>
        ) : null}
      </View>
      {value ? (
        <Typography testID={`${testID}-value`} numberOfLines={1} className="max-w-[45%] text-sm text-muted">
          {value}
        </Typography>
      ) : null}
      {chevron ? <Icon name="chevron" color={muted} size={20} /> : null}
      {toggle !== undefined ? <Toggle value={toggle} disabled={disabled} /> : null}
      {selected ? (
        <Typography accessibilityLabel={t("sheet.selected")} className="text-accent">
          ✓
        </Typography>
      ) : null}
    </PressFeedback>
  );
}

export function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Typography accessibilityRole="header" className="mt-5 mb-1 text-sm font-medium text-muted">
      {children}
    </Typography>
  );
}

const InGroup = createContext(false);

/** Rows on one rounded card, split by hairlines that start after the icons. */
export function Group({ label, children, testID }: { label?: string; children: ReactNode; testID?: string }): JSX.Element {
  const rows = Children.toArray(children).filter(isValidElement);

  // SAFETY: rows are the card's ActionRow children, whose props carry the icon name exactly when an icon is drawn.
  return (
    <View testID={testID}>
      {label ? (
        <Typography accessibilityRole="header" className="mb-2 mt-5 px-1 text-[13px] font-medium text-muted">
          {label}
        </Typography>
      ) : null}
      <InGroup.Provider value>
        <View className="overflow-hidden rounded-[20px] bg-default">
          {rows.map((row, index) => (
            <View key={row.key ?? index}>
              {/* The hairline starts where the row's text does. */}
              {index ? <View className={(row.props as { icon?: unknown }).icon ? "ml-[52px] h-px bg-foreground/5" : "ml-4 h-px bg-foreground/5"} /> : null}
              {row}
            </View>
          ))}
        </View>
      </InGroup.Provider>
    </View>
  );
}
