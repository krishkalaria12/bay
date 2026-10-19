import { forwardRef, useCallback, useLayoutEffect, useRef, type ComponentRef, type ForwardedRef } from "react";
import { Pressable as NativePressable, View as NativeView, TextInput as NativeTextInput, ScrollView as NativeScrollView, type ViewProps as NativeViewProps, type PressableProps as NativePressableProps, type TextInputProps as NativeTextInputProps, type ScrollViewProps as NativeScrollViewProps } from "react-native";
import { shortcutLabel, platformKeyEvents } from "./shortcuts";
import type { CompatViewProps, CompatPressableProps, CompatTextInputProps, CompatScrollViewProps, MacOnlyProps, KeyDownEventSpec } from "./viewTypes";
export type { CompatViewProps, CompatPressableProps, CompatTextInputProps, CompatScrollViewProps, MacOnlyProps, KeyDownEventSpec } from "./viewTypes";

import { webKeyMatches } from "./webKeyboard";
export { keyCode, webKeyMatches } from "./webKeyboard";
function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}
type Adaptable = MacOnlyProps & { onKeyDown?: unknown; onKeyUp?: unknown };
function useWebProps<T, P extends Adaptable>(props: P, forwardedRef: ForwardedRef<T>) {
  const element = useRef<HTMLElement | null>(null);
  const latest = useRef(props); latest.current = props;
  const ref = useCallback((value: T | null) => { element.current = value instanceof HTMLElement ? value : null; assignRef(forwardedRef, value); }, [forwardedRef]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const listen = <K extends keyof HTMLElementEventMap>(name: K, handler: (event: HTMLElementEventMap[K]) => void, capture = false) => {
      node.addEventListener(name, handler, capture);
      return () => node.removeEventListener(name, handler, capture);
    };
    const synthetic = (event: KeyboardEvent) => ({ nativeEvent: { key: event.key, code: event.code, keyCode: event.keyCode, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, repeat: event.repeat }, preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(), target: event.target, currentTarget: event.currentTarget });
    const cleanups = [
      listen("keydown", event => {
        const current = latest.current;
        const wanted = current.keyDownEvents && platformKeyEvents(current.keyDownEvents).some(spec => webKeyMatches(spec, event));
        if (wanted) { event.preventDefault(); event.stopPropagation(); }
        if (typeof current.onKeyDown === "function") current.onKeyDown(synthetic(event));
      }),
      listen("keyup", event => { const callback = latest.current.onKeyUp; if (typeof callback === "function") callback(synthetic(event)); }),
      listen("mouseenter", event => latest.current.onMouseEnter?.({ nativeEvent: event, target: event.target, currentTarget: event.currentTarget })),
      listen("mouseleave", event => latest.current.onMouseLeave?.({ nativeEvent: event, target: event.target, currentTarget: event.currentTarget })),
      listen("dblclick", () => latest.current.onDoubleClick?.()),
      listen("dragenter", event => { if (latest.current.onDragEnter) { event.preventDefault(); latest.current.onDragEnter({ nativeEvent: { dataTransfer: undefined } }); } }),
      listen("dragleave", () => latest.current.onDragLeave?.({ nativeEvent: { dataTransfer: undefined } })),
      listen("dragover", event => { if (latest.current.onDrop) event.preventDefault(); }),
      listen("drop", event => {
        const callback = latest.current.onDrop;
        if (!callback) return;
        event.preventDefault(); event.stopPropagation();
        const uris = (event.dataTransfer?.getData("text/uri-list") ?? "").split(/\r?\n/).filter(value => value && !value.startsWith("#"));
        callback({ nativeEvent: { dataTransfer: { files: uris.map(uri => ({ uri })) } } });
      }),
      listen("focus", () => { if (latest.current.enableFocusRing && node.matches(":focus-visible")) { node.style.outline = "2px solid Highlight"; node.style.outlineOffset = "2px"; } }),
      listen("blur", () => { if (latest.current.enableFocusRing) { node.style.removeProperty("outline"); node.style.removeProperty("outline-offset"); } }),
    ];
    return () => cleanups.forEach(cleanup => cleanup());
  }, []);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    if (props.tooltip) node.title = shortcutLabel(props.tooltip); else node.removeAttribute("title");
    // Chromium drags the window from every descendant of a drag region, so an explicit false must opt back out (as a
    // view refusing the drag does on macOS) or the controls inside never get their clicks.
    if (props.mouseDownCanMoveWindow === undefined) node.style.removeProperty("-webkit-app-region");
    else node.style.setProperty("-webkit-app-region", props.mouseDownCanMoveWindow ? "drag" : "no-drag");
  }, [props.tooltip, props.mouseDownCanMoveWindow]);
  const { tooltip: _tooltip, enableFocusRing: _ring, keyDownEvents: _keys, mouseDownCanMoveWindow: _drag, draggedTypes: _types, onMouseEnter: _enter, onMouseLeave: _leave, onDoubleClick: _double, onDragEnter: _dragEnter, onDragLeave: _dragLeave, onDrop: _drop, onKeyDown: _down, onKeyUp: _up, ...rest } = props;
  return { ref, props: rest };
}
export const View = forwardRef<ComponentRef<typeof NativeView>, CompatViewProps>(function View(props, ref) {
  const bound = useWebProps(props, ref); return <NativeView {...bound.props as NativeViewProps} ref={bound.ref} />;
});
export const Pressable = forwardRef<ComponentRef<typeof NativeView>, CompatPressableProps>(function Pressable(props, ref) {
  const bound = useWebProps(props, ref); return <NativePressable {...bound.props as NativePressableProps} ref={bound.ref} />;
});
export const TextInput = forwardRef<ComponentRef<typeof NativeTextInput>, CompatTextInputProps>(function TextInput(props, ref) {
  const bound = useWebProps(props, ref); return <NativeTextInput {...bound.props as NativeTextInputProps} ref={bound.ref} />;
});
export const ScrollView = forwardRef<ComponentRef<typeof NativeScrollView>, CompatScrollViewProps>(function ScrollView(props, ref) {
  const bound = useWebProps(props, ref); return <NativeScrollView {...bound.props as NativeScrollViewProps} ref={bound.ref} />;
});
export type View = ComponentRef<typeof NativeView>;
export type TextInput = ComponentRef<typeof NativeTextInput>;
export type ScrollView = ComponentRef<typeof NativeScrollView>;
