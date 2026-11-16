import { useThemeColor } from "heroui-native";
import type { JSX } from "react";

import { Icon } from "@/chrome/Icon";
import { PressFeedback } from "@/chrome/PressFeedback";
import { iconSize } from "@/chrome/tokens";

import type { HeadButtonProps } from "./HeadButton.types";

/** Settings' round button on the left of its head: a flat plate with a hairline edge, × on the index, ‹ on a page. */
export function HeadButton({ testID, kind, label, onPress }: HeadButtonProps): JSX.Element {
  const foreground = useThemeColor("foreground");

  return (
    <PressFeedback
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      className="h-11 w-11 items-center justify-center rounded-full border border-black/10 bg-white/90 dark:border-white/10 dark:bg-neutral-900/90"
    >
      <Icon name={kind === "close" ? "close" : "back"} color={foreground} size={iconSize.control} />
    </PressFeedback>
  );
}
