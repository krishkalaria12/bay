import { Pressable, View } from "@bay/platform";
import { displayUrl, type Suggestion } from "@bay/core";
import { Symbol } from "@bay/shell";
import { memo } from "react";
import { Text } from "react-native";
import { useTheme } from "../../lib/theme";
import { Favicon, IconButton, useHover } from "../primitives";
import { CalculationAnswer } from "./CalculationAnswer";
import { calculationRowHeight } from "./constants";
import type { ScopeColors } from "./scopeColors";

export function SuggestionIcon({ suggestion: s, color }: { suggestion: Suggestion; color?: string }) {
  const theme = useTheme();
  const tint = color ?? theme.textSecondary;
  switch (s.kind) {
    case "page":
      return <Favicon url={s.url} favicon={s.favicon} />;
    case "create":
      return <Favicon url={`https://${s.site}`} />;
    case "search":
      return <Symbol name="magnifyingglass" size={13} color={tint} style={{ width: 16, height: 16 }} />;
    case "calc":
      return <Symbol name="equal.circle" size={14} color={tint} style={{ width: 16, height: 16 }} />;
    case "emoji":
      return <Text style={{ width: 20, fontSize: 17, textAlign: "center" }}>{s.value}</Text>;
    case "action":
      return <Symbol name={s.icon ?? "command"} size={13} color={tint} style={{ width: 16, height: 16 }} />;
  }
}

function labels(s: Suggestion): [string, string | null] {
  switch (s.kind) {
    case "page":
      if (s.tabId) return [s.title || displayUrl(s.url), "Switch to Tab"];
      if (s.cleanedId) return [s.title || displayUrl(s.url), "Restore Tab"];
      return s.title ? [s.title, displayUrl(s.url)] : [displayUrl(s.url), null];
    case "search":
      return [s.query, null];
    case "calc":
      return [s.value, s.expression];
    case "emoji":
      return [s.name, null];
    case "action":
    case "create":
      return [s.title, null];
  }
}

export type RowActions = {
  choose(s: Suggestion): void;
  hover(index: number): void;
  remove(url: string): void;
};

export function SuggestionList({
  items,
  selectedIndex,
  trailing,
  dropdown,
  actions,
  selectionColors,
}: {
  items: Suggestion[];
  selectedIndex: number;
  trailing: string | null;
  dropdown: boolean;
  actions: RowActions;
  selectionColors?: ScopeColors | null;
}) {
  if (!items.length) return null;
  return (
    <View style={{ paddingHorizontal: dropdown ? 6 : 9, paddingBottom: dropdown ? 6 : 2 }}>
      {items.map((s, i) => (
        <SuggestionRow
          key={i}
          index={i}
          suggestion={s}
          selected={i === selectedIndex}
          trailing={i === 0 ? trailing : null}
          actions={actions}
          colors={i === selectedIndex ? selectionColors : null}
        />
      ))}
    </View>
  );
}

function sameSuggestion(a: Suggestion, b: Suggestion): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as (keyof Suggestion)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

const SuggestionRow = memo(
  function SuggestionRow({
    suggestion: s,
    index,
    selected,
    trailing,
    actions,
    colors,
  }: {
    suggestion: Suggestion;
    index: number;
    selected: boolean;
    trailing: string | null;
    actions: RowActions;
    colors?: ScopeColors | null;
  }) {
    const theme = useTheme();
    const { hovered, hoverProps } = useHover();
    const [title, accessory] = labels(s);
    const hint = trailing ?? (s.kind === "action" ? s.hint : null);
    const onRemove = s.kind === "page" && s.visited && !s.tabId && !s.cleanedId ? () => actions.remove(s.url) : undefined;
    const removable = !!onRemove && (hovered || selected);
    return (
      <View
        onMouseEnter={() => {
          hoverProps.onMouseEnter();
          actions.hover(index);
        }}
        onMouseLeave={hoverProps.onMouseLeave}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={s.kind === "calc" ? `${s.expression}, ${s.value}, copy answer` : title}
          accessibilityState={{ selected }}
          onPress={() => actions.choose(s)}
        >
          <View
            style={{
              height: s.kind === "calc" ? calculationRowHeight(s) : 35,
              marginVertical: 2.5,
              borderRadius: 11,
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 13,
              gap: 11,
              backgroundColor: colors?.background ?? (selected ? theme.rowSelected : hovered ? theme.rowHover : undefined),
            }}
          >
            {s.kind === "calc" ? (
              <CalculationAnswer suggestion={s} selected={selected} />
            ) : (
              <>
                <SuggestionIcon suggestion={s} color={colors?.text} />
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 14, color: colors?.text ?? theme.textPrimary }}>
                  {title}
                  {accessory ? (
                    <Text style={{ color: colors?.text ?? theme.textSecondary }}>
                      {" — "}
                      {accessory}
                    </Text>
                  ) : null}
                </Text>
                <View style={{ flex: 1 }} />
                {hint && !removable ? <Text style={{ fontSize: 12, color: colors?.text ?? theme.textTertiary }}>{hint}</Text> : null}
                {removable ? (
                  <IconButton
                    icon="xmark"
                    size={10}
                    box={22}
                    radius={6}
                    color={colors?.text ?? theme.textSecondary}
                    tooltip="Remove from History"
                    onPress={onRemove}
                  />
                ) : null}
              </>
            )}
          </View>
        </Pressable>
      </View>
    );
  },
  (a, b) =>
    a.index === b.index &&
    a.selected === b.selected &&
    a.trailing === b.trailing &&
    a.actions === b.actions &&
    a.colors?.background === b.colors?.background &&
    a.colors?.text === b.colors?.text &&
    sameSuggestion(a.suggestion, b.suggestion),
);
