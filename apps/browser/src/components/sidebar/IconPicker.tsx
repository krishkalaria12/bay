import { Surface, Symbol } from "@bay/shell";
import { useEffect, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { layout } from "../../lib/constants";
import { hex, useTheme } from "../../lib/theme";
import { useSidebarOnRight } from "../layout/windowLayout";
import { useLive } from "../../live/store";
import { useBrowser } from "../../store/browser";
import { IconGrid, type IconChoice } from "../IconGrid";
import { useHover } from "../primitives";
import { SPACE_EMOJI } from "../spaces/icons";
import { setIcon } from "./actions";
import { setSidebarUi, useSidebarUi } from "./state";
import { useSidebarTokens } from "./tokens";
import {
  ICON_PICKER_CELL,
  ICON_PICKER_COLUMNS,
  ICON_PICKER_HEIGHT,
  ICON_PICKER_WIDTH,
  PICKER_FADE_MS,
  SPACE_PICKER_COLUMNS,
  SPACE_PICKER_PAD,
} from "./constants";

const SYMBOLS: IconChoice[] = [
  "star",
  "heart",
  "bookmark",
  "flag",
  "pin",
  "bolt",
  "flame",
  "leaf",
  "globe",
  "house",
  "briefcase",
  "cart",
  "bag",
  "creditcard",
  "dollarsign.circle",
  "chart.bar",
  "chart.line.uptrend.xyaxis",
  "calendar",
  "clock",
  "alarm",
  "envelope",
  "bubble.left",
  "phone",
  "video",
  "music.note",
  "headphones",
  "gamecontroller",
  "paintbrush",
  "camera",
  "film",
  "tv",
  "airplane",
  "map",
  "car",
  "fork.knife",
  "cup.and.saucer",
  "figure.run",
  "sportscourt",
  "pawprint",
  "tree",
  "sun.max",
  "moon",
  "cloud",
  "snowflake",
  "sparkles",
  "gift",
  "trophy",
  "target",
  "brain",
  "eye",
  "laptopcomputer",
  "desktopcomputer",
  "keyboard",
  "hammer",
  "wrench.and.screwdriver",
  "gearshape",
  "testtube.2",
  "ant",
  "lock",
  "key",
  "puzzlepiece",
  "shippingbox",
  "folder",
  "archivebox",
  "newspaper",
  "link",
  "magnifyingglass",
  "safari",
  "tag",
  "lightbulb",
  "questionmark.circle",
  "exclamationmark.triangle",
  "book",
  "graduationcap",
  "doc.text",
  "list.bullet",
  "checkmark.circle",
  "person.2",
].map((name) => ({ name, words: "" }));

export function IconPicker({
  windowId,
  sidebarWidth,
  windowWidth,
  windowHeight,
}: {
  windowId: string;
  sidebarWidth: number;
  windowWidth: number;
  windowHeight: number;
}) {
  const picker = useSidebarUi((u) => (u.iconPicker?.windowId === windowId ? u.iconPicker : null));
  return picker ? <PickerPanel key={picker.id} picker={picker} sidebarWidth={sidebarWidth} windowWidth={windowWidth} windowHeight={windowHeight} /> : null;
}

type Picker = NonNullable<ReturnType<typeof useSidebarUi.getState>["iconPicker"]>;

function PickerPanel({ picker, sidebarWidth, windowWidth, windowHeight }: { picker: Picker; sidebarWidth: number; windowWidth: number; windowHeight: number }) {
  const theme = useTheme();
  const right = useSidebarOnRight();
  const tokens = useSidebarTokens();
  const liveIcon = useLive((s) => (picker.kind === "live" ? s.folders[picker.id.split("|")[1] ?? ""]?.icon : null));
  const current = useBrowser((s) => {
    switch (picker.kind) {
      case "tab":
        return s.tabs[picker.id]?.customIcon ?? null;
      case "live":
        return liveIcon ?? null;
      case "folder":
        return s.pinnedFolders[picker.id]?.icon ?? null;
      case "space":
        return s.spaces[picker.id]?.icon ?? null;
      default:
        return s.groups[picker.id]?.icon ?? null;
    }
  });
  const space = picker.kind === "space";
  // Fades in as it opens, and out before it goes.
  const shown = useSharedValue(0);
  useEffect(() => shown.set(withTiming(1, { duration: PICKER_FADE_MS, easing: Easing.out(Easing.cubic) })), []);
  const fade = useAnimatedStyle(() => ({ opacity: shown.get(), transform: [{ translateY: (1 - shown.get()) * 6 }] }));
  const closing = useRef(false);
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    shown.set(
      withTiming(0, { duration: PICKER_FADE_MS, easing: Easing.in(Easing.cubic) }, (done) => {
        if (done) runOnJS(setSidebarUi)({ iconPicker: null });
      }),
    );
  };
  const choose = (icon: string | null) => {
    setIcon(picker, icon);
    close();
  };
  // A space's panel is the sidebar's width, its emoji filling the row.
  const width = space ? sidebarWidth - layout.sidebarInset * 2 : ICON_PICKER_WIDTH;
  const spaceCell = Math.floor((width - SPACE_PICKER_PAD * 2) / SPACE_PICKER_COLUMNS);
  // Beside its row, but never past the window's foot.
  const top = Math.max(8, Math.min((picker.anchor?.y ?? 60) - 8, windowHeight - ICON_PICKER_HEIGHT - 8));
  let place: { top?: number; bottom?: number; left: number };
  if (space) {
    // Across the sidebar, just above the spaces at its foot.
    const y = picker.anchor?.y ?? windowHeight - 44;
    place = { bottom: Math.max(8, windowHeight - y + 6), left: (right ? windowWidth - sidebarWidth : 0) + layout.sidebarInset };
  } else if (right) {
    // Beside the row it's for, toward the page, and no further into the page than the sidebar's edge.
    const edge = windowWidth - sidebarWidth - 6 - width;
    place = {
      top,
      left: picker.anchor ? Math.min(windowWidth - width - 8, Math.max(edge, picker.anchor.x - 6 - width)) : edge,
    };
  } else {
    place = {
      top,
      left: picker.anchor ? Math.max(8, Math.min(sidebarWidth + 6, picker.anchor.x + picker.anchor.width + 6)) : sidebarWidth + 6,
    };
  }

  return (
    <>
      <Pressable onPress={close} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} />
      <Animated.View style={[{ position: "absolute", ...place, width }, fade]}>
        <Surface
          fill={hex(theme.panel)}
          cornerRadius={20}
          borderColor={hex(theme.panelBorder)}
          borderWidth={0.5}
          shadowColor="#000000"
          shadowOpacity={theme.panelShadowOpacity}
          shadowRadius={20}
          shadowOffset={[0, 8]}
          style={{ padding: space ? SPACE_PICKER_PAD : 10, gap: 8 }}
        >
          {space ? (
            <SpaceEmoji current={current} cell={spaceCell} onChoose={(icon) => setIcon(picker, icon)} onClose={close} />
          ) : (
            <>
              <IconGrid
                symbols={SYMBOLS}
                current={current}
                onChoose={choose}
                onEscape={close}
                columns={ICON_PICKER_COLUMNS}
                cell={ICON_PICKER_CELL}
                rows={6}
                highlight={tokens.pickerCellHover}
                prefer="emoji"
                autoFocus
              />
              {current ? (
                <Pressable onPress={() => choose(null)}>
                  {({ pressed }) => (
                    <View
                      style={{
                        height: 26,
                        borderRadius: 8,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: pressed ? tokens.pickerCellHover : theme.urlPill,
                      }}
                    >
                      <Text style={{ fontSize: 12, color: theme.textPrimary }}>Reset Icon</Text>
                    </View>
                  )}
                </Pressable>
              ) : null}
            </>
          )}
        </Surface>
      </Animated.View>
    </>
  );
}

