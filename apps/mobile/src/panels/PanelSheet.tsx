import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { BottomSheet, Typography } from "heroui-native";
import type { JSX, ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
              {children}
            </BottomSheetScrollView>
          </View>
        </BottomSheet.Content>
      </BottomSheet.Portal>
    </BottomSheet>
  );
}

export function ActionRow({
  testID,
  label,
  detail,
  onPress,
  disabled = false,
  selected = false,
  destructive = false,
}: {
  testID: string;
  label: string;
  detail?: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  destructive?: boolean;
}): JSX.Element {
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
      <View className="flex-1">
        <Typography className={destructive ? "text-danger" : "text-foreground"} style={{ fontSize: 16, lineHeight: 22 }}>
          {label}
        </Typography>
        {detail ? (
          <Typography className="text-sm text-muted" numberOfLines={2}>
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
