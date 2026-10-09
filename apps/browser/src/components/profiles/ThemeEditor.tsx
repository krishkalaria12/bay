import { Surface, Symbol } from "@bay/shell";
import { useRef, useState } from "react";
import { Image, PanResponder, Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { create } from "zustand";
import { editableTheme, spectrumColor, spectrumPosition, THEME_PRESETS } from "../../lib/spaceTheme";
import { MAX_THEME_COLORS } from "../../lib/constants";
import { hex, PROFILE_COLORS, useTheme } from "../../lib/theme";
import { useEffectEvent } from "../../lib/useEffectEvent";
import { useBrowser } from "../../store/browser";
import { useSidebarOpen, useWindowId } from "../../store/hooks";
import type { ProfileColor, SpaceTheme } from "../../store/types";
import { useHover } from "../primitives";
import { useSidebarWidth } from "../sidebar/tokens";
import { useSidebarOnRight } from "../layout/windowLayout";
import { THEME_DOT, THEME_EDITOR_PAD, THEME_FIELD_HEIGHT, THEME_FIELD_WIDTH } from "./constants";

// Arc's space theme editor: a floating panel by the sidebar that changes the space's theme as you go, so the window
// is the preview. Up to three colours on a colour field (a gradient), how strongly they tint, grain, and presets.
const SPECTRUM = require("../../../assets/theme-spectrum.png");

type Request = { windowId: string; profileId: string; original: SpaceTheme | null; originalColor: ProfileColor };

const useEditor = create<{ request: Request | null }>(() => ({ request: null }));

/** Edits a space's theme in a window, which shows that space meanwhile. */
export function openThemeEditor(windowId: string, profileId: string) {
  const s = useBrowser.getState();
  const space = s.profiles[profileId];
  if (!space || !s.windows[windowId]) return;
  s.switchProfile(windowId, profileId);
  useEditor.setState({ request: { windowId, profileId, original: space.theme ?? null, originalColor: space.color } });
}

const close = () => useEditor.setState({ request: null });

/** The editor is open in this window: a blank tab doesn't open the palette over the preview. */
export const themeEditorOpen = (windowId: string) => useEditor.getState().request?.windowId === windowId;

export function ThemeEditorHost() {
  const windowId = useWindowId();
  const request = useEditor((e) => (e.request?.windowId === windowId ? e.request : null));
  return request ? <ThemeEditor key={request.profileId} request={request} /> : null;
}

function ThemeEditor({ request }: { request: Request }) {
  const theme = useTheme();
  const space = useBrowser((s) => s.profiles[request.profileId]);
  const sidebarOpen = useSidebarOpen();
  const sidebarWidth = useSidebarWidth(request.windowId);
  // Over the page's corner beside the sidebar, on whichever side it is.
  const side = useSidebarOnRight() ? "right" : "left";
  const [selected, setSelected] = useState(0);
  // The edit in progress: shown at once, and taken by the store (and the window's theme) once a frame.
  const [draft, setDraft] = useState<SpaceTheme | null>(null);
  const pending = useRef<SpaceTheme | null>(null);
  const frame = useRef<number | null>(null);
  if (!space) return null;

  const current = draft && space.theme ? draft : editableTheme(space.theme, PROFILE_COLORS[space.color].swatch);
  const chosen = Math.min(selected, current.colors.length - 1);
  // Many changes a second while dragging: the store (and the window's theme) takes the latest once a frame.
  const set = (patch: Partial<SpaceTheme>) => {
    const next = { ...(pending.current ?? current), ...patch };
    pending.current = next;
    setDraft(next);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current) useBrowser.getState().updateProfile(request.profileId, { theme: pending.current });
    });
  };
  const setColor = (i: number, color: string) => set({ colors: (pending.current ?? current).colors.map((c, k) => (k === i ? color : c)) });
  const addColor = () => {
    const colors = (pending.current ?? current).colors;
    if (colors.length >= MAX_THEME_COLORS) return;
    // Across the field from the last colour, at its depth.
    const { x, y } = spectrumPosition(colors[colors.length - 1]!);
    set({ colors: [...colors, spectrumColor((x + 0.33) % 1, y)] });
    setSelected(colors.length);
  };
  const removeColor = () => {
    const colors = (pending.current ?? current).colors;
    if (colors.length <= 1) return;
    set({ colors: colors.filter((_, k) => k !== chosen) });
    setSelected(Math.max(0, chosen - 1));
  };
  const usePreset = (patch: { color?: ProfileColor; colors?: string[] }) => {
    pending.current = null;
    setDraft(null);
    setSelected(0);
    if (patch.color) useBrowser.getState().updateProfile(request.profileId, { color: patch.color, theme: null });
    else useBrowser.getState().updateProfile(request.profileId, { theme: { ...current, colors: patch.colors! } });
  };
  const cancel = () => {
    useBrowser.getState().updateProfile(request.profileId, { theme: request.original, color: request.originalColor });
    close();
  };

  return (
    <Surface
      fill={hex(theme.panel)}
      cornerRadius={16}
      borderColor={hex(theme.panelBorder)}
      borderWidth={0.5}
      shadowColor="#000000"
      shadowOpacity={theme.panelShadowOpacity}
      shadowRadius={22}
      shadowOffset={[0, 8]}
      style={{ position: "absolute", [side]: (sidebarOpen ? sidebarWidth : 0) + 10, bottom: 12, width: THEME_FIELD_WIDTH + 2 * THEME_EDITOR_PAD, padding: THEME_EDITOR_PAD }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
        <Text style={{ flex: 1, fontSize: 13, fontWeight: "600", color: theme.textPrimary }} numberOfLines={1}>
          {space.name} Theme
        </Text>
      </View>

      <ColorField colors={current.colors} selected={chosen} onSelect={setSelected} onMove={setColor} />

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
        {current.colors.map((c, i) => (
          <Pressable key={i} onPress={() => setSelected(i)} tooltip={`Colour ${i + 1}`}>
            <View style={{ width: 22, height: 22, borderRadius: 11, padding: 2, borderWidth: 2, borderColor: i === chosen ? theme.textPrimary : "transparent" }}>
              <View style={{ flex: 1, borderRadius: 7, backgroundColor: c }} />
            </View>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <SmallButton icon="minus" tooltip="Remove Colour" disabled={current.colors.length <= 1} onPress={removeColor} />
        <SmallButton icon="plus" tooltip="Add Colour" disabled={current.colors.length >= MAX_THEME_COLORS} onPress={addColor} />
      </View>

      <Slider label="Intensity" value={current.intensity} onChange={(intensity) => set({ intensity })} />
      <Slider label="Grain" value={current.grain} onChange={(grain) => set({ grain })} />

      <Text style={{ fontSize: 11.5, fontWeight: "600", color: theme.textSecondary, marginTop: 12, marginBottom: 7 }}>Presets</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {(Object.keys(PROFILE_COLORS) as ProfileColor[]).map((c) => (
          <Swatch key={c} tooltip={PROFILE_COLORS[c].name} colors={[PROFILE_COLORS[c].swatch]} on={!space.theme && space.color === c} onPress={() => usePreset({ color: c })} />
        ))}
        {THEME_PRESETS.map((p) => (
          <Swatch key={p.name} tooltip={p.name} colors={p.colors} on={!!space.theme && space.theme.colors.join() === p.colors.join()} onPress={() => usePreset({ colors: p.colors })} />
        ))}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14 }}>
        <TextButton title="Reset" tooltip="Back to the preset colour" onPress={() => usePreset({ color: space.color })} />
        <View style={{ flex: 1 }} />
        <TextButton title="Cancel" onPress={cancel} />
        <TextButton title="Done" primary onPress={close} />
      </View>
    </Surface>
  );
}

// The colour field with a dot for each colour. Dragging moves the dot under the pointer (or the selected one).
function ColorField({ colors, selected, onSelect, onMove }: { colors: string[]; selected: number; onSelect(i: number): void; onMove(i: number, color: string): void }) {
  const field = useRef<View>(null);
  const origin = useRef({ x: 0, y: 0 });
  const dragging = useRef(0);
  const point = (e: GestureResponderEvent) => ({
    x: Math.min(1, Math.max(0, (e.nativeEvent.pageX - origin.current.x) / THEME_FIELD_WIDTH)),
    y: Math.min(1, Math.max(0, (e.nativeEvent.pageY - origin.current.y) / THEME_FIELD_HEIGHT)),
  });
  const grant = useEffectEvent((e: GestureResponderEvent) => {
    const p = point(e);
    // The dot under the pointer, or else the selected one comes to it.
    const near = colors.findIndex((c) => {
      const at = spectrumPosition(c);
      return Math.hypot((at.x - p.x) * THEME_FIELD_WIDTH, (at.y - p.y) * THEME_FIELD_HEIGHT) <= THEME_DOT;
    });
    dragging.current = near >= 0 ? near : selected;
    onSelect(dragging.current);
    onMove(dragging.current, spectrumColor(p.x, p.y));
  });
  const move = useEffectEvent((e: GestureResponderEvent) => {
    const p = point(e);
    onMove(dragging.current, spectrumColor(p.x, p.y));
  });
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => grant(e),
      onPanResponderMove: (e) => move(e),
      onPanResponderTerminationRequest: () => false,
    }),
  );
  return (
    <View
      ref={field}
      {...pan.panHandlers}
      onLayout={() => field.current?.measureInWindow((x, y) => (origin.current = { x, y }))}
      style={{ width: THEME_FIELD_WIDTH, height: THEME_FIELD_HEIGHT, borderRadius: 10, overflow: "hidden" }}
    >
      <View pointerEvents="none">
        <Image source={SPECTRUM} style={{ width: THEME_FIELD_WIDTH, height: THEME_FIELD_HEIGHT }} />
      </View>
      {colors.map((c, i) => {
        const { x, y } = spectrumPosition(c);
        const size = i === selected ? THEME_DOT + 4 : THEME_DOT;
        // A dark outer ring sets the dot off a light field: no style shadow (RN macOS's view shadow takes the app
        // down; the app's shadows are Surface's).
        return (
          <View
            key={i}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: x * THEME_FIELD_WIDTH - size / 2 - 1,
              top: y * THEME_FIELD_HEIGHT - size / 2 - 1,
              width: size + 2,
              height: size + 2,
              borderRadius: size / 2 + 1,
              borderWidth: 1,
              borderColor: "#00000059",
            }}
          >
            <View style={{ flex: 1, borderRadius: size / 2, backgroundColor: c, borderWidth: 3, borderColor: "#FFFFFF" }} />
          </View>
        );
      })}
    </View>
  );
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange(v: number): void }) {
  const theme = useTheme();
  const track = useRef<View>(null);
  const origin = useRef(0);
  const change = useEffectEvent((e: GestureResponderEvent) => onChange(Math.min(1, Math.max(0, (e.nativeEvent.pageX - origin.current) / THEME_FIELD_WIDTH))));
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => change(e),
      onPanResponderMove: (e) => change(e),
      onPanResponderTerminationRequest: () => false,
    }),
  );
  const thumb = 16;
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={{ fontSize: 11.5, fontWeight: "600", color: theme.textSecondary, marginBottom: 6 }}>{label}</Text>
      <View
        ref={track}
        {...pan.panHandlers}
        onLayout={() => track.current?.measureInWindow((x) => (origin.current = x))}
        style={{ width: THEME_FIELD_WIDTH, height: thumb, justifyContent: "center" }}
      >
        <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: theme.dark ? "#FFFFFF24" : "#0000001A" }}>
          <View style={{ width: value * THEME_FIELD_WIDTH, height: 4, borderRadius: 2, backgroundColor: theme.textSecondary }} />
        </View>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: value * (THEME_FIELD_WIDTH - thumb),
            width: thumb,
            height: thumb,
            borderRadius: thumb / 2,
            backgroundColor: "#FFFFFF",
            borderWidth: 1,
            borderColor: "#00000040",
          }}
        />
      </View>
    </View>
  );
}

