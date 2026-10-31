import * as settingsCommands from "../../runtime/settingsActions";
import * as windowCommands from "../../runtime/windowActions";
import { Pressable, View } from "@bay/platform";
import { hapticTick, Surface, Symbol } from "@bay/shell";
import { WindowBackdrop } from "@bay/shaders";
import { useEffect, useRef, useState } from "react";
import { Image, PanResponder, StyleSheet, Text, type GestureResponderEvent } from "react-native";
import { create } from "zustand";
import {
  defaultHarmony,
  editableTheme,
  harmonize,
  harmonyAfterRemoving,
  nextHarmony,
  THEME_PRESETS,
  wheelColor,
  wheelPosition,
  type Harmony,
} from "../../lib/spaceTheme";
import { MAX_THEME_COLORS } from "../../lib/constants";
import { customGrain, hex, SPACE_COLORS, useTheme } from "../../lib/theme";
import { useEffectEvent } from "../../lib/useEffectEvent";
import { useBrowserRead as useBrowser } from "../../store/read";
import { useSidebarOpen, useWindowId } from "../../store/hooks";
import { withSidebarUndoWindow } from "../../store/sidebarUndo";
import type { Settings } from "../../store/settings";
import type { SpaceColor, SpaceTheme } from "../../store/types";
import { useHover } from "../primitives";
import { Toggle } from "../settings/controls";
import { useSidebarWidth } from "../sidebar/tokens";
import { useSidebarOnRight } from "../layout/windowLayout";
import {
  THEME_DIAL,
  THEME_DIAL_STEPS,
  THEME_DOT,
  THEME_EDITOR_PAD,
  THEME_FIELD_HEIGHT,
  THEME_FIELD_WIDTH,
  THEME_PRIMARY_DOT,
  THEME_SWATCH,
  THEME_SWATCHES_PER_PAGE,
  THEME_WAVE_AMPLITUDE,
  THEME_WAVE_HEIGHT,
  THEME_WAVE_PERIOD,
  THEME_WHEEL_RADIUS,
} from "./constants";
import { dialPoint, dialValue, segment, wavePoints } from "./themeControls";
import { reportBrowserCommand } from "../../runtime/commands";
import { updateSpace } from "../../runtime/spaceActions";

// Arc's and Zen's space theme editor: a floating panel by the sidebar that changes the space's theme as you go, so
// the window is the preview. Light, dark or automatic over a colour wheel of up to three colours (a gradient): the
// first leads, and the others keep a harmony with it. Then pages of swatches, a wave for how strongly they tint and a
// dial for grain. Esc or a click outside closes it.
const DOTS = { light: require("../../../assets/theme-dots-light.png"), dark: require("../../../assets/theme-dots-dark.png") };

const SCHEMES: { mode: Settings["appearance"]; icon: string; tooltip: string }[] = [
  { mode: "auto", icon: "sparkles", tooltip: "Automatic" },
  { mode: "light", icon: "sun.max", tooltip: "Light" },
  { mode: "dark", icon: "moon", tooltip: "Dark" },
];

type Swatch = { name: string; color?: SpaceColor; colors: string[] };
const SWATCHES: Swatch[] = [
  ...(Object.keys(SPACE_COLORS) as SpaceColor[]).map((c) => ({ name: SPACE_COLORS[c].name, color: c, colors: [SPACE_COLORS[c].swatch] })),
  ...THEME_PRESETS,
];

type Request = { windowId: string; spaceId: string };

const useEditor = create<{ request: Request | null }>(() => ({ request: null }));

/** Edits a space's theme in a window, which shows that space meanwhile. */
export function openThemeEditor(windowId: string, spaceId: string) {
  const s = useBrowser.getState();
  if (!s.spaces[spaceId] || !s.windows[windowId]) return;
  reportBrowserCommand(
    windowCommands.switchSpace(windowId, spaceId).then(() => {
      if (useBrowser.getState().windows[windowId]) useEditor.setState({ request: { windowId, spaceId } });
    }),
  );
}

