import { ScrollView } from "@bay/platform";
import { Pressable, TextInput, View, modKey, shortcutLabel } from "@bay/platform";
import { Symbol } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import Animated, { interpolate, useAnimatedStyle, type SharedValue } from "@bay/platform/motion";
import { useTheme } from "../../lib/theme";
import { Keycaps } from "./Keycaps";
import { PaletteSurface } from "./PaletteSurface";
import { usePointerHover } from "./usePointerHover";
import { onEscapeKey } from "../../lib/escapeKey";

export type PaletteMenuAction = {
  id: string;
  title: string;
  icon: string;
  hint?: string;
  separator?: boolean;
  checked?: boolean;
  run(): void | Promise<unknown>;
};

const MENU_KEYS = [
  { key: "Escape" },
  { key: "Enter" },
  { key: "ArrowUp" },
  { key: "ArrowDown" },
  { key: "Tab" },
  { key: "Tab", shiftKey: true },
  { key: "c", metaKey: true, shiftKey: true },
  { key: ",", metaKey: true },
  { key: "C", metaKey: true, shiftKey: true },
  { key: "k", metaKey: true },
  { key: "K", metaKey: true },
  { key: "Enter", metaKey: true },
  { key: "/", metaKey: true },
];
// ⇧⌫ is claimed only while the search field is empty, so it still deletes text.
const EMPTY_MENU_KEYS = [...MENU_KEYS, { key: "Backspace", shiftKey: true }];

type KeyEvent = { key: string; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean };
const KEY_GLYPHS: Record<string, string> = { Enter: "↩", Backspace: "⌫" };

// A key event as the keycap hint actions show, e.g. "⇧⌘C".
export function hintOf({ key, metaKey, shiftKey, altKey, ctrlKey }: KeyEvent): string {
  return shortcutLabel(`${ctrlKey ? "⌃" : ""}${altKey ? "⌥" : ""}${shiftKey ? "⇧" : ""}${metaKey ? "⌘" : ""}${KEY_GLYPHS[key] ?? key.toUpperCase()}`);
}

// Runs the action: null once done, else what went wrong.
async function runAction(action: PaletteMenuAction): Promise<string | null> {
  try {
    await action.run();
    return null;
  } catch (failure) {
    return (failure instanceof Error ? failure.message : "Couldn't complete this action. Try again.").slice(0, 160);
  }
}

