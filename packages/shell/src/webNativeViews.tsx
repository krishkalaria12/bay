import { forwardRef, useCallback, useLayoutEffect, useRef, type ComponentRef, type ComponentType, type CSSProperties, type ForwardedRef } from "react";
import { ActivityIndicator, Image, Text, type TextStyle } from "react-native";
import { View, type ViewProps } from "@bay/platform";
import type { ContextMenuAreaProps, DockSelectionProps, FadeLabelProps, GlassEffectProps, SurfaceProps, SymbolProps, VisualEffectProps } from "./index";
import type { MiddleClickEvent, MouseAreaProps } from "./system";
import { fluentSymbol, svgSymbol } from "./symbols.web";

type ViewRef = ComponentRef<typeof View>;
type CSS = CSSProperties & { WebkitAppRegion?: "drag" | "no-drag"; WebkitBackdropFilter?: string; WebkitMaskImage?: string };
type BoxProps = ViewProps & { css?: CSS; configure?: (element: HTMLElement) => void | (() => void) };
function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}
/** RN Web keeps layout and accessibility semantics; CSS-only effects stay at the DOM boundary. */
const Box = forwardRef<ViewRef, BoxProps>(function Box({ css, configure, ...props }, ref) {
  const element = useRef<HTMLElement | null>(null);
  const bind = useCallback(
    (value: ViewRef | null) => {
      element.current = value instanceof HTMLElement ? value : null;
      assignRef(ref, value);
    },
    [ref],
  );
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !css) return;
    const previous = new Map<string, string>();
    for (const [name, value] of Object.entries(css)) {
      const property = name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
      previous.set(property, node.style.getPropertyValue(property));
      node.style.setProperty(property, typeof value === "number" ? String(value) : (value ?? ""));
    }
    return () => {
      for (const [property, value] of previous) node.style.setProperty(property, value);
    };
  }, [css]);
  useLayoutEffect(() => {
    if (element.current) return configure?.(element.current);
  }, [configure]);
  return <View {...props} ref={bind} />;
});

