import { Pressable, View } from "@bay/platform";
import { MarkupCanvas, MouseArea, Surface, Symbol, type MarkupCanvasHandle, type MarkupState, type MarkupTool } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text } from "react-native";
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "@bay/platform/motion";
import { bouncySpring } from "../../lib/springs";
import { hex, useTheme } from "../../lib/theme";
import { PromptButton } from "../layout/controls";
import { IconButton, useHover } from "../primitives";
import { CAPTURE_BAR_HEIGHT, MARKUP_COLORS, MARKUP_WIDTHS } from "./constants";
import { placeCapture, type Box } from "./geometry";
import {
  applyMarkup,
  captureToLibrary,
  closeCapture,
  copyCapture,
  retakeCapture,
  saveCapture,
  setMarkingUp,
  shareCapture,
  useCapture,
  type CaptureSession,
} from "./state";

type Ready = Extract<CaptureSession, { phase: "ready" | "markup" }>;

/** A tab's capture over its page, once taken: lifted from where it was, with its actions; or Mark Up. */
export function CaptureLayer({ tabId }: { tabId: string }) {
  const session = useCapture(tabId);
  const [pane, setPane] = useState({ width: 0, height: 0 });
  const ready = session && (session.phase === "ready" || session.phase === "markup") ? session : null;
  if (!ready) return null;
  return (
    <View style={StyleSheet.absoluteFill} onLayout={(e) => setPane({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
      {pane.width > 0 &&
        (ready.phase === "markup" ? (
          <MarkupEditor tabId={tabId} session={ready} pane={pane} />
        ) : (
          <CaptureResult key={ready.image.path} tabId={tabId} session={ready} pane={pane} />
        ))}
    </View>
  );
}

// Where the capture was on the page, in the pane's points; the whole pane for a capture of what it shows.
function sourceBox(session: Ready, pane: { width: number; height: number }): Box {
  const { area, image } = session;
  if (!area) return { x: 0, y: 0, width: pane.width, height: pane.height };
  const k = pane.width / area.viewportWidth;
  // A marked-up capture keeps its size; its aspect is the image's.
  return { x: area.left * k, y: area.top * k, width: area.width * k, height: (area.width * k * image.height) / Math.max(1, image.width) };
}

function CaptureResult({ tabId, session, pane }: { tabId: string; session: Ready; pane: { width: number; height: number } }) {
  const theme = useTheme();
  const from = sourceBox(session, pane);
  const { image: to, barTop, barAbove } = placeCapture(from, pane);
  const [barWidth, setBarWidth] = useState(0);
  const lift = useSharedValue(0);
  const keys = useRef<View>(null);
  const share = useRef<View>(null);

  useEffect(() => {
    lift.set(withSpring(1, bouncySpring(14, 4)));
    const timer = setTimeout(() => (keys.current as unknown as { focus?: () => void } | null)?.focus?.(), 30);
    return () => clearTimeout(timer);
  }, []);

  const imageStyle = useAnimatedStyle(() => {
    const p = lift.get();
    return {
      left: interpolate(p, [0, 1], [from.x, to.x]),
      top: interpolate(p, [0, 1], [from.y, to.y]),
      width: interpolate(p, [0, 1], [from.width, to.width]),
      height: interpolate(p, [0, 1], [from.height, to.height]),
    };
  });
  const shadeStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, lift.get()) }));
  const barStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, lift.get() * 1.4),
    transform: [{ translateY: interpolate(lift.get(), [0, 1], [barAbove ? 6 : -6, 0]) }],
  }));
  const center = to.x + to.width / 2;
  const barLeft = Math.max(8, Math.min(pane.width - barWidth - 8, center - barWidth / 2));

  const openShare = () => share.current?.measureInWindow((x, y, width, height) => shareCapture(tabId, [x, y, width, height]));

  return (
    <View
      ref={keys}
      focusable
      enableFocusRing={false}
      keyDownEvents={[{ key: "Escape" }, { key: "Enter" }, { key: "c", metaKey: true }]}
      onKeyDown={(e) => (e.nativeEvent.key === "Escape" ? closeCapture(tabId) : void copyCapture(tabId))}
      style={StyleSheet.absoluteFill}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: theme.dark ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.3)" }, shadeStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => closeCapture(tabId)} />
      </Animated.View>
      <Animated.View style={[{ position: "absolute" }, imageStyle]}>
        <Surface
          fill="#FFFFFF"
          cornerRadius={6}
          borderColor={hex("rgba(255,255,255,0.7)")}
          borderWidth={1}
          shadowColor="#000000"
          shadowOpacity={0.35}
          shadowRadius={22}
          shadowOffset={[0, 10]}
          style={StyleSheet.absoluteFill}
        />
        {/* Dragged out, the picture goes as its PNG (to Finder, Mail, a message). */}
        <MouseArea path={session.image.path} style={[StyleSheet.absoluteFill, { borderRadius: 6, overflow: "hidden" }]}>
          <Image source={{ uri: `file://${session.image.path}` }} resizeMode="stretch" style={StyleSheet.absoluteFill} />
        </MouseArea>
      </Animated.View>
      <Animated.View
        onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
        style={[{ position: "absolute", top: barTop, left: barLeft, opacity: barWidth ? 1 : 0 }, barStyle]}
      >
        <Surface
          fill={hex(theme.dark ? "rgba(38,36,37,0.97)" : "rgba(252,251,252,0.98)")}
          cornerRadius={12}
          borderColor={hex(theme.dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)")}
          borderWidth={0.5}
          shadowColor="#000000"
          shadowOpacity={theme.dark ? 0.45 : 0.18}
          shadowRadius={16}
          shadowOffset={[0, 6]}
          style={{ height: CAPTURE_BAR_HEIGHT, flexDirection: "row", alignItems: "center", paddingHorizontal: 4, gap: 2 }}
        >
          <BarButton compact={pane.width < 740} icon="doc.on.doc" title="Copy" tooltip="Copy (⌘C)" onPress={() => void copyCapture(tabId)} />
          <BarButton compact={pane.width < 740} icon="books.vertical" title="Library" tooltip="Save to Library" onPress={() => void captureToLibrary(tabId)} />
          <BarButton
            compact={pane.width < 740}
            icon="scribble.variable"
            title="Easel"
            tooltip="Add to Easel"
            onPress={() => void captureToLibrary(tabId, true)}
          />
          <BarButton compact={pane.width < 740} icon="arrow.down.circle" title="Save" tooltip="Save to Downloads" onPress={() => void saveCapture(tabId)} />
          <View ref={share} collapsable={false}>
            <BarButton compact={pane.width < 740} icon="square.and.arrow.up" title="Share" tooltip="Share" onPress={openShare} />
          </View>
          <BarButton compact={pane.width < 740} icon="pencil.tip.crop.circle" title="Mark Up" tooltip="Mark Up" onPress={() => setMarkingUp(tabId, true)} />
          <BarButton compact={pane.width < 740} icon="arrow.counterclockwise" title="Retake" tooltip="Retake" onPress={() => retakeCapture(tabId)} />
          <View
            style={{
              width: StyleSheet.hairlineWidth,
              height: 20,
              marginHorizontal: 4,
              backgroundColor: theme.dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.12)",
            }}
          />
          <Text
            style={{
              fontSize: 11,
              color: theme.textSecondary,
              fontVariant: ["tabular-nums"],
              marginHorizontal: 4,
              display: pane.width < 480 ? "none" : "flex",
            }}
          >
            {session.image.width} × {session.image.height}
          </Text>
          <IconButton icon="xmark" size={12} box={28} radius={8} tooltip="Close (esc)" onPress={() => closeCapture(tabId)} />
        </Surface>
      </Animated.View>
    </View>
  );
}

