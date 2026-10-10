import { Surface } from "@bay/shell";
import { Pressable, Text, View } from "react-native";
import { hex, useTheme } from "../../lib/theme";
import { useSidebarOnRight } from "../layout/windowLayout";
import { useLive } from "../../live/store";
import { useBrowser } from "../../store/browser";
import { IconGrid, type IconChoice } from "../IconGrid";
import { SPACE_SYMBOLS } from "../spaces/icons";
import { setIcon } from "./actions";
import { setSidebarUi, useSidebarUi } from "./state";
import { useSidebarTokens } from "./tokens";
import { ICON_PICKER_CELL, ICON_PICKER_COLUMNS, ICON_PICKER_WIDTH } from "./constants";

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
  const close = () => setSidebarUi({ iconPicker: null });
  const choose = (icon: string | null) => {
    setIcon(picker, icon);
    close();
  };
  const width = ICON_PICKER_WIDTH;
  let place: { top?: number; bottom?: number; left: number };
  if (space) {
    // Above the space's icon at the sidebar's foot, centred on it.
    const x = picker.anchor ? picker.anchor.x + picker.anchor.width / 2 - width / 2 : right ? windowWidth - sidebarWidth : 8;
    const y = picker.anchor?.y ?? windowHeight - 44;
    place = { bottom: Math.max(8, windowHeight - y + 6), left: Math.max(8, Math.min(windowWidth - width - 8, x)) };
  } else if (right) {
    // Beside the row it's for, toward the page, and no further into the page than the sidebar's edge.
    const edge = windowWidth - sidebarWidth - 6 - width;
    place = {
      top: Math.max(8, (picker.anchor?.y ?? 60) - 8),
      left: picker.anchor ? Math.min(windowWidth - width - 8, Math.max(edge, picker.anchor.x - 6 - width)) : edge,
    };
  } else {
    place = {
      top: Math.max(8, (picker.anchor?.y ?? 60) - 8),
      left: picker.anchor ? Math.max(8, Math.min(sidebarWidth + 6, picker.anchor.x + picker.anchor.width + 6)) : sidebarWidth + 6,
    };
  }

  return (
    <>
      <Pressable onPress={close} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }} />
      <Surface
        fill={hex(theme.panel)}
        cornerRadius={14}
        borderColor={hex(theme.panelBorder)}
        borderWidth={0.5}
        shadowColor="#000000"
        shadowOpacity={theme.panelShadowOpacity}
        shadowRadius={20}
        shadowOffset={[0, 8]}
        style={{ position: "absolute", ...place, width, padding: 8, gap: 8 }}
      >
        <IconGrid
          symbols={space ? SPACE_SYMBOLS : SYMBOLS}
          current={current}
          onChoose={choose}
          onEscape={close}
          columns={ICON_PICKER_COLUMNS}
          cell={ICON_PICKER_CELL}
          rows={6}
          highlight={tokens.pickerCellHover}
          bold={space}
          prefer={space ? "symbols" : "emoji"}
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
                <Text style={{ fontSize: 12, color: theme.textPrimary }}>{space ? "Use Initial" : "Reset Icon"}</Text>
              </View>
            )}
          </Pressable>
        ) : null}
      </Surface>
    </>
  );
}
