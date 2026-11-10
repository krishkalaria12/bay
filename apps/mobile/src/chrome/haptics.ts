import * as Haptics from "expo-haptics";

/** One light tick, for a committed action (I6): closing a tab, pinning a site, opening the link menu. */
export function tick(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}