function BarButton({ icon, title, tooltip, onPress, compact }: { icon: string; title: string; tooltip: string; onPress: () => void; compact?: boolean }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View tooltip={tooltip} {...hoverProps}>
      <Pressable onPress={onPress} accessibilityLabel={title} accessibilityRole="button">
        {({ pressed }) => (
          <View
            style={{
              height: 30,
              paddingHorizontal: 9,
              borderRadius: 8,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              backgroundColor: pressed ? theme.toolbarPressed : hovered ? theme.toolbarHover : undefined,
            }}
          >
            <Symbol name={icon} size={13} color={theme.icon} style={{ width: 16, height: 16 }} />
            {!compact && <Text style={{ fontSize: 12.5, fontWeight: "500", color: theme.textPrimary }}>{title}</Text>}
          </View>
        )}
      </Pressable>
    </View>
  );
}

// MARK: Mark Up

const TOOLS: { tool: MarkupTool; icon: string; title: string }[] = [
  { tool: "pen", icon: "pencil.tip", title: "Pen" },
  { tool: "highlighter", icon: "highlighter", title: "Highlighter (⇧ keeps it straight)" },
  { tool: "arrow", icon: "arrow.up.right", title: "Arrow" },
  { tool: "rect", icon: "rectangle", title: "Box (⇧ for a square)" },
  { tool: "oval", icon: "circle", title: "Oval (⇧ for a circle)" },
  { tool: "text", icon: "textformat", title: "Text" },
];