const close = () => useEditor.setState({ request: null });

/** Esc in the page (its webview has the keys) closes the editor open over it; true if one was. */
export function closeThemeEditorOnEscape(windowId: string): boolean {
  if (!themeEditorOpen(windowId)) return false;
  close();
  return true;
}

/** The editor is open in this window: a blank tab doesn't open the palette over the preview. */
export const themeEditorOpen = (windowId: string) => useEditor.getState().request?.windowId === windowId;

export function ThemeEditorHost() {
  const windowId = useWindowId();
  const request = useEditor((e) => (e.request?.windowId === windowId ? e.request : null));
  return request ? <ThemeEditor key={request.spaceId} request={request} /> : null;
}

function ThemeEditor({ request }: { request: Request }) {
  const theme = useTheme();
  const space = useBrowser((s) => s.spaces[request.spaceId]);
  const sidebarOpen = useSidebarOpen();
  const sidebarWidth = useSidebarWidth(request.windowId);
  // Over the page's corner beside the sidebar, on whichever side it is.
  const side = useSidebarOnRight() ? "right" : "left";
  const keys = useRef<View>(null);
  useEffect(() => {
    const t = setTimeout(() => (keys.current as unknown as { focus?: () => void } | null)?.focus?.(), 50);
    return () => clearTimeout(t);
  }, []);
  if (!space) return null;
  return (
    <>
      <Pressable accessibilityLabel="Close Theme Editor" style={StyleSheet.absoluteFill} onPress={close} />
      <Surface
        fill={hex(theme.panel)}
        cornerRadius={16}
        borderColor={hex(theme.panelBorder)}
        borderWidth={0.5}
        shadowColor="#000000"
        shadowOpacity={theme.panelShadowOpacity}
        shadowRadius={22}
        shadowOffset={[0, 8]}
        style={{ position: "absolute", [side]: (sidebarOpen ? sidebarWidth : 0) + 10, bottom: 12, width: THEME_FIELD_WIDTH + 2 * THEME_EDITOR_PAD }}
      >
        <View ref={keys} focusable enableFocusRing={false} keyDownEvents={[{ key: "Escape" }]} onKeyDown={close} style={{ padding: THEME_EDITOR_PAD }}>
          <ThemeControls
            look={{ color: space.color, theme: space.theme ? { ...space.theme, colors: [...space.theme.colors] } : null, followSite: space.followSite }}
            onChange={(next) => withSidebarUndoWindow(request.windowId, () => reportBrowserCommand(updateSpace(request.spaceId, next)))}
          />
        </View>
      </Surface>
    </>
  );
}

/** A space's look: its preset colour, its own theme (a gradient) if it has one, and whether pages tint it. */
export type Look = { color: SpaceColor; theme: SpaceTheme | null; followSite?: boolean };

/**
 * The look's controls, for a space (the editor above) or one being made (the new space panel): light, dark or
 * automatic over a colour wheel of up to three colours, pages of swatches, a wave for how strongly they tint, a dial
 * for grain, and whether a page's colour tints the window. Changes reach `onChange` at most once a frame.
 */
