import { useThemeColor } from "heroui-native";
import { useEffect, useState, type JSX } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";

import { Surface } from "@/chrome/Surface";

export interface ToastAction {
  label: string;
  onPress: () => void;
}

interface ToastMessage {
  key: number;
  text: string;
  action?: ToastAction;
}

/** One short message above the bottom bar at a time; a newer one replaces it. Messages with an action stay longer. */
export function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.action ? 8000 : 2500);

    return () => clearTimeout(timer);
  }, [toast]);

  return {
    toast,
    show: (text: string, action?: ToastAction) => setToast({ key: Date.now(), text, action }),
    dismiss: () => setToast(null),
  };
}

export function Toast({ text, action, onDone, testID = "toast" }: { text: string; action?: ToastAction; onDone?: () => void; testID?: string }): JSX.Element {
  const foreground = useThemeColor("foreground");
  const accent = useThemeColor("accent");

  return (
    <Animated.View entering={FadeInDown.duration(200)} exiting={FadeOutDown.duration(150)}>
      <Surface radius={22} style={{ paddingLeft: 16, paddingRight: action ? 6 : 16, paddingVertical: action ? 6 : 12 }}>
        <View className="flex-row items-center gap-2">
          <Text testID={testID} accessibilityRole="alert" numberOfLines={2} className="flex-1" style={{ color: foreground, fontSize: 15 }}>
            {text}
          </Text>
          {action ? (
            <Pressable
              testID={`${testID}-action`}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={() => {
                onDone?.();
                action.onPress();
              }}
              className="min-h-11 items-center justify-center rounded-full px-4 active:opacity-60"
            >
              <Text style={{ color: accent, fontSize: 15, fontWeight: "600" }}>{action.label}</Text>
            </Pressable>
          ) : null}
        </View>
      </Surface>
    </Animated.View>
  );
}
