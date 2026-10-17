import { View } from "@bay/platform";
import NativeBayWindows from "@bay/platform/specs/NativeBayWindows";
import { decodeNativeResult } from "@bay/platform/nativeBridge";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { NativeEventEmitter } from "react-native";
import type { NativeHandle, NativeProps } from "./WebView";

let nextTag = 1;
const invoke = async (method: string, args: unknown[]) => {
  if (!NativeBayWindows) throw new Error("Bay Windows engine bridge is unavailable");
  return decodeNativeResult(await NativeBayWindows.invoke("BayCEF", method, JSON.stringify(args)));
};

/** The native engine owns a child HWND. Layout coordinates are client-area DIPs. */
export default forwardRef<NativeHandle, NativeProps>(function NativeWebView(props, ref) {
  const view = useRef<View>(null);
  const tag = useRef(0);
  if (!tag.current) tag.current = nextTag++;
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(false);
  const alive = useRef(true);
  const lastProps = useRef("");
  const pending = useRef(Promise.resolve());
  const enqueue = (method: string, args: unknown[]) => {
    const call = pending.current.then(() => invoke(method, args));
    pending.current = call.then(() => undefined, error => console.error(`[BayCEF.${method}]`, error));
    return call;
  };
  const layout = () => view.current?.measureInWindow((x, y, width, height) => {
    if (!alive.current || !width || !height) return;
    const current = latest.current;
    const extra = Object.fromEntries(Object.entries(current).filter(([key, value]) => key !== "style" && typeof value !== "function"));
    if (!mounted.current) {
      mounted.current = true;
      lastProps.current = JSON.stringify(extra);
      void enqueue("mount", [tag.current, current.url ?? "about:blank", current.profile ?? "", x, y, width, height, extra]);
    } else void enqueue("bounds", [tag.current, x, y, width, height]);
  });
  useImperativeHandle(ref, () => new Proxy({} as NativeHandle, {
    get: (_target, method) => typeof method === "string"
      ? (...args: unknown[]) => enqueue("viewCall", [tag.current, method, args])
      : undefined,
  }), []);
  useEffect(() => {
    alive.current = true;
    if (!NativeBayWindows) return;
    const emitter = new NativeEventEmitter(NativeBayWindows);
    const subscription = emitter.addListener("BayCEF.onViewEvent", (event: { tag: number; event: string; payload: unknown }) => {
      if (event.tag !== tag.current) return;
      const handler = (latest.current as unknown as Record<string, unknown>)[event.event];
      if (typeof handler === "function") handler({ nativeEvent: event.payload });
    });
    return () => {
      alive.current = false;
      subscription.remove();
      if (mounted.current) void enqueue("unmount", [tag.current]);
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!mounted.current) return;
    const extra = Object.fromEntries(Object.entries(props).filter(([key, value]) => key !== "style" && typeof value !== "function"));
    const serialized = JSON.stringify(extra);
    if (serialized !== lastProps.current) {
      lastProps.current = serialized;
      void enqueue("updateProps", [tag.current, extra]);
    }
  });
  return <View ref={view} style={props.style} onLayout={layout} collapsable={false} />;
});
