import { Typography } from "heroui-native";
import type { JSX } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { StartToolbar } from "@/chrome/StartToolbar";

// Placeholder start page: the shared HeroUI hint above the per-platform toolbar (glass on iOS, flat on Android).
// The real start page lands in phase 2 of docs/mobile-plan.html.
export default function StartScreen(): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <View className="flex-1 items-center justify-end pb-6">
        <Typography.Paragraph className="text-muted">Tap to search</Typography.Paragraph>
      </View>
      <StartToolbar />
    </View>
  );
}
