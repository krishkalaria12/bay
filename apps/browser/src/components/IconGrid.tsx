import { Symbol } from "@bay/shell";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { onEscapeKey } from "../lib/escapeKey";
import { SYMBOL_PREFIX } from "../lib/constants";
import { useTheme } from "../lib/theme";
import { symbolColor } from "./symbolColors";

// The icon chooser shared by the sidebar's picker (tabs, groups, folders) and the spaces': a search field, emoji or
// SF Symbols, and a grid of them. An icon is an emoji, or SYMBOL_PREFIX and a symbol's name.

/** A symbol on offer, with the words a search finds it by. */
export type IconChoice = { name: string; words: string };

export const EMOJI: [string, string][] = [
  ["⭐️", "star favorite"],
  ["🔥", "fire hot"],
  ["❤️", "heart love"],
  ["✅", "check done"],
  ["📌", "pin"],
  ["🚀", "rocket launch ship"],
  ["💡", "idea bulb"],
  ["📝", "note memo write"],
  ["📚", "books read study"],
  ["📖", "book read"],
  ["🎓", "school graduate"],
  ["💼", "work briefcase"],
  ["🏠", "home house"],
  ["🛒", "shopping cart"],
  ["💰", "money"],
  ["💳", "card pay"],
  ["📈", "chart growth stocks"],
  ["📊", "chart data"],
  ["🗓️", "calendar date"],
  ["⏰", "alarm time"],
  ["📧", "email mail"],
  ["💬", "chat message"],
  ["📞", "phone call"],
  ["🎥", "video camera"],
  ["🎵", "music song"],
  ["🎧", "headphones music"],
  ["🎮", "game play"],
  ["🎨", "art design paint"],
  ["📷", "photo camera"],
  ["🎬", "movie film"],
  ["📺", "tv watch"],
  ["🍿", "popcorn movie"],
  ["✈️", "travel plane"],
  ["🗺️", "map travel"],
  ["🏖️", "beach holiday"],
  ["🌍", "world earth globe"],
  ["🍕", "pizza food"],
  ["🍔", "burger food"],
  ["☕️", "coffee"],
  ["🍷", "wine"],
  ["🍎", "apple fruit"],
  ["🥗", "salad food healthy"],
  ["🏋️", "gym fitness"],
  ["⚽️", "football soccer sport"],
  ["🏀", "basketball sport"],
  ["🚴", "bike cycling"],
  ["🧘", "yoga calm"],
  ["💊", "health pill"],
  ["🐶", "dog pet"],
  ["🐱", "cat pet"],
  ["🦊", "fox"],
  ["🐼", "panda"],
  ["🦄", "unicorn"],
  ["🐙", "octopus github"],
  ["🌱", "plant grow"],
  ["🌸", "flower blossom"],
  ["🌈", "rainbow"],
  ["☀️", "sun"],
  ["🌙", "moon night"],
  ["❄️", "snow cold"],
  ["⚡️", "lightning fast"],
  ["💎", "gem diamond"],
  ["🎁", "gift present"],
  ["🎉", "party celebrate"],
  ["🏆", "trophy win"],
  ["🎯", "target goal"],
  ["🧠", "brain think"],
  ["👀", "eyes look"],
  ["🤖", "robot ai bot"],
  ["👾", "alien game"],
  ["💻", "laptop computer code"],
  ["🖥️", "desktop computer"],
  ["⌨️", "keyboard type"],
  ["🛠️", "tools build"],
  ["⚙️", "settings gear"],
  ["🔧", "wrench fix"],
  ["🧪", "test lab science"],
  ["🔬", "science research"],
  ["🐛", "bug"],
  ["🔒", "lock secure"],
  ["🔑", "key"],
  ["🧩", "puzzle extension"],
  ["📦", "package box"],
  ["🗂️", "folder files"],
  ["📁", "folder"],
  ["🗃️", "archive"],
  ["📰", "news paper"],
  ["🔗", "link"],
  ["🔍", "search find"],
  ["🧭", "compass explore"],
  ["🏷️", "tag label"],
  ["💭", "thought"],
  ["❓", "question"],
  ["❗️", "important"],
  ["⚠️", "warning"],
  ["🚧", "construction wip"],
  ["🟥", "red square"],
  ["🟧", "orange square"],
  ["🟨", "yellow square"],
  ["🟩", "green square"],
  ["🟦", "blue square"],
  ["🟪", "purple square"],
  ["🔴", "red circle"],
  ["🟠", "orange circle"],
  ["🟡", "yellow circle"],
  ["🟢", "green circle"],
  ["🔵", "blue circle"],
  ["🟣", "purple circle"],
];

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

