import type { ViewProps, PressableProps, TextInputProps, ScrollViewProps, StyleProp, ViewStyle, TextStyle } from "react-native";

export type KeyDownEventSpec = { key: string; shiftKey?: boolean; metaKey?: boolean; altKey?: boolean; ctrlKey?: boolean; charactersIgnoringModifiers?: string };
type DropEvent = { nativeEvent: { dataTransfer?: { files?: { uri: string }[] } } };
export type MacOnlyProps = {
  tooltip?: string;
  enableFocusRing?: boolean;
  keyDownEvents?: KeyDownEventSpec[];
  mouseDownCanMoveWindow?: boolean;
  draggedTypes?: string[];
  onMouseEnter?: (...args: any[]) => void;
  onMouseLeave?: (...args: any[]) => void;
  onDoubleClick?: () => void;
  onDragEnter?: (event: DropEvent) => void;
  onDragLeave?: (event: DropEvent) => void;
  onDrop?: (event: DropEvent) => void;
};
export type DesktopViewStyle = Omit<ViewStyle, "cursor"> & { cursor?: ViewStyle["cursor"] | "col-resize" | "row-resize" };
type DesktopTextStyle = Omit<TextStyle, "cursor"> & { cursor?: DesktopViewStyle["cursor"] };
type DesktopProps<P> = Omit<P, keyof MacOnlyProps | "style"> & MacOnlyProps;
export type CompatViewProps = DesktopProps<ViewProps> & { style?: StyleProp<DesktopViewStyle> };
export type CompatPressableProps = DesktopProps<PressableProps> & { style?: StyleProp<DesktopViewStyle> | ((state: { pressed: boolean }) => StyleProp<DesktopViewStyle>) };
export type CompatTextInputProps = DesktopProps<TextInputProps> & { style?: StyleProp<DesktopTextStyle> };
export type CompatScrollViewProps = DesktopProps<ScrollViewProps> & { style?: StyleProp<DesktopViewStyle> };

