import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { BottomSheet, Typography, useThemeColor } from "heroui-native";
import { Children, createContext, isValidElement, useContext, useState, type JSX, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";
import { SPRING, useReducedMotion } from "@/chrome/motion";
import { PressFeedback } from "@/chrome/PressFeedback";
import { Toggle } from "@/chrome/Toggle";

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
  /** Drawn behind the sheet's content (iOS's Liquid Glass); the sheet's own background is transparent then. */
  backdrop?: ReactNode;
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
  backdrop,
  listMode = false,
}: PanelSheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const foreground = useThemeColor("foreground");
  const muted = useThemeColor("muted");
  const reduced = useReducedMotion();
  // HeroUI renders a closed sheet's content anyway, so every panel's rows would render with the browser. Content
  // mounts on open and stays until the sheet finishes animating closed.
  const [shown, setShown] = useState(visible);

  if (visible && !shown) setShown(true);

  return (
    <BottomSheet
      isOpen={visible}
      onOpenChange={(open) => {
        if (!open && dismissible) onClose();
      }}
    >
      <BottomSheet.Portal unstable_accessibilityContainerViewIsModal>
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
          backgroundClassName={backdrop ? "rounded-t-[28px] bg-transparent" : "rounded-t-[28px] bg-background"}
        >
          {backdrop}
          <View testID={testID} className="flex-1">
            <View className="flex-row items-center gap-3 px-5 pb-3" style={{ paddingLeft: insets.left + 20, paddingRight: insets.right + 20 }}>
              <View className="flex-1 flex-row items-center gap-1">
                {onBack ? (
                  <Pressable
                    testID={`${testID}-back`}
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                    onPress={onBack}
                    className="-ml-2.5 h-11 w-11 items-center justify-center rounded-full active:opacity-60"
                  >
                    <Icon name="back" color={foreground} size={22} />
                  </Pressable>
                ) : null}
                {header && !onBack ? (
                  <View className="flex-1">{header}</View>
                ) : (
                  <BottomSheet.Title className="text-xl font-semibold">{title}</BottomSheet.Title>
                )}
              </View>
              <Pressable
                testID={`${testID}-close`}
                accessibilityRole="button"
                accessibilityLabel={`Close ${title}`}
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

  return (
    <PressFeedback
      testID={testID}
      accessibilityRole={toggle === undefined ? "button" : "switch"}
      accessibilityLabel={label}
      accessibilityState={toggle === undefined ? { disabled, selected } : { disabled, checked: toggle }}
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
        <Typography accessibilityLabel="Selected" className="text-accent">
          ✓
        </Typography>
      ) : null}
    </PressFeedback>
  );
}

export function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return <Typography className="mt-5 mb-1 text-sm font-medium text-muted">{children}</Typography>;
}

const InGroup = createContext(false);

/** Rows on one rounded card, split by hairlines that start after the icons. */
export function Group({ label, children, testID }: { label?: string; children: ReactNode; testID?: string }): JSX.Element {
  const rows = Children.toArray(children).filter(isValidElement);

  // SAFETY: rows are the card's ActionRow children, whose props carry the icon name exactly when an icon is drawn.
  return (
    <View testID={testID}>
      {label ? <Typography className="mb-2 mt-5 px-1 text-[13px] font-medium text-muted">{label}</Typography> : null}
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