export function IconGrid({ symbols, current, onChoose, onEscape, columns, cell, rows, highlight, bold, prefer = "symbols", autoFocus }: GridProps) {
  const theme = useTheme();
  const tabs = prefer === "emoji" ? (["emoji", "symbols"] as const) : (["symbols", "emoji"] as const);
  const [tab, setTab] = useState<"emoji" | "symbols">(() => {
    if (!current) return prefer;
    return current.startsWith(SYMBOL_PREFIX) ? "symbols" : "emoji";
  });
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const items =
    tab === "emoji"
      ? EMOJI.filter(([, words]) => !q || words.includes(q)).map(([e]) => e)
      : symbols.filter((s) => !q || s.name.includes(q) || s.words.includes(q)).map((s) => SYMBOL_PREFIX + s.name);

  return (
    <View style={{ width: columns * cell, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View
          style={{ flex: 1, height: 26, borderRadius: 8, backgroundColor: theme.urlPill, flexDirection: "row", alignItems: "center", paddingHorizontal: 7 }}
        >
          <Symbol name="magnifyingglass" size={11} color={theme.textSecondary} style={{ width: 14, height: 14 }} />
          <TextInput
            autoFocus={autoFocus}
            value={query}
            onChangeText={setQuery}
            placeholder={tab === "emoji" ? "Search emoji" : "Search icons"}
            placeholderTextColor={theme.placeholder}
            enableFocusRing={false}
            keyDownEvents={onEscape ? [{ key: "Escape" }] : undefined}
            onKeyPress={onEscape ? onEscapeKey(onEscape) : undefined}
            onSubmitEditing={() => items[0] && onChoose(items[0])}
            style={{ flex: 1, fontSize: 12, marginLeft: 5, color: theme.textPrimary, paddingVertical: 0 }}
          />
        </View>
        {tabs.map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} tooltip={t === "emoji" ? "Emoji" : "Icons"}>
            <View
              style={{
                width: 28,
                height: 26,
                borderRadius: 8,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: tab === t ? highlight : undefined,
              }}
            >
              <Symbol name={t === "emoji" ? "face.smiling" : "star.square.on.square"} size={13} color={theme.icon} style={{ width: 16, height: 16 }} />
            </View>
          </Pressable>
        ))}
      </View>
      <ScrollView style={{ height: cell * rows }} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {items.map((icon) => (
            <Cell key={icon} icon={icon} size={cell} bold={bold} highlight={highlight} selected={icon === current} onPress={() => onChoose(icon)} />
          ))}
          {items.length === 0 ? <Text style={{ padding: 8, fontSize: 12, color: theme.textTertiary }}>No matches</Text> : null}
        </View>
      </ScrollView>
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
            size={15}
            weight={bold ? "semibold" : undefined}
            color={symbolColor(icon.slice(SYMBOL_PREFIX.length), theme.dark) ?? theme.icon}
            rendering="hierarchical"
            style={{ width: 20, height: 20 }}
          />
        ) : (
          <Text style={{ fontSize: 18 }}>{icon}</Text>
        )}
      </View>
    </Pressable>
  );
}