// yab's emoji for a space (spaces/icons.tsx SPACE_EMOJI): a short set to pick from, the space showing each as it's chosen, and Done.

function SpaceEmoji({ current, cell, onChoose, onClose }: { current: string | null; cell: number; onChoose: (icon: string) => void; onClose: () => void }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 4 }}>
        <Text style={{ fontSize: 15, fontWeight: "700", color: theme.textPrimary }}>Emoji</Text>
        <Pressable onPress={onClose} accessibilityLabel="Close" tooltip="Close">
          {({ pressed }) => (
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? tokens.pickerCellHover : undefined,
              }}
            >
              <Symbol name="xmark" size={11} weight="medium" color={theme.textSecondary} style={{ width: 14, height: 14 }} />
            </View>
          )}
        </Pressable>
      </View>
      <View style={{ width: SPACE_PICKER_COLUMNS * cell, flexDirection: "row", flexWrap: "wrap" }}>
        {SPACE_EMOJI.map((emoji) => (
          <EmojiCell key={emoji} emoji={emoji} size={cell} selected={emoji === current} onPress={() => onChoose(emoji)} />
        ))}
      </View>
      <Pressable onPress={onClose}>
        {({ pressed }) => (
          <View
            style={{
              height: 30,
              marginTop: 4,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.dark ? "#EDEDED" : "#1C1C1E",
              opacity: pressed ? 0.8 : 1,
            }}
          >
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.dark ? "#1C1C1E" : "#FFFFFF" }}>Done</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

function EmojiCell({ emoji, size, selected, onPress }: { emoji: string; size: number; selected: boolean; onPress: () => void }) {
  const tokens = useSidebarTokens();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress}>
        <View
          style={{
            width: size,
            height: size,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: selected || hovered ? tokens.pickerCellHover : undefined,
          }}
        >
          <Text style={{ fontSize: Math.round(size * 0.66) }}>{emoji}</Text>
        </View>
      </Pressable>
    </View>
  );
}
