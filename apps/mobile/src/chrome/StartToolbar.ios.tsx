import { Button, HStack, Host } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, labelStyle } from "@expo/ui/swift-ui/modifiers";
import type { JSX } from "react";

const glassIconButton = [buttonStyle("glass"), labelStyle("iconOnly"), controlSize("large")];

// iOS: SwiftUI Liquid Glass buttons.
export function StartToolbar(): JSX.Element {
  return (
    <Host matchContents style={{ alignSelf: "center", marginBottom: 8 }}>
      <HStack spacing={28}>
        <Button systemImage="archivebox" label="Archive" modifiers={glassIconButton} />
        <Button systemImage="magnifyingglass" label="Search" modifiers={glassIconButton} />
        <Button systemImage="gearshape" label="Settings" modifiers={glassIconButton} />
      </HStack>
    </Host>
  );
}
