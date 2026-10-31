import { Button, HStack, Host } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, labelStyle } from "@expo/ui/swift-ui/modifiers";
import { Typography } from "heroui-native";
import type { JSX } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const glassIconButton = [buttonStyle("glass"), labelStyle("iconOnly"), controlSize("large")];

// Placeholder start page: proves HeroUI Native (the hint) and Expo UI (the glass toolbar)
// both render in the dev build. The real start page lands in phase 1 of docs/mobile-plan.html.
export default function StartScreen(): JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <View className="flex-1 items-center justify-end pb-6">
        <Typography.Paragraph className="text-muted">Tap to search</Typography.Paragraph>
      </View>
      <Host matchContents style={{ alignSelf: "center", marginBottom: 8 }}>
        <HStack spacing={28}>
          <Button systemImage="archivebox" label="Archive" modifiers={glassIconButton} />
          <Button systemImage="magnifyingglass" label="Search" modifiers={glassIconButton} />
          <Button systemImage="gearshape" label="Settings" modifiers={glassIconButton} />
        </HStack>
      </Host>
    </View>
  );
}
