import { capabilities, Pressable, View } from "@bay/platform";
import { closeWindow, minimizeWindow, onWindowEvent, setWindowCaption, Symbol, toggleMaximizeWindow, windowState, type WindowState } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useTheme } from "../../lib/theme";
import { useHover } from "../primitives";
import { CAPTION_BUTTON_WIDTH } from "./windowButtons";

// Windows 11's own close colours.
const CLOSE_HOVER = "#C42B1C";
const CLOSE_PRESSED = "#C42B1CE6";
const GLYPH = 10;

type Props = {
  windowId: string;
  /** From the window's top: the buttons fill it to here. */
  height: number;
  /** From the window's top: where the glyphs centre, level with the bar beside them. */
  glyphCenter?: number;
  /** A page runs up under the window's corner: the buttons show only while the pointer is over them. */
  onHover?: boolean;
};

/** Minimize, maximize and close at the window's top right, on hosts where the app draws its caption (Windows). The
 *  host treats the maximize button as the window's (HTMAXBUTTON), so Windows offers Snap Layouts over it; its clicks
 *  still come here. */
export function CaptionButtons(props: Props) {
  return capabilities.captionButtons ? <Caption {...props} /> : null;
}

function Caption({ windowId, height, glyphCenter, onHover = false }: Props) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const { hovered, hoverProps } = useHover();
  const [state, setState] = useState<WindowState>({ maximized: false, fullscreen: false });
  useEffect(() => {
    let live = true;
    void windowState(windowId).then(
      (s) => live && setState(s),
      () => {},
    );
    const subscription = onWindowEvent((e) => {
      if (e.type === "state" && e.id === windowId) setState({ maximized: e.maximized, fullscreen: e.fullscreen });
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, [windowId]);

  // The buttons sit at the window's corner, so the maximize button's rect follows from its size alone.
  const dark = useRef(theme.dark);
  useEffect(() => {
    dark.current = theme.dark;
  }, [theme.dark]);
  const shown = !state.fullscreen;
  useEffect(() => {
    const maximize: [number, number, number, number] | null = shown ? [width - 2 * CAPTION_BUTTON_WIDTH, 0, CAPTION_BUTTON_WIDTH, height] : null;
    void setWindowCaption(windowId, { maximize, dark: theme.dark }).catch(() => {});
  }, [windowId, width, height, shown, theme.dark]);
  useEffect(() => () => void setWindowCaption(windowId, { maximize: null, dark: dark.current }).catch(() => {}), [windowId]);

  if (!shown) return null;
  const glyphTop = (glyphCenter ?? height / 2) - GLYPH / 2;
  return (
    <View
      {...hoverProps}
      mouseDownCanMoveWindow={false}
      style={{ position: "absolute", top: 0, right: 0, height, flexDirection: "row", opacity: onHover && !hovered ? 0 : 1 }}
    >
      <CaptionButton icon="window.minimize" label="Minimize" height={height} glyphTop={glyphTop} onPress={() => void minimizeWindow(windowId)} />
      <CaptionButton
        icon={state.maximized ? "window.restore" : "window.maximize"}
        // Windows shows Snap Layouts over this button in place of a tooltip.
        label={state.maximized ? "Restore Down" : "Maximize"}
        tooltip={false}
        height={height}
        glyphTop={glyphTop}
        onPress={() => void toggleMaximizeWindow(windowId)}
      />
      <CaptionButton icon="window.close" label="Close" close height={height} glyphTop={glyphTop} onPress={() => void closeWindow(windowId)} />
    </View>
  );
}

function CaptionButton({
  icon,
  label,
  tooltip = true,
  close = false,
  height,
  glyphTop,
  onPress,
}: {
  icon: string;
  label: string;
  tooltip?: boolean;
  close?: boolean;
  height: number;
  glyphTop: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} tooltip={tooltip ? label : undefined}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
        {({ pressed }) => {
          const fill = close
            ? pressed
              ? CLOSE_PRESSED
              : hovered
                ? CLOSE_HOVER
                : undefined
            : pressed
              ? theme.toolbarPressed
              : hovered
                ? theme.toolbarHover
                : undefined;
          return (
            <View style={{ width: CAPTION_BUTTON_WIDTH, height, backgroundColor: fill }}>
              <Symbol
                name={icon}
                size={GLYPH}
                weight="light"
                color={close && (hovered || pressed) ? "#FFFFFF" : theme.icon}
                style={{ position: "absolute", top: glyphTop, left: (CAPTION_BUTTON_WIDTH - GLYPH) / 2, width: GLYPH, height: GLYPH }}
              />
            </View>
          );
        }}
      </Pressable>
    </View>
  );
}
