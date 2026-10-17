import { Pressable, TextInput, View } from "@bay/platform";
import { Symbol } from "@bay/shell";
import { useMemo, useRef, useState } from "react";
import { FlatList, Text } from "react-native";
import { onEscapeKey } from "../lib/escapeKey";
import { SYMBOL_PREFIX } from "../lib/constants";
import { useTheme } from "../lib/theme";
import { EMOJI_GROUPS } from "./emojiData";
import { formColors } from "./settings/controls";
import { symbolColor } from "./symbolColors";

// The icon chooser shared by the sidebar's picker (tabs, groups, folders, spaces), the new space sheet and Spaces
// settings, as yab's: Emoji or Icon, a search field, the grid, and (for emoji) a bar of their categories that jumps
// to each. An icon is an emoji, or SYMBOL_PREFIX and a symbol's name.

/** A symbol on offer, with the words a search finds it by. */
export type IconChoice = { name: string; words: string };

const HEADER = 24;
const BAR = 30;

type Row = { key: string; header: string } | { key: string; icons: string[] };

type GridProps = {
  symbols: IconChoice[];
  current: string | null;
  onChoose(icon: string): void;
  /** Escape in the search field. */
  onEscape?(): void;
  columns: number;
  cell: number;
  rows: number;
  /** A hovered or chosen cell's fill. */
  highlight: string;
  /** Symbols drawn filled and bolder (a space's), rather than as the sidebar's outlines. */
  bold?: boolean;
  /** The tab shown first, unless `current` is of the other kind. */
  prefer?: "emoji" | "symbols";
  autoFocus?: boolean;
};

const chunk = (icons: string[], columns: number, key: string): Row[] =>
  Array.from({ length: Math.ceil(icons.length / columns) }, (_, i) => ({ key: `${key}:${i}`, icons: icons.slice(i * columns, (i + 1) * columns) }));

