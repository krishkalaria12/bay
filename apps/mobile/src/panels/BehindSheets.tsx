import type { JSX } from "react";
import { View, type ViewProps } from "react-native";

import { hiddenFromScreenReaders } from "@/chrome/screenReader";

import { useSheetOpen } from "./openSheets";

/**
 * A view that steps out of VoiceOver's and TalkBack's way while a sheet is open (openSheets.ts). It listens for sheets
 * itself, so a sheet opening or closing renders this view alone, not the screen around it.
 */
export function BehindSheets(props: ViewProps): JSX.Element {
  return <View {...props} collapsable={false} {...hiddenFromScreenReaders(useSheetOpen())} />;
}
