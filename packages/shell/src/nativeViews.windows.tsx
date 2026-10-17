import type { ViewProps } from "@bay/platform";
import { decodeNativeResult } from "@bay/platform/nativeBridge";
import { View, Pressable } from "@bay/platform";
import NativeBayWindows from "@bay/platform/specs/NativeBayWindows";
import { forwardRef, type ComponentType } from "react";
import { ActivityIndicator, Image, Text, type ViewStyle, type TextStyle, type StyleProp } from "react-native";
import type { ContextMenuAreaProps, DockSelectionProps, FadeLabelProps, GlassEffectProps, SurfaceProps, SymbolProps, VisualEffectProps } from "./index";
import type { MouseAreaProps } from "./system";
import { fluentSymbol } from "./symbols.windows";

const weights = { light: "300", regular: "400", medium: "500", semibold: "600", bold: "700" } as const;
function Symbol({ name, size = 16, weight = "regular", color, style, ...props }: SymbolProps) {
  return <Text {...props} accessible={false} style={[{ fontFamily: "Segoe Fluent Icons", fontSize: size, color, fontWeight: weights[weight], lineHeight: size + 3 }, style as StyleProp<TextStyle>]}>{fluentSymbol(name)}</Text>;
}
function FadeLabel({ text, fontSize, weight = "regular", color, fadeWidth: _fade, style, ...props }: FadeLabelProps) {
  return <Text {...props} numberOfLines={1} ellipsizeMode="tail" style={[{ fontSize, fontWeight: weights[weight], color }, style as StyleProp<TextStyle>]}>{text}</Text>;
}
function Surface({ fill, cornerRadius, borderColor, borderWidth, style, children, ...props }: SurfaceProps & Record<string, unknown>) {
  // Per-edge colors and the macOS surface shadow are optional decoration.
  const { borderColors: _colors, shadowColor, shadowOpacity, shadowRadius, shadowOffset, surfaceShadowColor: _c, surfaceShadowOpacity: _o, surfaceShadowRadius: _r, surfaceShadowOffset: _s, ...viewProps } = props;
  return <View {...viewProps} style={[{ backgroundColor: fill, borderRadius: cornerRadius, borderColor, borderWidth, shadowColor, shadowOpacity, shadowRadius, shadowOffset: shadowOffset ? { width: shadowOffset[0], height: shadowOffset[1] } : undefined } as ViewStyle, style]}>{children}</View>;
}
function Effect({ cornerRadius, style, children, ...props }: VisualEffectProps & GlassEffectProps) {
  const { material: _m, blendingMode: _b, tint: _t, glassStyle: _g, dark: _d, ...viewProps } = props;
  return <View {...viewProps} style={[{ borderRadius: cornerRadius }, style]}>{children}</View>;
}
function DockSelection({ image, emoji, iconSize = 32, cornerRadius, style, ...props }: DockSelectionProps) {
  return <View style={[{ borderRadius: cornerRadius, alignItems: "center", justifyContent: "center" }, style]}>{image ? <Image source={{ uri: image }} style={{ width: iconSize, height: iconSize }} /> : emoji ? <Text style={{ fontSize: iconSize }}>{emoji}</Text> : null}</View>;
}
const PlainView = forwardRef<View, ViewProps>(function PlainView(props, ref) {
  const { children, style, pointerEvents, onLayout } = props;
  // Never forward custom AppKit view properties into Fabric's View config.
  return <View ref={ref} style={style} pointerEvents={pointerEvents} onLayout={onLayout}>{children}</View>;
});
function ContextMenuArea({ onContextMenu, captureDescendants: _capture, ...props }: ContextMenuAreaProps) {
  return <View {...props} onPointerDown={event => {
    if (event.nativeEvent.button === 2) onContextMenu?.();
    props.onPointerDown?.(event);
  }} />;
}
function MouseArea({ path: _path, onMiddleClick, ...props }: Omit<MouseAreaProps, "onMiddleClick"> & { onMiddleClick?: (event: { nativeEvent: import("./system").MiddleClickEvent }) => void }) {
  return <View {...props} onPointerDown={event => {
    if (event.nativeEvent.button === 1) onMiddleClick?.({ nativeEvent: { shiftKey: event.nativeEvent.shiftKey, altKey: event.nativeEvent.altKey, metaKey: event.nativeEvent.metaKey } });
    props.onPointerDown?.(event);
  }} />;
}
const views: Record<string, unknown> = {
  BaySymbol: Symbol,
  BayFadeLabel: FadeLabel,
  BayActivitySpinner: (props: ViewProps) => <View {...props}><ActivityIndicator /></View>,
  BaySurface: Surface,
  BayVisualEffect: Effect,
  BayGlassEffect: Effect,
  BayDockSelection: DockSelection,
  BayWindowProfile: PlainView,
  BayShell: (props: ViewProps) => <Pressable {...props} onPressIn={() => { void NativeBayWindows?.invoke("BayShell", "beginWindowDrag", "[]").then(decodeNativeResult).catch(error => console.error("Window drag failed", error)); }} />,
  BayContextMenuArea: ContextMenuArea,
  BayFileDrag: MouseArea,
};

export function requireNativeViewManager<P extends object>(name: string): ComponentType<P> {
  const component = views[name];
  if (!component) throw new Error(`No Windows view adapter for ${name}`);
  return component as ComponentType<P>;
}
