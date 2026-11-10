import * as v from "valibot";
import { checked } from "./json.ts";
import { forwardRef, useRef, type ComponentRef } from "react";
import {
  Pressable as NativePressable,
  View as NativeView,
  TextInput as NativeTextInput,
  ScrollView as NativeScrollView,
  StyleSheet,
  type PressableProps,
  type ViewProps,
  type TextInputProps,
  type ScrollViewProps,
  type StyleProp,
  type GestureResponderEvent,
} from "react-native";
import { isMac } from "./os";
import { shortcutLabel, platformKeyEvents } from "./shortcuts";

import type { CompatViewProps, CompatPressableProps, CompatTextInputProps, CompatScrollViewProps, MacOnlyProps, DesktopViewStyle } from "./viewTypes";

export type { CompatViewProps, CompatPressableProps, CompatTextInputProps, CompatScrollViewProps, MacOnlyProps, KeyDownEventSpec } from "./viewTypes";

// oxlint-disable-next-line anti-slop/no-known-value-widening -- The table is a lookup by key name, so its open shape is the point.
const KEY_CODES: Record<string, string> = {
  " ": "Space",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
  "/": "Slash",
  ",": "Comma",
  ".": "Period",
  "[": "BracketLeft",
  "]": "BracketRight",
  "-": "Minus",
  "=": "Equal",
};

export function keyCode(key: string): string {
  return KEY_CODES[key] ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key);
}

/** A view's style: the flat shape, or the pressed-state function RNW accepts. */
type ViewStyle = StyleProp<DesktopViewStyle> | ((state: { pressed: boolean }) => ViewStyle);

function nativeStyle(style: ViewStyle): ViewStyle {
  if (v.is(v.function_(), style)) {
    const pressed = checked<(state: { pressed: boolean }) => ViewStyle>(style);

    return (state) => nativeStyle(pressed(state));
  }

  // SAFETY: the check above established that the style is the flat shape.
  const flat = StyleSheet.flatten(style as StyleProp<DesktopViewStyle>);

  if (flat?.cursor === "col-resize" || flat?.cursor === "row-resize") return { ...flat, cursor: "auto" };

  return style;
}

/** Both desktop targets support hover, tooltips and focus rings. RNW intercepts physical key codes. */
function usePlatformProps<P extends MacOnlyProps & { style?: ViewStyle; onTouchEnd?: (event: GestureResponderEvent) => void }>(props: P) {
  const lastClick = useRef<{ time: number; x: number; y: number } | null>(null);
  const label = props.tooltip ? shortcutLabel(props.tooltip) : undefined;

  if (isMac) return { ...props, tooltip: label };

  const {
    keyDownEvents,
    mouseDownCanMoveWindow: _mouseDownCanMoveWindow,
    draggedTypes: _draggedTypes,
    onDoubleClick,
    onDragEnter: _onDragEnter,
    onDragLeave: _onDragLeave,
    onDrop: _onDrop,
    ...rest
  } = props;

  return {
    ...rest,
    tooltip: label,
    style: nativeStyle(props.style),
    ...(keyDownEvents
      ? { keyDownEvents: platformKeyEvents(keyDownEvents).map(({ key, ...event }) => ({ ...event, code: keyCode(key), handledEventPhase: 3 })) }
      : undefined),
    ...(onDoubleClick
      ? {
          onTouchEnd: (event: GestureResponderEvent) => {
            props.onTouchEnd?.(event);
            const { timestamp: time, pageX: x, pageY: y } = event.nativeEvent;
            const previous = lastClick.current;

            if (previous && time - previous.time <= 400 && Math.hypot(x - previous.x, y - previous.y) <= 4) {
              lastClick.current = null;
              onDoubleClick();
            } else lastClick.current = { time, x, y };
          },
        }
      : undefined),
  };
}

// Cast only at the native boundary: the adapter translates our shared desktop props to each target's shape.
export const View = forwardRef<ComponentRef<typeof NativeView>, CompatViewProps>(function View(props, ref) {
  // SAFETY: the platform's own props are the native view's props.
  return <NativeView ref={ref} {...(usePlatformProps(props) as ViewProps)} />;
});

export const Pressable = forwardRef<ComponentRef<typeof NativeView>, CompatPressableProps>(function Pressable(props, ref) {
  // SAFETY: the platform's own props are the native pressable's props.
  return <NativePressable ref={ref} {...(usePlatformProps(props) as PressableProps)} />;
});

export const TextInput = forwardRef<ComponentRef<typeof NativeTextInput>, CompatTextInputProps>(function TextInput(props, ref) {
  // SAFETY: the platform's own props are the native text input's props.
  return <NativeTextInput ref={ref} {...(usePlatformProps(props) as TextInputProps)} />;
});

export const ScrollView = forwardRef<ComponentRef<typeof NativeScrollView>, CompatScrollViewProps>(function ScrollView(props, ref) {
  // SAFETY: the platform's own props are the native scroll view's props.
  return <NativeScrollView ref={ref} {...(usePlatformProps(props) as ScrollViewProps)} />;
});

export type View = ComponentRef<typeof NativeView>;

export type TextInput = ComponentRef<typeof NativeTextInput>;

export type ScrollView = ComponentRef<typeof NativeScrollView>;
