import type { JSX } from "react";
import { Linking, Platform, View } from "react-native";

import { PressFeedback } from "@/chrome/PressFeedback";
import { Text } from "@/chrome/Text";
import { space } from "@/chrome/tokens";
import { useT, type MessageKey } from "@/i18n";
import { PanelSheet } from "./PanelSheet";

/**
 * How to make Bay the default browser (C11), in the phone's own words, with the button that goes there. iOS has no
 * way to ask; Android's default apps page is one tap away.
 */
export function DefaultBrowserPanel({ visible, onClose }: { visible: boolean; onClose: () => void }): JSX.Element {
  const t = useT();

  const steps: MessageKey[] =
    Platform.OS === "ios"
      ? ["default.ios.step1", "default.ios.step2", "default.ios.step3"]
      : ["default.android.step1", "default.android.step2", "default.ios.step3"];

  function open(): void {
    onClose();

    if (Platform.OS === "ios") void Linking.openSettings();
    else void Linking.sendIntent("android.settings.MANAGE_DEFAULT_APPS_SETTINGS").catch(() => Linking.openSettings());
  }

  return (
    <PanelSheet visible={visible} onClose={onClose} title={t("settings.defaultBrowser")} testID="default-browser-sheet" height="60%">
      <View style={{ gap: space.md, marginTop: space.xs }}>
        {steps.map((step, index) => (
          <View key={step} className="flex-row items-center" style={{ gap: space.md }}>
            <View className="h-8 w-8 items-center justify-center rounded-full bg-accent">
              <Text variant="subhead" weight="semibold" color="#FFFFFF">
                {String(index + 1)}
              </Text>
            </View>
            <Text className="flex-1">{t(step)}</Text>
          </View>
        ))}
      </View>
      <PrimaryButton testID="default-browser-open" label={t("default.open")} onPress={open} />
    </PanelSheet>
  );
}

function PrimaryButton({ testID, label, onPress }: { testID: string; label: string; onPress: () => void }): JSX.Element {
  return (
    <PressFeedback
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="items-center justify-center rounded-full bg-accent"
      style={{ marginTop: space.xl, height: 50 }}
    >
      <Text weight="semibold" color="#FFFFFF">
        {label}
      </Text>
    </PressFeedback>
  );
}
