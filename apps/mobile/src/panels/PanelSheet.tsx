import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { BottomSheet, Typography, useThemeColor } from "heroui-native";
import { useState, type JSX, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/chrome/Icon";
import type { IconName } from "@/chrome/Icon.types";

export interface PanelSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  testID: string;
  children: ReactNode;
  height?: string;
  dismissible?: boolean;
}

export function PanelSheet({ visible, onClose, title, testID, children, height = "65%", dismissible = true }: PanelSheetProps): JSX.Element {
  const insets = useSafeAreaInsets();
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
          onClose={() => setShown(false)}
          contentContainerClassName="h-full"
          backgroundClassName="rounded-t-[28px] bg-background"
        >
          <View testID={testID} className="flex-1">
            <View className="flex-row items-center justify-between px-5 pb-3">
              <BottomSheet.Title className="text-xl font-semibold">{title}</BottomSheet.Title>
              <Pressable
                testID={`${testID}-close`}
                accessibilityRole="button"
                accessibilityLabel={`Close ${title}`}
                accessibilityState={{ disabled: !dismissible }}
                disabled={!dismissible}
                onPress={onClose}
                className="min-h-11 min-w-11 items-center justify-center rounded-full bg-default px-3"
              >
                <Typography className="text-sm">Done</Typography>
              </Pressable>
            </View>
            <BottomSheetScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 20) + 12 }}
            >
              {visible || shown ? children : null}
            </BottomSheetScrollView>
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
}: {
  testID: string;
  icon?: IconName;
  label: string;
  detail?: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  destructive?: boolean;
}): JSX.Element {
  const muted = useThemeColor("muted");
  const danger = useThemeColor("danger");
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-12 flex-row items-center gap-3 border-b border-foreground/5 py-3"
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      {icon ? <Icon name={icon} color={destructive ? danger : muted} size={22} /> : null}
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
      {selected ? (
        <Typography accessibilityLabel="Selected" className="text-accent">
          ✓
        </Typography>
      ) : null}
    </Pressable>
  );
}

export function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return <Typography className="mt-5 mb-1 text-sm font-medium text-muted">{children}</Typography>;
}