export function ThemeControls({ look, width = THEME_FIELD_WIDTH, onChange }: { look: Look; width?: number; onChange(next: Look): void }) {
  // As many swatches a page as the width holds (the arrows either side take the rest).
  const perPage = Math.max(4, Math.min(THEME_SWATCHES_PER_PAGE, Math.floor((width - 48) / (THEME_SWATCH + 7))));
  const pages = Math.ceil(SWATCHES.length / perPage);
  const appearance = useBrowser((s) => s.settings.appearance);
  const [page, setPage] = useState(0);
  const [harmony, setHarmony] = useState<Harmony>(() => defaultHarmony(look.theme?.colors.length ?? 1));
  // The edit in progress: shown at once, and handed on once a frame.
  const [draft, setDraft] = useState<SpaceTheme | null>(null);
  const pending = useRef<SpaceTheme | null>(null);
  const frame = useRef<number | null>(null);

  const current = draft && look.theme ? draft : editableTheme(look.theme, SPACE_COLORS[look.color].swatch);
  // Many changes a second while dragging: `onChange` takes the latest once a frame.
  const set = (patch: Partial<SpaceTheme>) => {
    const next = { ...(pending.current ?? current), ...patch };
    pending.current = next;
    setDraft(next);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current) onChange({ ...look, theme: pending.current });
    });
  };
  const colors = () => (pending.current ?? current).colors;
  // The first colour leads: the others take their places from it in the harmony (one for as many colours).
  const arrange = (first: string, type: Harmony) => {
    setHarmony(type);
    set({ colors: harmonize(first, type) });
  };
  const moveFirst = (first: string) => arrange(first, harmony);
  const addColor = () => {
    if (colors().length < MAX_THEME_COLORS) arrange(colors()[0]!, defaultHarmony(colors().length + 1));
  };
  const removeColor = () => {
    if (colors().length > 1) arrange(colors()[0]!, harmonyAfterRemoving(harmony, colors().length - 1));
  };
  const cycleHarmony = () => {
    if (colors().length > 1) arrange(colors()[0]!, nextHarmony(harmony, colors().length));
  };
  const applySwatch = (swatch: Swatch) => {
    pending.current = null;
    setDraft(null);
    setHarmony(defaultHarmony(swatch.colors.length));
    if (swatch.color) onChange({ ...look, color: swatch.color, theme: null });
    else onChange({ ...look, theme: { ...current, colors: swatch.colors } });
  };
  const chosen = (swatch: Swatch) =>
    swatch.color ? !look.theme && look.color === swatch.color : !!look.theme && look.theme.colors.join() === swatch.colors.join();
  const follows = look.followSite ?? !look.theme?.colors.length;

  return (
    <View>
      <View>
        <ColorField colors={current.colors} width={width} onMoveFirst={moveFirst} />
        {/* Over the field: light, dark or automatic at the top; at the bottom −, + and the next harmony. */}
        <View pointerEvents="box-none" style={{ position: "absolute", top: 8, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: 4 }}>
          {SCHEMES.map((s) => (
            <IconButton
              key={s.mode}
              icon={s.icon}
              tooltip={s.tooltip}
              on={appearance === s.mode}
              onPress={() => reportBrowserCommand(settingsCommands.updateSettings({ appearance: s.mode }))}
            />
          ))}
        </View>
        <View pointerEvents="box-none" style={{ position: "absolute", bottom: 8, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: 4 }}>
          <IconButton icon="minus" tooltip="Remove Colour" disabled={current.colors.length <= 1} onPress={removeColor} />
          <IconButton icon="plus" tooltip="Add Colour" disabled={current.colors.length >= MAX_THEME_COLORS} onPress={addColor} />
          <IconButton icon="dice" tooltip="Change Harmony" disabled={current.colors.length < 2} onPress={cycleHarmony} />
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12 }}>
        <IconButton icon="chevron.left" tooltip="Previous Colours" narrow disabled={page === 0} onPress={() => setPage(page - 1)} />
        <View style={{ flex: 1, flexDirection: "row", justifyContent: "center", gap: 3 }}>
          {SWATCHES.slice(page * perPage, (page + 1) * perPage).map((s) => (
            <SwatchButton key={s.name} swatch={s} on={chosen(s)} onPress={() => applySwatch(s)} />
          ))}
        </View>
        <IconButton icon="chevron.right" tooltip="More Colours" narrow disabled={page >= pages - 1} onPress={() => setPage(page + 1)} />
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 10 }}>
        <WaveSlider value={current.intensity} colors={current.colors} onChange={(intensity) => set({ intensity })} />
        <GrainDial value={current.grain} onChange={(grain) => set({ grain })} />
      </View>

      <SiteColorRow on={follows} onChange={(followSite) => onChange({ ...look, followSite })} />
    </View>
  );
}

