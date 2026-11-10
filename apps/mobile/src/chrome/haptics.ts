import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

/** One light tick, for a committed action (I6): closing a tab, pinning a site, opening the link menu. */
export function tick(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/**
 * A softer click, for a tap that only moves something on screen: a chip, the switcher snapping onto a card. Android
 * has one tick of its own (A3), so both apps answer a tap the same way.
 */
export function press(): void {
  if (Platform.OS === "android") return tick();

  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => {});
}

/** A confirmation, for an action that finished: a link sent, a file saved. */
export function done(): void {
  if (Platform.OS === "android") return tick();

  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}
