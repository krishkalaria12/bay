import { AccessibilityInfo, Platform } from "react-native";

/**
 * Reads a message out with VoiceOver or TalkBack, for things that appear without focus moving to them (toasts). On
 * iOS it waits for what VoiceOver is already saying instead of cutting it off.
 */
export function announce(message: string): void {
  if (!message) return;

  if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
  else AccessibilityInfo.announceForAccessibility(message);
}

/**
 * Props that take a view and everything in it out of VoiceOver (iOS) and TalkBack (Android) while `hidden`, as for the
 * screen behind an open sheet. Put them on a view with `collapsable={false}`: a view Android flattens away can't hide
 * anything, and one that stops being flattened when the prop changes moves its children to a new native parent.
 */
export function hiddenFromScreenReaders(hidden: boolean) {
  return {
    accessibilityElementsHidden: hidden,
    importantForAccessibility: hidden ? ("no-hide-descendants" as const) : ("auto" as const),
  };
}