export function IconGrid({ symbols, current, onChoose, onEscape, columns, cell, rows, highlight, bold, prefer = "symbols", autoFocus }: GridProps) {
  const theme = useTheme();
  const [tab, setTab] = useState<"emoji" | "symbols">(() => {
    if (!current) return prefer;
    return current.startsWith(SYMBOL_PREFIX) ? "symbols" : "emoji";
  });
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState(EMOJI_GROUPS[0]!.id);
  const list = useRef<FlatList<Row>>(null);
  const q = query.trim().toLowerCase();
  const browsing = tab === "emoji" && !q;

  // The rows, and each one's offset (rows are fixed-height): a category's header is where the bar jumps to.
  const { data, offsets, groupAt } = useMemo(() => {
    let data: Row[];
    const groupAt: { id: string; y: number }[] = [];
    if (tab === "symbols") {
      data = chunk(
        symbols.filter((s) => !q || s.name.includes(q) || s.words.includes(q)).map((s) => SYMBOL_PREFIX + s.name),
        columns,
        "symbols",
      );
    } else if (q) {
      const found = EMOJI_GROUPS.flatMap((g) => g.emoji.filter((e) => e.slice(e.indexOf(" ") + 1).includes(q)));
      data = chunk(
        found.map((e) => e.slice(0, e.indexOf(" "))),
        columns,
        "found",
      );
    } else {
      data = EMOJI_GROUPS.flatMap((g) => [
        { key: g.id, header: g.title },
        ...chunk(
          g.emoji.map((e) => e.slice(0, e.indexOf(" "))),
          columns,
          g.id,
        ),
      ]);
    }
    const offsets: number[] = [];
    let y = 0;
    for (const row of data) {
      offsets.push(y);
      if ("header" in row) groupAt.push({ id: row.key, y });
      y += "header" in row ? HEADER : cell;
    }
    return { data, offsets, groupAt };
  }, [tab, q, symbols, columns, cell]);

  const jump = (id: string) => {
    setGroup(id);
    const y = groupAt.find((g) => g.id === id)?.y ?? 0;
    list.current?.scrollToOffset({ offset: y, animated: false });
  };

  return (
    <View style={{ width: columns * cell, gap: 8 }}>
      <View style={{ alignItems: "center" }}>
        <Segmented value={tab} onChange={setTab} />
      </View>
      <View style={{ height: 30, borderRadius: 15, backgroundColor: theme.urlPill, flexDirection: "row", alignItems: "center", paddingHorizontal: 10 }}>
        <Symbol name="magnifyingglass" size={12} color={theme.textSecondary} style={{ width: 14, height: 14 }} />
        <TextInput
          autoFocus={autoFocus}
          value={query}
          onChangeText={setQuery}
          placeholder="Search"
          placeholderTextColor={theme.placeholder}
          enableFocusRing={false}
          keyDownEvents={onEscape ? [{ key: "Escape" }] : undefined}
          onKeyPress={onEscape ? onEscapeKey(onEscape) : undefined}
          onSubmitEditing={() => {
            const first = data.find((r) => "icons" in r);
            if (first && "icons" in first && first.icons[0]) onChoose(first.icons[0]);
          }}
          style={{ flex: 1, fontSize: 13, marginLeft: 6, color: theme.textPrimary, paddingVertical: 0 }}
        />
      </View>
      <FlatList
        ref={list}
        key={`${tab}:${columns}`}
        data={data}
        keyExtractor={(row) => row.key}
        style={{ height: cell * rows + (browsing ? HEADER : 0) }}
        showsVerticalScrollIndicator={false}
        initialNumToRender={rows + 2}
        windowSize={5}
        getItemLayout={(_, index) => ({ length: "header" in data[index]! ? HEADER : cell, offset: offsets[index]!, index })}
        scrollEventThrottle={32}
        onScroll={
          browsing
            ? (e) => {
                const y = e.nativeEvent.contentOffset.y + 1;
                const shown = [...groupAt].reverse().find((g) => g.y <= y)?.id;
                if (shown && shown !== group) setGroup(shown);
              }
            : undefined
        }
        ListEmptyComponent={<Text style={{ padding: 8, fontSize: 12, color: theme.textTertiary }}>No matches</Text>}
        renderItem={({ item }) =>
          "header" in item ? (
            <View style={{ height: HEADER, justifyContent: "center", paddingHorizontal: 4 }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textTertiary }}>{item.header}</Text>
            </View>
          ) : (
            <View style={{ flexDirection: "row", height: cell }}>
              {item.icons.map((icon) => (
                <Cell key={icon} icon={icon} size={cell} bold={bold} highlight={highlight} selected={icon === current} onPress={() => onChoose(icon)} />
              ))}
            </View>
          )
        }
      />
      {browsing ? (
        <View
          style={{
            height: BAR,
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            borderTopWidth: 0.5,
            borderTopColor: theme.dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
            paddingTop: 4,
          }}
        >
          {EMOJI_GROUPS.map((g) => (
            <Pressable key={g.id} onPress={() => jump(g.id)} tooltip={g.title}>
              <View
                style={{
                  width: 28,
                  height: 24,
                  borderRadius: 7,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: g.id === group ? highlight : undefined,
                }}
              >
                <Symbol name={g.symbol} size={13} color={g.id === group ? theme.textPrimary : theme.textSecondary} style={{ width: 16, height: 16 }} />
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// yab's switch between the two kinds: a pill with the chosen one filled in the accent.
function Segmented({ value, onChange }: { value: "emoji" | "symbols"; onChange: (tab: "emoji" | "symbols") => void }) {
  const theme = useTheme();
  const accent = formColors(theme).accent;
  return (
    <View style={{ flexDirection: "row", padding: 2, borderRadius: 9, backgroundColor: theme.dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)" }}>
      {(["emoji", "symbols"] as const).map((t) => (
        <Pressable key={t} onPress={() => onChange(t)}>
          <View
            style={{
              height: 24,
              minWidth: 64,
              paddingHorizontal: 12,
              borderRadius: 7,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: value === t ? accent : undefined,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "500", color: value === t ? "#FFFFFF" : theme.textPrimary }}>{t === "emoji" ? "Emoji" : "Icon"}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function Cell({
  icon,
  size,
  bold,
  highlight,
  selected,
  onPress,
}: {
  icon: string;
  size: number;
  bold?: boolean;
  highlight: string;
  selected: boolean;
  onPress(): void;
}) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable onPress={onPress}>
      <View
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: size,
          height: size,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: hovered || selected ? highlight : undefined,
        }}
      >
        {icon.startsWith(SYMBOL_PREFIX) ? (
          <Symbol
            name={icon.slice(SYMBOL_PREFIX.length)}
            size={Math.round(size * 0.48)}
            weight={bold ? "semibold" : undefined}
            color={symbolColor(icon.slice(SYMBOL_PREFIX.length), theme.dark) ?? theme.icon}
            rendering="hierarchical"
            style={{ width: size * 0.66, height: size * 0.66 }}
          />
        ) : (
          <Text style={{ fontSize: Math.round(size * 0.62) }}>{icon}</Text>
        )}
      </View>
    </Pressable>
  );
}