// yab's "Take the site's color": a page with a colour of its own tints the window.
function SiteColorRow({ on, onChange }: { on: boolean; onChange(on: boolean): void }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 14 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>Take the site’s color</Text>
        <Text style={{ fontSize: 11.5, lineHeight: 15, marginTop: 2, color: theme.textSecondary }}>Pages that have one tint the window.</Text>
      </View>
      <Toggle value={on} onChange={onChange} />
    </View>
  );
}

// The wheel at a width (its height in proportion): its centre, its radius, and a colour's dot on it.
function wheel(width: number) {
  const height = (width * THEME_FIELD_HEIGHT) / THEME_FIELD_WIDTH;
  const radius = (THEME_WHEEL_RADIUS * width) / THEME_FIELD_WIDTH;
  const cx = width / 2;
  const cy = height / 2;
  const dotAt = (color: string) => {
    const { angle, distance } = wheelPosition(color);
    const r = distance * radius;
    return { x: cx + Math.cos(angle * 2 * Math.PI) * r, y: cy + Math.sin(angle * 2 * Math.PI) * r };
  };
  return { height, radius, cx, cy, dotAt };
}

// The dotted field over the colour wheel, a dot for each colour, the first one large. A press or a drag anywhere
// brings the first colour to the pointer (held to the wheel's edge), and the others follow it.
export function ColorField({ colors, width, onMoveFirst }: { colors: string[]; width: number; onMoveFirst(color: string): void }) {
  const theme = useTheme();
  const { height, radius, cx, cy, dotAt } = wheel(width);
  const field = useRef<View>(null);
  const origin = useRef({ x: 0, y: 0 });
  const follow = useEffectEvent((e: GestureResponderEvent) => {
    const dx = e.nativeEvent.pageX - origin.current.x - cx;
    const dy = e.nativeEvent.pageY - origin.current.y - cy;
    onMoveFirst(wheelColor(Math.atan2(dy, dx) / (2 * Math.PI), Math.hypot(dx, dy) / radius));
  });
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => follow(e),
      onPanResponderMove: (e) => follow(e),
      onPanResponderTerminationRequest: () => false,
    }),
  );
  return (
    <View
      ref={field}
      {...pan.panHandlers}
      onLayout={() => field.current?.measureInWindow((x, y) => (origin.current = { x, y }))}
      style={{
        width,
        height,
        borderRadius: 10,
        overflow: "hidden",
        backgroundColor: theme.dark ? "#FFFFFF08" : "#0000000D",
      }}
    >
      <View pointerEvents="none">
        <Image source={theme.dark ? DOTS.dark : DOTS.light} style={{ width, height }} />
      </View>
      {/* Back to front, so the first colour's dot is on top. */}
      {colors
        .map((c, i) => ({ c, i }))
        .reverse()
        .map(({ c, i }) => {
          const { x, y } = dotAt(c);
          const size = i === 0 ? THEME_PRIMARY_DOT : THEME_DOT;
          const ring = i === 0 ? 5 : 3;
          // A faint outer ring sets the dot off a light field: no style shadow (RN macOS's view shadow takes the app
          // down; the app's shadows are Surface's).
          return (
            <View
              key={i}
              pointerEvents="none"
              style={{
                position: "absolute",
                left: x - size / 2 - 1,
                top: y - size / 2 - 1,
                width: size + 2,
                height: size + 2,
                borderRadius: size / 2 + 1,
                borderWidth: 1,
                borderColor: "#00000026",
              }}
            >
              <View style={{ flex: 1, borderRadius: size / 2, backgroundColor: c, borderWidth: ring, borderColor: "#FFFFFF" }} />
            </View>
          );
        })}
    </View>
  );
}

