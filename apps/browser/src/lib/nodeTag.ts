import { findNodeHandle, Platform } from "react-native";

type Handle = Parameters<typeof findNodeHandle>[0];

/** A view's native tag for the macOS modules that take one. React Native Web has no tags: its findNodeHandle throws,
 *  and none of those modules exist there. */
export const nodeTag = (view: Handle): number | null => (Platform.OS === "web" ? null : findNodeHandle(view));