function Swatch({ colors, on, tooltip, onPress }: { colors: string[]; on: boolean; tooltip: string; onPress(): void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} tooltip={tooltip}>
      <View style={{ width: 24, height: 24, borderRadius: 12, padding: 2, borderWidth: 2, borderColor: on ? theme.textPrimary : "transparent" }}>
        <View style={{ flex: 1, borderRadius: 8, overflow: "hidden", flexDirection: "row" }}>
          {colors.map((c) => (
            <View key={c} style={{ flex: 1, backgroundColor: c }} />
          ))}
        </View>
      </View>
    </Pressable>
  );
}

function SmallButton({ icon, tooltip, disabled, onPress }: { icon: string; tooltip: string; disabled?: boolean; onPress(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} tooltip={tooltip}>
      <Pressable disabled={disabled} onPress={onPress}>
        <View style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: hovered && !disabled ? theme.rowHover : undefined, opacity: disabled ? 0.35 : 1 }}>
          <Symbol name={icon} size={11} weight="semibold" color={theme.textPrimary} style={{ width: 14, height: 14 }} />
        </View>
      </Pressable>
    </View>
  );
}

function TextButton({ title, primary, tooltip, onPress }: { title: string; primary?: boolean; tooltip?: string; onPress(): void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} tooltip={tooltip}>
      <Pressable onPress={onPress}>
        <View
          style={{
            height: 26,
            paddingHorizontal: 11,
            borderRadius: 7,
            justifyContent: "center",
            backgroundColor: primary ? theme.accent : hovered ? theme.rowHover : theme.dark ? "#FFFFFF12" : "#0000000A",
          }}
        >
          <Text style={{ fontSize: 12.5, fontWeight: primary ? "600" : "400", color: primary ? "#FFFFFF" : theme.textPrimary }}>{title}</Text>
        </View>
      </Pressable>
    </View>
  );
}
