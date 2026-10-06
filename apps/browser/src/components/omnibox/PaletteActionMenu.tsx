import { Symbol } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useTheme } from "../../lib/theme";
import { Keycaps } from "./Keycaps";
import { PaletteSurface } from "./PaletteSurface";

export type PaletteMenuAction = {
  id: string;
  title: string;
  icon: string;
  hint?: string;
  separator?: boolean;
  run(): void | Promise<unknown>;
};

const MENU_KEYS = [
  { key: "Escape" }, { key: "Enter" }, { key: "ArrowUp" }, { key: "ArrowDown" }, { key: "Tab" }, { key: "Tab", shiftKey: true },
  { key: "c", metaKey: true, shiftKey: true }, { key: ",", metaKey: true },
  { key: "C", metaKey: true, shiftKey: true }, { key: "k", metaKey: true }, { key: "K", metaKey: true },
];

export function PaletteActionMenu({
  title,
  actions,
  onClose,
  side = "right",
  maxHeight,
  width = 340,
}: {
  title: string;
  actions: PaletteMenuAction[];
  onClose(): void;
  side?: "left" | "right";
  maxHeight: number;
  width?: number;
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
    try {
      await action.run();
      onClose();
    } catch (failure) {
      setError((failure instanceof Error ? failure.message : "Couldn't complete this action. Try again.").slice(0, 160));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ position: "absolute", bottom: 8, [side]: 8, width, zIndex: 2 }}>
      <PaletteSurface raised radius={22}>
        <Text numberOfLines={1} style={{ fontSize: 13, color: theme.textSecondary, paddingHorizontal: 16, paddingTop: 13, paddingBottom: 7 }}>{title}</Text>
        <ScrollView
          ref={scroller}
          style={{ maxHeight: Math.max(44, maxHeight - 94 - (error ? 36 : 0)), flexGrow: 0 }}
          contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 6 }}
          onLayout={(event) => {
            viewport.current.height = event.nativeEvent.layout.height;
            keepSelectedVisible();
          }}
          onScroll={(event) => { viewport.current.y = event.nativeEvent.contentOffset.y; }}
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
              onMouseEnter={() => setSelected(index)}
            >
              {action.separator && index > 0 ? <View style={{ height: 1, marginHorizontal: 8, marginVertical: 7, backgroundColor: theme.divider }} /> : null}
              <Pressable
                accessibilityRole="menuitem"
                accessibilityLabel={action.title}
                accessibilityState={{ selected: index === selectedIndex, disabled: busy }}
                disabled={busy}
                onPress={() => void run(action)}
                style={{ minHeight: 40, borderRadius: 11, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: index === selectedIndex ? theme.rowSelected : undefined, opacity: busy ? 0.65 : 1 }}
              >
                <Symbol name={action.icon} size={17} color={theme.textPrimary} style={{ width: 20, height: 20 }} />
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, color: theme.textPrimary, paddingVertical: 10 }}>{action.title}</Text>
                {action.hint ? <Keycaps hint={action.hint} /> : null}
              </Pressable>
            </View>
          ))}
          {!filtered.length ? <Text style={{ fontSize: 13, color: theme.textSecondary, paddingHorizontal: 8, paddingVertical: 13 }}>No matching actions</Text> : null}
        </ScrollView>
        {error ? <Text accessibilityRole="alert" numberOfLines={2} style={{ color: theme.dark ? "#FF9C94" : "#B63228", fontSize: 12, paddingHorizontal: 16, paddingBottom: 8 }}>{error}</Text> : null}
        <View style={{ borderTopWidth: 1, borderTopColor: theme.divider, minHeight: 50, justifyContent: "center", paddingHorizontal: 16 }}>
          <TextInput
            ref={input}
            accessibilityLabel="Search for actions"
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
            placeholder="Search for actions…"
            placeholderTextColor={theme.placeholder}
            selectionColor={theme.selection}
            enableFocusRing={false}
            keyDownEvents={MENU_KEYS}
            onKeyDown={(event) => {
              const { key, shiftKey, metaKey } = event.nativeEvent;
              if (key === "Escape" || (metaKey && key.toLowerCase() === "k")) { onClose(); return; }
              const shortcut = metaKey && shiftKey && key.toLowerCase() === "c" ? "⇧⌘C" : metaKey && key === "," ? "⌘," : null;
              if (shortcut) {
                const action = actions.find((item) => item.hint === shortcut);
                if (action) void run(action);
                return;
              }
              if (key === "Enter") void run(filtered[selectedIndex]);
              else if (filtered.length && (key === "ArrowUp" || key === "ArrowDown" || key === "Tab")) {
                const direction = key === "ArrowUp" || (key === "Tab" && shiftKey) ? -1 : 1;
                setSelected((index) => (Math.min(index, filtered.length - 1) + direction + filtered.length) % filtered.length);
              }
            }}
            style={{ fontSize: 15, color: theme.textPrimary, paddingVertical: 0 }}
          />
        </View>
      </PaletteSurface>
    </View>
  );
}
