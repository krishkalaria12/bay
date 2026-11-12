import { useEffect, useState, type JSX } from "react";
import { View } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";

import { PressFeedback } from "@/chrome/PressFeedback";
import { announce } from "@/chrome/screenReader";
import { Surface } from "@/chrome/Surface";
import { Text } from "@/chrome/Text";
import { radius, space } from "@/chrome/tokens";

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
  // A toast appears where focus isn't, so it reads itself out; one with an action says the action too.
  useEffect(() => {
    announce(action ? `${text}. ${action.label}` : text);
  }, [text, action]);

  return (
    <Animated.View entering={FadeInDown.duration(200)} exiting={FadeOutDown.duration(150)}>
      <Surface
        radius={radius.card}
        style={{ paddingLeft: space.lg, paddingRight: action ? space.xs + 2 : space.lg, paddingVertical: action ? space.xs + 2 : space.md }}
      >
        <View className="flex-row items-center gap-2">
          <Text testID={testID} accessibilityRole="alert" numberOfLines={2} className="flex-1" variant="callout">
            {text}
          </Text>
          {action ? (
            <PressFeedback
              testID={`${testID}-action`}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={() => {
                onDone?.();
                action.onPress();
              }}
              className="min-h-11 items-center justify-center rounded-full px-4"
            >
              <Text variant="callout" weight="semibold" tone="accent">
                {action.label}
              </Text>
            </PressFeedback>
          ) : null}
        </View>
      </Surface>
    </Animated.View>
  );
}
