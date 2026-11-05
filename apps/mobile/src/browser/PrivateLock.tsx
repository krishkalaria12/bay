import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "@/chrome/Icon";

/** Covers a private page after Bay has been in the background, until Face ID, Touch ID or the passcode unlocks it. */
export function PrivateLock({ onUnlock, bottomInset }: { onUnlock: () => void; bottomInset: number }): JSX.Element {
  return (
    <View testID="private-lock" style={[StyleSheet.absoluteFill, { paddingBottom: bottomInset }]} className="items-center justify-center gap-4 bg-neutral-950">
      <Icon name="lock" color="#F4F4F5" size={34} />
      <Text style={{ color: "#F4F4F5", fontSize: 17, fontWeight: "600" }}>Private tabs are locked</Text>
      <Pressable
        testID="private-unlock"
        accessibilityRole="button"
        onPress={onUnlock}
        className="min-h-12 items-center justify-center rounded-full bg-white/15 px-6 active:bg-white/25"
      >
        <Text style={{ color: "#F4F4F5", fontSize: 16 }}>Unlock</Text>
      </Pressable>
    </View>
  );
}