// Intensity as Zen draws it: a line that waves more the stronger the tint, coloured up to the thumb, which grows.
function WaveSlider({ value, colors, onChange }: { value: number; colors: string[]; onChange(v: number): void }) {
  const theme = useTheme();
  const track = useRef<View>(null);
  const origin = useRef(0);
  const [width, setWidth] = useState(0);
  const ends = 10;
  const run = Math.max(1, width - 2 * ends);
  const change = useEffectEvent((e: GestureResponderEvent) => onChange(Math.min(1, Math.max(0, (e.nativeEvent.pageX - origin.current - ends) / run))));
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => change(e),
      onPanResponderMove: (e) => change(e),
      onPanResponderTerminationRequest: () => false,
    }),
  );
  const thumbX = ends + value * run;
  const points = width ? wavePoints(ends, width - ends, THEME_WAVE_HEIGHT, value, THEME_WAVE_AMPLITUDE, THEME_WAVE_PERIOD) : [];
  const thumb = { width: 8 + 8 * value, height: 28 + 10 * value };
  const faint = theme.dark ? "#FFFFFF2E" : "#00000026";
  const nudge = (k: number) => Math.min(1, Math.max(0, Math.round((value + k) * 10) / 10));
  return (
    <View
      ref={track}
      {...pan.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Intensity"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => onChange(nudge(e.nativeEvent.actionName === "increment" ? 0.1 : -0.1))}
      tooltip="Intensity"
      onLayout={(e) => {
        setWidth(e.nativeEvent.layout.width);
        track.current?.measureInWindow((x) => (origin.current = x));
      }}
      style={{ flex: 1, height: THEME_WAVE_HEIGHT }}
    >
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 4,
          right: 4,
          top: THEME_WAVE_HEIGHT / 2 - 13,
          height: 26,
          borderRadius: 13,
          backgroundColor: theme.dark ? "#FFFFFF0F" : "#00000009",
        }}
      />
      {points.slice(1).map((p, i) => {
        const s = segment(points[i]!, p);
        const lit = s.x <= thumbX;
        // Coloured from the theme's first colour through its last, as Zen's wave takes the gradient.
        const color = lit ? colors[Math.min(colors.length - 1, Math.floor((s.x / Math.max(1, thumbX)) * colors.length))]! : faint;
        return (
          <View
            key={i}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: s.x - s.length / 2 - 0.5,
              top: s.y - 1.25,
              width: s.length + 1,
              height: 2.5,
              borderRadius: 1.25,
              backgroundColor: color,
              transform: [{ rotate: `${s.angle}rad` }],
            }}
          />
        );
      })}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: thumbX - thumb.width / 2,
          top: (THEME_WAVE_HEIGHT - thumb.height) / 2,
          width: thumb.width,
          height: thumb.height,
          borderRadius: thumb.width / 2,
          backgroundColor: theme.dark ? "#FFFFFF" : "#1C1C1E",
        }}
      />
    </View>
  );
}

