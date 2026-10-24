import { capabilities, Pressable, View } from "@bay/platform";
import { closeWindow, minimizeWindow, setWindowCaption, Symbol, toggleMaximizeWindow, type WindowButton, type WindowState } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useTheme } from "../../lib/theme";
import { useHover } from "../primitives";
import { startCaptionStateSync } from "./captionStateSync";
import { captionMaximizeRect, useWindowButtonLayout, CAPTION_BUTTON_WIDTH } from "./windowButtons";

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
  onHover?: boolean | { left: boolean; right: boolean };
};

/** Ordered caption groups on hosts where the app draws its caption. The
 *  host treats the maximize button as the window's (HTMAXBUTTON), so Windows offers Snap Layouts over it; its clicks
 *  still come here. */
export function CaptionButtons(props: Props) {
  return capabilities.captionButtons ? <Caption {...props} /> : null;
}

function Caption({ windowId, height, glyphCenter, onHover = false }: Props) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const buttons = useWindowButtonLayout();
  const [state, setState] = useState<WindowState>({ maximized: false, fullscreen: false });
  useEffect(() => startCaptionStateSync(windowId, setState), [windowId]);

  // Windows uses this rect for HTMAXBUTTON and Snap Layouts.
  const dark = useRef(theme.dark);
  useEffect(() => {
    dark.current = theme.dark;
  }, [theme.dark]);
  const shown = !state.fullscreen;
  useEffect(() => {
    const maximize: [number, number, number, number] | null = shown ? captionMaximizeRect(buttons, width, height) : null;
    void setWindowCaption(windowId, { maximize, dark: theme.dark }).catch(() => {});
  }, [windowId, width, height, shown, theme.dark, buttons]);
  useEffect(() => () => void setWindowCaption(windowId, { maximize: null, dark: dark.current }).catch(() => {}), [windowId]);

  if (!shown) return null;
  const glyphTop = (glyphCenter ?? height / 2) - GLYPH / 2;
  return (
    <>
      {(["left", "right"] as const).map((side) =>
        buttons[side].length ? (
          <CaptionGroup
            key={side}
            side={side}
            buttons={buttons[side]}
            windowId={windowId}
            maximized={state.maximized}
            height={height}
            glyphTop={glyphTop}
            onHover={typeof onHover === "boolean" ? onHover : onHover[side]}
          />
        ) : null,
      )}
    </>
  );
}

function CaptionGroup({
  side,
  buttons,
  windowId,
  maximized,
  height,
  glyphTop,
  onHover,
}: {
  side: "left" | "right";
  buttons: readonly WindowButton[];
  windowId: string;
  maximized: boolean;
  height: number;
  glyphTop: number;
  onHover: boolean;
}) {
  const { hovered, hoverProps } = useHover();
  return (
    <View
      {...hoverProps}
      mouseDownCanMoveWindow={false}
      style={{ position: "absolute", top: 0, [side]: 0, height, flexDirection: "row", opacity: onHover && !hovered ? 0 : 1 }}
    >
      {buttons.map((button) => (
        <CaptionButton
          key={button}
          icon={button === "maximize" ? (maximized ? "window.restore" : "window.maximize") : `window.${button}`}
          label={button === "maximize" ? (maximized ? "Restore Down" : "Maximize") : button === "close" ? "Close" : "Minimize"}
          // Windows shows Snap Layouts over maximize in place of a tooltip.
          tooltip={button !== "maximize"}
          close={button === "close"}
          height={height}
          glyphTop={glyphTop}
          onPress={() => void (button === "close" ? closeWindow(windowId) : button === "minimize" ? minimizeWindow(windowId) : toggleMaximizeWindow(windowId))}
        />
      ))}
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
