import { forwardRef, type ComponentRef } from "react";
import {
  Pressable as NativePressable,
  View as NativeView,
  TextInput as NativeTextInput,
  type PressableProps,
  type ViewProps,
  type TextInputProps,
} from "react-native";
import { isMac } from "./os";
import { shortcutLabel, platformKeyEvents } from "./shortcuts";

export type KeyDownEventSpec = {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  charactersIgnoringModifiers?: string;
};
export type MacOnlyProps = {
  tooltip?: string;
  enableFocusRing?: boolean;
  keyDownEvents?: KeyDownEventSpec[];
  mouseDownCanMoveWindow?: boolean;
  draggedTypes?: string[];
  onMouseEnter?: (...args: any[]) => void;
  onMouseLeave?: (...args: any[]) => void;
};
export type CompatViewProps = ViewProps & MacOnlyProps;
export type CompatPressableProps = PressableProps & MacOnlyProps;
export type CompatTextInputProps = TextInputProps & MacOnlyProps;

/** Keep AppKit props on macOS; map keyboard, hover and accessibility to RNW props. */
function platformProps<T extends MacOnlyProps>(props: T): T {
  const label = props.tooltip ? shortcutLabel(props.tooltip) : undefined;
  if (isMac) return { ...props, tooltip: label };
  const { tooltip, enableFocusRing, keyDownEvents, mouseDownCanMoveWindow, draggedTypes, onMouseEnter, onMouseLeave, ...rest } = props;
  return {
    ...rest,
    ...(label ? { accessibilityHint: label } : {}),
    ...(keyDownEvents ? { keyDownEvents: platformKeyEvents(keyDownEvents) } : {}),
    ...(onMouseEnter ? { onPointerEnter: onMouseEnter } : {}),
    ...(onMouseLeave ? { onPointerLeave: onMouseLeave } : {}),
  } as T;
}

export const View = forwardRef<ComponentRef<typeof NativeView>, CompatViewProps>(function View(props, ref) {
  return <NativeView ref={ref} {...platformProps(props)} />;
});
export const Pressable = forwardRef<ComponentRef<typeof NativeView>, CompatPressableProps>(function Pressable(props, ref) {
  return <NativePressable ref={ref} {...platformProps(props)} />;
});
export const TextInput = forwardRef<ComponentRef<typeof NativeTextInput>, CompatTextInputProps>(function TextInput(props, ref) {
  return <NativeTextInput ref={ref} {...platformProps(props)} />;
});

// Match RN's component instance types for existing useRef<View>/useRef<TextInput> call sites.
export type View = ComponentRef<typeof NativeView>;
export type TextInput = ComponentRef<typeof NativeTextInput>;