function MarkupEditor({ tabId, session, pane }: { tabId: string; session: Ready; pane: { width: number; height: number } }) {
  const theme = useTheme();
  const canvas = useRef<MarkupCanvasHandle>(null);
  const [tool, setTool] = useState<MarkupTool>("pen");
  const [color, setColor] = useState(MARKUP_COLORS[0]!);
  const [width, setWidth] = useState(MARKUP_WIDTHS[1]!);
  const [state, setState] = useState<MarkupState>({ canUndo: false, canRedo: false, marks: 0 });
  const [saving, setSaving] = useState(false);
  const appear = useSharedValue(0);
  useEffect(() => {
    appear.set(withTiming(1, { duration: 180, easing: Easing.out(Easing.cubic) }));
  }, []);
  const appearStyle = useAnimatedStyle(() => ({ opacity: appear.get(), transform: [{ scale: interpolate(appear.get(), [0, 1], [0.97, 1]) }] }));

  const done = async () => {
    if (!state.marks) return setMarkingUp(tabId, false);
    setSaving(true);
    const image = await canvas.current?.export();
    setSaving(false);
    if (image) applyMarkup(tabId, image);
    else setMarkingUp(tabId, false);
  };
  const panelWidth = Math.max(320, pane.width - 32);
  const panelHeight = Math.max(240, pane.height - 32);
  const divider = (
    <View
      style={{ width: StyleSheet.hairlineWidth, height: 20, marginHorizontal: 6, backgroundColor: theme.dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.12)" }}
    />
  );

  return (
    // Esc, from the canvas or a button, leaves Mark Up as it was.
    <View focusable enableFocusRing={false} keyDownEvents={[{ key: "Escape" }]} onKeyDown={() => setMarkingUp(tabId, false)} style={StyleSheet.absoluteFill}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.dark ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.35)" }]} />
      <Animated.View
        style={[
          { position: "absolute", left: (pane.width - panelWidth) / 2, top: (pane.height - panelHeight) / 2, width: panelWidth, height: panelHeight },
          appearStyle,
        ]}
      >
        <Surface
          fill={theme.dark ? "#262425" : "#F6F5F6"}
          cornerRadius={14}
          borderColor={hex(theme.dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)")}
          borderWidth={0.5}
          shadowColor="#000000"
          shadowOpacity={theme.dark ? 0.5 : 0.22}
          shadowRadius={24}
          shadowOffset={[0, 10]}
          style={{ flex: 1, overflow: "hidden" }}
        >
          <View style={{ height: 48, flexDirection: "row", alignItems: "center", paddingHorizontal: 10, gap: 2 }}>
            {TOOLS.map((t) => (
              <IconButton
                key={t.tool}
                icon={t.icon}
                size={13}
                box={30}
                radius={8}
                tooltip={t.title}
                color={tool === t.tool ? theme.accent : undefined}
                style={tool === t.tool ? { borderRadius: 8, backgroundColor: theme.toolbarPressed } : undefined}
                onPress={() => setTool(t.tool)}
              />
            ))}
            {divider}
            {MARKUP_COLORS.map((c) => (
              <Pressable key={c} onPress={() => setColor(c)} accessibilityLabel={c}>
                <View
                  style={{
                    width: 22,
                    height: 22,
                    marginHorizontal: 1,
                    borderRadius: 11,
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 2,
                    borderColor: color === c ? theme.textPrimary : "transparent",
                  }}
                >
                  <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: c, borderWidth: 0.5, borderColor: "rgba(0,0,0,0.2)" }} />
                </View>
              </Pressable>
            ))}
            {divider}
            {MARKUP_WIDTHS.map((w) => (
              <Pressable key={w} onPress={() => setWidth(w)} accessibilityLabel={`Width ${w}`}>
                <View
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 7,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: width === w ? theme.toolbarPressed : undefined,
                  }}
                >
                  <View style={{ width: w + 3, height: w + 3, borderRadius: (w + 3) / 2, backgroundColor: theme.icon }} />
                </View>
              </Pressable>
            ))}
            {divider}
            <IconButton
              icon="arrow.uturn.backward"
              size={13}
              box={30}
              radius={8}
              tooltip="Undo (⌘Z)"
              disabled={!state.canUndo}
              onPress={() => void canvas.current?.undo()}
            />
            <IconButton
              icon="arrow.uturn.forward"
              size={13}
              box={30}
              radius={8}
              tooltip="Redo (⇧⌘Z)"
              disabled={!state.canRedo}
              onPress={() => void canvas.current?.redo()}
            />
            <IconButton icon="trash" size={13} box={30} radius={8} tooltip="Clear Marks" disabled={!state.marks} onPress={() => void canvas.current?.clear()} />
            <View style={{ flex: 1 }} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <PromptButton title="Cancel" onPress={() => setMarkingUp(tabId, false)} />
              <PromptButton title={saving ? "Saving…" : "Done"} primary onPress={() => void done()} />
            </View>
          </View>
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)" }} />
          <MarkupCanvas
            ref={canvas}
            path={session.image.path}
            tool={tool}
            color={color}
            lineWidth={width}
            onChange={setState}
            style={{ flex: 1, margin: 12 }}
          />
        </Surface>
      </Animated.View>
    </View>
  );
}
