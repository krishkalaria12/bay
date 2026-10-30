import { View, useWindowId } from "@bay/platform";
import { getNativeHostInfo, invokeNative, subscribeNativeEvent } from "@bay/platform/nativeBridge";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Text, type NativeSyntheticEvent } from "react-native";
import type { NativeHandle, NativeProps } from "./WebView";

let nextTag = 1;
type MountedView = { surfaceId: string; browserId: number; chromeTabId: number };
type ViewEvent = { tag: number; event: string; payload: unknown };

/** SurfaceEmbed is an engine-owned compositor surface, never a scripted iframe. */
const NativeWebView = forwardRef<NativeHandle, NativeProps>(function NativeWebView(props, ref) {
  const windowId = useWindowId();
  const activeTag = useRef(0);
  const [surfaceId, setSurfaceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const embed = useRef<HTMLEmbedElement>(null);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const serialized = JSON.stringify(
    Object.fromEntries(
      Object.entries(props).filter(([key, value]) => key !== "style" && key !== "children" && !key.startsWith("on") && typeof value !== "function"),
    ),
  );
  const firstProps = useRef(serialized);
  const latestSerialized = useRef(serialized);
  latestSerialized.current = serialized;
  const preview = getNativeHostInfo().constants.BayShell?.preview === true;

  useImperativeHandle(
    ref,
    () =>
      new Proxy({} as NativeHandle, {
        get(_target, method) {
          if (method === "then" || typeof method !== "string") return undefined;
          return (...args: unknown[]) => {
            const tag = activeTag.current;
            if (!tag) return Promise.reject(new Error("The page view is not mounted"));
            if (method === "focus") embed.current?.focus();
            const result = pending.current.then(() => invokeNative("BayWebView", "call", [tag, method, args]));
            pending.current = result.catch(() => undefined);
            return result;
          };
        },
      }),
    [],
  );

  useEffect(() => {
    const tag = nextTag++;
    activeTag.current = tag;
    setSurfaceId("");
    setError(null);
    const mountedProps = latestSerialized.current;
    firstProps.current = mountedProps;
    let alive = true;
    const events = subscribeNativeEvent("BayCEF", "onViewEvent", (raw) => {
      const event = raw as ViewEvent;
      if (!alive || event.tag !== tag || typeof event.event !== "string") return;
      const handler = latest.current[event.event as keyof NativeProps];
      if (typeof handler === "function")
        (handler as (value: NativeSyntheticEvent<unknown>) => void)({ nativeEvent: event.payload } as NativeSyntheticEvent<unknown>);
    });
    const mount = pending.current
      .catch(() => undefined)
      .then(() => invokeNative<MountedView>("BayWebView", "mount", [tag, windowId ?? "", JSON.parse(mountedProps)]));
    pending.current = mount.then((mounted) => {
      if (!alive) return;
      setSurfaceId(mounted.surfaceId);
      latest.current.onReady?.({ nativeEvent: { browserId: mounted.browserId, tabId: mounted.chromeTabId } } as NativeSyntheticEvent<{
        browserId: number;
        tabId: number;
      }>);
    });
    void pending.current.catch((cause) => {
      if (alive) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      alive = false;
      if (activeTag.current === tag) activeTag.current = 0;
      events.remove();
      pending.current = pending.current
        .catch(() => undefined)
        .then(() => invokeNative("BayWebView", "unmount", [tag]))
        .catch(console.error);
    };
  }, [windowId, props.profile, props.adoptId, props.transferKey, props.extensionHost, props.standalone]);
  useEffect(() => {
    if (serialized === firstProps.current) return;
    firstProps.current = serialized;
    const tag = activeTag.current;
    pending.current = pending.current
      .then(() => invokeNative("BayWebView", "update", [tag, JSON.parse(serialized)]))
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [serialized]);

  // As a macOS page view: one that isn't visible doesn't draw, nor does its error. A warm one stays composited,
  // transparent, so showing it again is immediate; Chrome keeps the last frame of a tab it hid, which would otherwise
  // show through another space's card.
  const hidden = props.visible === false;
  return (
    <View style={props.style}>
      {surfaceId ? (
        <embed
          ref={embed}
          type="application/x-chromium-surface-embed"
          data-content-id={surfaceId}
          tabIndex={hidden ? -1 : 0}
          aria-hidden={hidden || undefined}
          aria-label="Web page"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: 0,
            opacity: hidden ? 0 : 1,
            pointerEvents: hidden ? "none" : undefined,
          }}
        />
      ) : !hidden && (error || preview) ? (
        <Text accessibilityRole={error ? "alert" : undefined} style={{ margin: 24, color: "#8b8791" }}>
          {error ?? "Page rendering is available in the native Chrome host. This is the local UI preview."}
        </Text>
      ) : null}
    </View>
  );
});

export default NativeWebView;

/** The Chrome-hosted desktop has no WebKit (hasWebKit() is false); Chromium serves every page. */
export const webKitView = () => NativeWebView;
