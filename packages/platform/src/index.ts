export { platformOS, isMac, isWindows, capabilities, hasNativeModule } from "./os";
export * from "./types";
export * from "./keys";
export { View, Pressable, TextInput, ScrollView } from "./views";
export { modKey, shortcutLabel, shortcutForCommand, platformKeyEvents } from "./shortcuts";

export type { CompatViewProps as ViewProps, CompatPressableProps as PressableProps, CompatTextInputProps as TextInputProps } from "./views";

export { WindowContext, useWindowId } from "./window";
export { batchedUpdates } from "./batching";