// Grain as a dial of sixteen steps, clockwise from the top (a full turn is none), with a tick at each step.
function GrainDial({ value, onChange }: { value: number; onChange(v: number): void }) {
  const theme = useTheme();
  const dial = useRef<View>(null);
  const centre = useRef({ x: 0, y: 0 });
  const change = useEffectEvent((e: GestureResponderEvent) => {
    const next = dialValue(e.nativeEvent.pageX - centre.current.x, e.nativeEvent.pageY - centre.current.y, THEME_DIAL_STEPS);
    if (next === value) return;
    hapticTick();
    onChange(next);
  });
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => change(e),
      onPanResponderMove: (e) => change(e),
      onPanResponderTerminationRequest: () => false,
    }),
  );
  const r = THEME_DIAL / 2;
  const steps = Math.round(value * THEME_DIAL_STEPS) % THEME_DIAL_STEPS;
  // On the ring of dots, in place of the step's own.
  const tick = dialPoint(steps / THEME_DIAL_STEPS, r - 4);
  const inner = THEME_DIAL * 0.6;
  const mark = theme.dark ? "#FFFFFF" : "#000000";
  const stepBy = (k: number) => ((steps + k + THEME_DIAL_STEPS) % THEME_DIAL_STEPS) / THEME_DIAL_STEPS;
  return (
    <View
      ref={dial}
      {...pan.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Grain"
      accessibilityValue={{ min: 0, max: THEME_DIAL_STEPS - 1, now: steps }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => onChange(stepBy(e.nativeEvent.actionName === "increment" ? 1 : -1))}
      tooltip="Grain"
      onLayout={() => dial.current?.measureInWindow((x, y, w, h) => (centre.current = { x: x + w / 2, y: y + h / 2 }))}
      style={{ width: THEME_DIAL, height: THEME_DIAL }}
    >
      {Array.from({ length: THEME_DIAL_STEPS }, (_, i) => {
        const p = dialPoint(i / THEME_DIAL_STEPS, r - 4);
        if (i === steps) return null;
        return (
          <View
            key={i}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: r + p.x - 2,
              top: r + p.y - 2,
              width: 4,
              height: 4,
              borderRadius: 2,
              backgroundColor: mark,
              opacity: i <= steps && steps > 0 ? 0.45 : 0.15,
            }}
          />
        );
      })}
      {/* The grain itself, as the window shows it, in the middle. */}
      <View
        pointerEvents="none"
        style={{ position: "absolute", left: r - inner / 2, top: r - inner / 2, width: inner, height: inner, borderRadius: inner / 2, overflow: "hidden" }}
      >
        <WindowBackdrop
          colors={theme.dark ? ["#5A5A5E", "#2C2C2E"] : ["#E4E4E7", "#B9B9BE"]}
          angle={135}
          grainOpacity={customGrain(value)}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: r + tick.x - 2,
          top: r + tick.y - 5,
          width: 4,
          height: 10,
          borderRadius: 2,
          backgroundColor: theme.dark ? "#D1D1D1" : "#757575",
          transform: [{ rotate: `${(steps / THEME_DIAL_STEPS) * 360}deg` }],
        }}
      />
    </View>
  );
}

function SwatchButton({ swatch, on, onPress }: { swatch: Swatch; on: boolean; onPress(): void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} tooltip={swatch.name}>
      <View
        style={{
          width: THEME_SWATCH + 4,
          height: THEME_SWATCH + 4,
          borderRadius: THEME_SWATCH / 2 + 2,
          padding: 2,
          borderWidth: 1.5,
          borderColor: on ? theme.textPrimary : "transparent",
        }}
      >
        <View style={{ flex: 1, borderRadius: THEME_SWATCH / 2, overflow: "hidden", flexDirection: "row" }}>
          {swatch.colors.map((c) => (
            <View key={c} style={{ flex: 1, backgroundColor: c }} />
          ))}
        </View>
      </View>
    </Pressable>
  );
}

function IconButton({
  icon,
  tooltip,
  on,
  narrow,
  disabled,
  onPress,
}: {
  icon: string;
  tooltip: string;
  on?: boolean;
  narrow?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const fill = on ? (theme.dark ? "#FFFFFF1F" : "#0000001A") : hovered && !disabled ? theme.rowHover : undefined;
  return (
    <View {...hoverProps} tooltip={tooltip}>
      <Pressable disabled={disabled} accessibilityLabel={tooltip} accessibilityState={{ selected: on, disabled }} onPress={onPress}>
        <View
          style={{
            width: narrow ? 16 : 26,
            height: 26,
            borderRadius: 7,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: fill,
            opacity: disabled ? 0.3 : on || hovered ? 1 : 0.6,
          }}
        >
          <Symbol name={icon} size={12} weight="semibold" color={theme.textPrimary} style={{ width: 15, height: 15 }} />
        </View>
      </Pressable>
    </View>
  );
}
