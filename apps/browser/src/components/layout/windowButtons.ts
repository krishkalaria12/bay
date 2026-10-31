import { capabilities } from "@bay/platform";
import { windowButtonLayout, type WindowButtonLayout } from "@bay/shell";
import { layout } from "../../lib/constants";

/** Native macOS traffic lights keep their existing spacing. */
export const LIGHTS_WIDTH = capabilities.trafficLights ? layout.trafficLightsWidth : 0;
/** Windows' own caption button width. */
export const CAPTION_BUTTON_WIDTH = 46;

/** The caption buttons the app draws: Windows' minimize, maximize and close. macOS has its traffic lights, and Linux
 *  windows show none, as on macOS the window is the app's own: the desktop's shortcuts and title-bar gestures move,
 *  maximize and close it. */
const native = windowButtonLayout();
const current: WindowButtonLayout = Object.freeze({ left: Object.freeze([...native.left]), right: Object.freeze([...native.right]) });

export const getWindowButtonLayout = () => current;
/** A stable layout: it never changes while the app runs. */
export const useWindowButtonLayout = () => current;

/** Room at each outer window edge, including native macOS lights. */
export function windowButtonRoom(buttons: WindowButtonLayout) {
  return { left: LIGHTS_WIDTH + buttons.left.length * CAPTION_BUTTON_WIDTH, right: buttons.right.length * CAPTION_BUTTON_WIDTH };
}

/** The native maximize hit target follows the displayed order and omissions. */
export function captionMaximizeRect(buttons: WindowButtonLayout, width: number, height: number): [number, number, number, number] | null {
  for (const side of ["left", "right"] as const) {
    const index = buttons[side].indexOf("maximize");
    if (index !== -1)
      return [(side === "left" ? 0 : width - buttons.right.length * CAPTION_BUTTON_WIDTH) + index * CAPTION_BUTTON_WIDTH, 0, CAPTION_BUTTON_WIDTH, height];
  }
  return null;
}