const weights = { light: "300", regular: "400", medium: "500", semibold: "600", bold: "700" } as const;
function Symbol({ name, size = 16, weight = "regular", color = "currentColor", style, ...props }: SymbolProps) {
  const windowsFont = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  return (
    <View {...props} accessible={false} pointerEvents="none" style={[{ alignItems: "center", justifyContent: "center" }, style]}>
      {windowsFont ? (
        <Text
          accessible={false}
          style={{ fontFamily: "Segoe Fluent Icons, Segoe MDL2 Assets", fontSize: size, color, fontWeight: weights[weight], lineHeight: size + 3 }}
        >
          {fluentSymbol(name)}
        </Text>
      ) : (
        <svg
          aria-hidden="true"
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={color}
          strokeWidth={weight === "bold" ? 2.5 : weight === "light" ? 1.4 : 1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {svgSymbol(name)}
        </svg>
      )}
    </View>
  );
}
function FadeLabel({ text, fontSize, weight = "regular", color, fadeWidth = 16, style, ...props }: FadeLabelProps) {
  const width = Math.max(0, fadeWidth);
  return (
    <Box
      {...props}
      style={style}
      css={{
        overflow: "hidden",
        maskImage: `linear-gradient(to right, #000 calc(100% - ${width}px), transparent)`,
        WebkitMaskImage: `linear-gradient(to right, #000 calc(100% - ${width}px), transparent)`,
      }}
    >
      <Text numberOfLines={1} ellipsizeMode="clip" style={{ fontSize, fontWeight: weights[weight], color, whiteSpace: "nowrap" } as TextStyle}>
        {text}
      </Text>
    </Box>
  );
}
type NativeSurfaceProps = SurfaceProps & {
  surfaceShadowColor?: string;
  surfaceShadowOpacity?: number;
  surfaceShadowRadius?: number;
  surfaceShadowOffset?: [number, number];
};
function Surface({
  fill,
  cornerRadius,
  borderColor,
  borderWidth,
  borderColors,
  shadowColor,
  shadowOpacity,
  shadowRadius,
  shadowOffset,
  surfaceShadowColor,
  surfaceShadowOpacity,
  surfaceShadowRadius,
  surfaceShadowOffset,
  style,
  children,
  ...props
}: NativeSurfaceProps) {
  const colors = borderColors?.length === 4 ? borderColors : undefined;
  const offset = shadowOffset ?? surfaceShadowOffset ?? [0, 0];
  const radius = shadowRadius ?? surfaceShadowRadius ?? 0;
  const opacity = shadowOpacity ?? surfaceShadowOpacity ?? 0;
  const color = shadowColor ?? surfaceShadowColor ?? "#000000";
  const css: CSS = {};
  if (opacity > 0 && radius > 0) css.boxShadow = `${offset[0]}px ${offset[1]}px ${radius}px color-mix(in srgb, ${color} ${opacity * 100}%, transparent)`;
  return (
    <Box
      {...props}
      css={css}
      style={[
        {
          backgroundColor: fill,
          borderRadius: cornerRadius,
          borderColor,
          borderWidth,
          ...(colors ? { borderTopColor: colors[0], borderRightColor: colors[1], borderBottomColor: colors[2], borderLeftColor: colors[3] } : {}),
        },
        style,
      ]}
    >
      {children}
    </Box>
  );
}
function Effect({
  cornerRadius,
  tint,
  dark,
  style,
  children,
  material: _material,
  blendingMode: _blending,
  glassStyle: _glass,
  ...props
}: VisualEffectProps & GlassEffectProps) {
  return (
    <Box
      {...props}
      css={{ backdropFilter: "blur(24px) saturate(1.35)", WebkitBackdropFilter: "blur(24px) saturate(1.35)" }}
      style={[{ borderRadius: cornerRadius, backgroundColor: tint ?? (dark ? "rgba(30,30,30,0.72)" : "rgba(245,245,245,0.72)") }, style]}
    >
      {children}
    </Box>
  );
}
function DockSelection({
  image,
  emoji,
  iconSize = 32,
  cornerRadius,
  style,
  theme: _theme,
  fill,
  stroke,
  strokeWidth,
  dark: _dark,
  glass: _glass,
  ...props
}: DockSelectionProps) {
  return (
    <View
      {...props}
      style={[
        { borderRadius: cornerRadius, alignItems: "center", justifyContent: "center", backgroundColor: fill, borderColor: stroke, borderWidth: strokeWidth },
        style,
      ]}
    >
      {image ? (
        <Image source={{ uri: image }} style={{ width: iconSize, height: iconSize }} />
      ) : emoji ? (
        <Text style={{ fontSize: iconSize }}>{emoji}</Text>
      ) : null}
    </View>
  );
}
function ContextMenuArea({ onContextMenu, captureDescendants = false, ...props }: ContextMenuAreaProps) {
  const configure = useCallback(
    (element: HTMLElement) => {
      const open = (event: MouseEvent) => {
        if (!onContextMenu) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu();
      };
      element.addEventListener("contextmenu", open, captureDescendants);
      return () => element.removeEventListener("contextmenu", open, captureDescendants);
    },
    [onContextMenu, captureDescendants],
  );
  return <Box {...props} configure={configure} />;
}
function MouseArea({
  path,
  onMiddleClick,
  ...props
}: Omit<MouseAreaProps, "onMiddleClick"> & { onMiddleClick?: (event: { nativeEvent: MiddleClickEvent }) => void }) {
  const configure = useCallback(
    (element: HTMLElement) => {
      const middle = (event: MouseEvent) => {
        if (event.button !== 1 || !onMiddleClick) return;
        event.preventDefault();
        event.stopPropagation();
        onMiddleClick({ nativeEvent: { shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey } });
      };
      const drag = (event: DragEvent) => {
        if (!path || !event.dataTransfer) return;
        const file = path.startsWith("file:") ? path : `file:///${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;
        const name = (path.split(/[\\/]/).at(-1) ?? "Download").replace(/:/g, "_");
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("DownloadURL", `application/octet-stream:${name}:${file}`);
        event.dataTransfer.setData("text/uri-list", file);
      };
      const previous = element.draggable;
      element.draggable = !!path;
      element.addEventListener("auxclick", middle);
      element.addEventListener("dragstart", drag);
      return () => {
        element.draggable = previous;
        element.removeEventListener("auxclick", middle);
        element.removeEventListener("dragstart", drag);
      };
    },
    [path, onMiddleClick],
  );
  return <Box {...props} configure={configure} />;
}
const PlainView = forwardRef<ViewRef, ViewProps & { profile?: string; neighbours?: string[] }>(function PlainView(
  { profile: _profile, neighbours: _neighbours, ...props },
  ref,
) {
  return <View {...props} ref={ref} />;
});
const DragRegion = forwardRef<ViewRef, ViewProps>(function DragRegion(props, ref) {
  return <Box {...props} ref={ref} css={{ WebkitAppRegion: "drag" }} />;
});
const views: Record<string, unknown> = {
  BaySymbol: Symbol,
  BayFadeLabel: FadeLabel,
  BayActivitySpinner: (props: ViewProps) => (
    <View {...props}>
      <ActivityIndicator />
    </View>
  ),
  BaySurface: Surface,
  BayVisualEffect: Effect,
  BayGlassEffect: Effect,
  BayDockSelection: DockSelection,
  BayWindowProfile: PlainView,
  BayShell: DragRegion,
  BayContextMenuArea: ContextMenuArea,
  BayFileDrag: MouseArea,
};
export function requireNativeViewManager<P extends object>(name: string): ComponentType<P> {
  const component = views[name];
  if (!component) throw new Error(`No desktop web view adapter for ${name}`);
  return component as ComponentType<P>;
}
