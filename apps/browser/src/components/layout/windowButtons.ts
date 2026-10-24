import { capabilities, platformOS } from "@bay/platform";
import { onAppEvent, windowButtonLayout, type WindowButtonLayout } from "@bay/shell";
import { useSyncExternalStore } from "react";
import { layout } from "../../lib/constants";

/** Native macOS traffic lights keep their existing spacing. */
export const LIGHTS_WIDTH = capabilities.trafficLights ? layout.trafficLightsWidth : 0;
export const CAPTION_BUTTON_WIDTH = 46;

const listeners = new Set<() => void>();
let subscription: ReturnType<typeof onAppEvent> | undefined;
let current: WindowButtonLayout = immutableLayout(windowButtonLayout());

function immutableLayout(value: WindowButtonLayout): WindowButtonLayout {
  return Object.freeze({ left: Object.freeze([...value.left]), right: Object.freeze([...value.right]) });
}

function update(value: WindowButtonLayout) {
  if (value.left.join() === current.left.join() && value.right.join() === current.right.join()) return;
  current = immutableLayout(value);
  for (const listener of listeners) listener();
}

export const getWindowButtonLayout = () => current;

export function subscribeWindowButtonLayout(listener: () => void) {
  listeners.add(listener);
  if (!subscription) {
    // Subscribe first: a desktop setting may have changed since the initial render.
    let receivedEvent = false;
    subscription = onAppEvent((event) => {
      if (event.type !== "windowButtonLayout") return;
      receivedEvent = true;
      update(event.layout);
    });
    const snapshot = windowButtonLayout();
    if (!receivedEvent) update(snapshot);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      subscription?.remove();
      subscription = undefined;
    }
  };
}

export function useWindowButtonLayout() {
  return useSyncExternalStore(subscribeWindowButtonLayout, getWindowButtonLayout);
}

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

/** Linux utilities need a caption band; Windows and macOS retain their existing content origin. */
export function utilityCaptionHeight(buttons: WindowButtonLayout, height: number) {
  return platformOS === "linux" && (buttons.left.length > 0 || buttons.right.length > 0) ? height : 0;
}

/** The collapsed top-tabs popup shares the caption's height in an ordinary Linux window. */
export function captionPeekInsets(buttons: WindowButtonLayout, inset: number) {
  const room = windowButtonRoom(buttons);
  return platformOS === "linux" ? { left: Math.max(inset, room.left), right: Math.max(inset, room.right) } : { left: inset, right: inset };
}