export function PaletteActionMenu({
  title,
  actions,
  onClose,
  side = "right",
  maxHeight,
  width = 340,
  progress,
  closing = false,
  top,
  placeholder = "Search for actions…",
}: {
  title: string;
  actions: PaletteMenuAction[];
  onClose(): void;
  side?: "left" | "right";
  maxHeight: number;
  width?: number;
  // 0 → 1 as the menu opens; it grows out of the footer button that opened it.
  progress: SharedValue<number>;
  closing?: boolean;
  // Drops down from this far below the top instead (a header button's menu); otherwise it rises from the footer.
  top?: number;
  placeholder?: string;
}) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInput>(null);
  const scroller = useRef<ScrollView>(null);
  const focused = useRef(false);
  const viewport = useRef({ height: 0, y: 0 });
  const rows = useRef(new Map<string, { y: number; height: number }>());
  const filtered = actions.filter((action) => action.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectedIndex = Math.min(selected, filtered.length - 1);
  const selectedId = filtered[selectedIndex]?.id;
  const hover = usePointerHover(query);
  const growStyle = useAnimatedStyle(() => {
    "worklet";
    const p = progress.get();
    return { opacity: p, transform: [{ scale: interpolate(p, [0, 1], [0.94, 1]) }, { translateY: interpolate(p, [0, 1], [top === undefined ? 4 : -4, 0]) }] };
  });

  const keepSelectedVisible = () => {
    const row = selectedId ? rows.current.get(selectedId) : undefined;
    const visible = viewport.current;
    if (!row || !visible.height) return;
    const y = row.y < visible.y ? row.y : row.y + row.height > visible.y + visible.height ? row.y + row.height - visible.height : visible.y;
    if (y !== visible.y) {
      visible.y = y;
      scroller.current?.scrollTo({ y, animated: false });
    }
  };
  useEffect(keepSelectedVisible, [selectedId, query]);

  const run = async (action: PaletteMenuAction | undefined) => {
    if (!action || busy) return;
    setError(null);
    setBusy(true);
    const failure = await runAction(action);
    setBusy(false);
    if (failure === null) return onClose();
    setError(failure);
    input.current?.focus();
  };

  return (
    <Animated.View
      pointerEvents={closing ? "none" : "auto"}
      style={[
        {
          position: "absolute",
          ...(top === undefined ? { bottom: 8 } : { top }),
          [side]: 8,
          width,
          zIndex: 2,
          transformOrigin: `${side === "left" ? "0%" : "100%"} ${top === undefined ? "100%" : "0%"}`,
        },
        growStyle,
      ]}
    >
      <PaletteSurface raised radius={18}>
        <Text numberOfLines={1} style={{ fontSize: 12, color: theme.textSecondary, paddingHorizontal: 15, paddingTop: 11, paddingBottom: 4 }}>
          {title}
        </Text>
        <ScrollView
          ref={scroller}
          style={{ maxHeight: Math.max(36, maxHeight - 84 - (error ? 32 : 0)), flexGrow: 0 }}
          contentContainerStyle={{ paddingHorizontal: 6, paddingBottom: 5 }}
          onLayout={(event) => {
            viewport.current.height = event.nativeEvent.layout.height;
            keepSelectedVisible();
          }}
          onScroll={(event) => {
            viewport.current.y = event.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
        >
          {filtered.map((action, index) => (
            <View
              key={action.id}
              onLayout={(event) => {
                rows.current.set(action.id, event.nativeEvent.layout);
                if (action.id === selectedId) keepSelectedVisible();
              }}
              onMouseEnter={(e) => hover(e, () => setSelected(index))}
            >
              {action.separator && index > 0 ? <View style={{ height: 1, marginHorizontal: 9, marginVertical: 5, backgroundColor: theme.divider }} /> : null}
              <Pressable
                accessibilityRole="menuitem"
                accessibilityLabel={action.title}
                accessibilityState={{ selected: index === selectedIndex, disabled: busy, checked: action.checked }}
                disabled={busy}
                onPress={() => void run(action)}
                style={{
                  minHeight: 34,
                  borderRadius: 9,
                  paddingHorizontal: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  backgroundColor: index === selectedIndex ? theme.rowSelected : undefined,
                  opacity: busy ? 0.65 : 1,
                }}
              >
                <Symbol name={action.icon} size={14} color={theme.textPrimary} style={{ width: 17, height: 17 }} />
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: theme.textPrimary, paddingVertical: 8 }}>
                  {action.title}
                </Text>
                {action.hint ? <Keycaps hint={action.hint} /> : null}
                {action.checked ? <Symbol name="checkmark" size={12} weight="semibold" color={theme.textPrimary} style={{ width: 16, height: 16 }} /> : null}
              </Pressable>
            </View>
          ))}
          {!filtered.length ? (
            <Text style={{ fontSize: 13, color: theme.textSecondary, paddingHorizontal: 9, paddingVertical: 10 }}>No matching actions</Text>
          ) : null}
        </ScrollView>
        {error ? (
          <Text
            accessibilityRole="alert"
            numberOfLines={2}
            style={{ color: theme.dark ? "#FF9C94" : "#B63228", fontSize: 12, paddingHorizontal: 15, paddingBottom: 7 }}
          >
            {error}
          </Text>
        ) : null}
        <View style={{ borderTopWidth: 1, borderTopColor: theme.divider, minHeight: 42, justifyContent: "center", paddingHorizontal: 15 }}>
          <TextInput
            ref={input}
            accessibilityLabel={placeholder.replace(/…$/, "")}
            onLayout={() => {
              if (focused.current) return;
              focused.current = true;
              input.current?.focus();
            }}
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setSelected(0);
              setError(null);
            }}
            editable={!busy}
            placeholder={placeholder}
            placeholderTextColor={theme.placeholder}
            selectionColor={theme.selection}
            enableFocusRing={false}
            keyDownEvents={query ? MENU_KEYS : EMPTY_MENU_KEYS}
            onKeyPress={onEscapeKey(onClose)}
            onKeyDown={(event) => {
              const { key, shiftKey } = event.nativeEvent;
              const metaKey = modKey(event.nativeEvent);
              if (key === "Escape" || (metaKey && (key.toLowerCase() === "k" || key === "/"))) {
                onClose();
                return;
              }
              // ⌘ shortcuts always reach their action; ⇧⌫ only once the search field is empty.
              if (metaKey || (shiftKey && key === "Backspace" && !query)) {
                const action = actions.find((item) => item.hint && shortcutLabel(item.hint) === hintOf(event.nativeEvent));
                if (action) void run(action);
                return;
              }
              if (key === "Enter") void run(filtered[selectedIndex]);
              else if (filtered.length && (key === "ArrowUp" || key === "ArrowDown" || key === "Tab")) {
                const direction = key === "ArrowUp" || (key === "Tab" && shiftKey) ? -1 : 1;
                setSelected((index) => (Math.min(index, filtered.length - 1) + direction + filtered.length) % filtered.length);
              }
            }}
            style={{ fontSize: 13, color: theme.textPrimary, paddingVertical: 0 }}
          />
        </View>
      </PaletteSurface>
    </Animated.View>
  );
}
