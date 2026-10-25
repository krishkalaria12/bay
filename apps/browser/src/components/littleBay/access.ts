import { setLittleBayHotKey, setLittleBayMenuBarItem, type HotKeyStatus } from "@bay/shell";
import { create } from "zustand";
import { useBrowser } from "../../store/browser";
import type { LittleBayShortcut } from "../../store/settings";

// Little Bay from any app (packages/shell LittleBayAccess.swift), as Little Arc's: a shortcut and a menu bar button,
// each opening a Little Bay ready to type with Bay in the background or not. Settings › Links turns them on.

/** Arc's ⌥⌘N, as the shortcut starts when it's turned on: "n" is key code 45 (kVK_ANSI_N). */
export const DEFAULT_LITTLE_BAY_SHORTCUT: LittleBayShortcut = { key: "n", keyCode: 45, modifiers: ["option", "command"] };

/** Whether the shortcut is registered: "taken" when another app holds it. */
export const useLittleBayAccess = create<{ status: HotKeyStatus }>()(() => ({ status: "off" }));

const sameShortcut = (a: LittleBayShortcut | null, b: LittleBayShortcut | null) =>
  a === b || (!!a && !!b && a.keyCode === b.keyCode && [...a.modifiers].sort().join() === [...b.modifiers].sort().join());

let started = false;

export function startLittleBayAccess() {
  if (started) return;
  started = true;
  let shortcut: LittleBayShortcut | null = null;
  let menuBar = false;
  const apply = () => {
    const settings = useBrowser.getState().settings;
    const next = settings.littleBayShortcut ?? null;
    // A shortcut not registered yet (at launch) registers even when it's the one already chosen.
    const unregistered = !!next && useLittleBayAccess.getState().status === "off";
    if (!sameShortcut(next, shortcut) || unregistered) {
      shortcut = next;
      void setLittleBayHotKey(next?.keyCode ?? null, next?.modifiers ?? []).then(
        (status) => {
          // A newer choice has its own registration on the way.
          if (sameShortcut(shortcut, next)) useLittleBayAccess.setState({ status });
        },
        () => useLittleBayAccess.setState({ status: next ? "taken" : "off" }),
      );
    }
    if (settings.littleBayMenuBarItem !== menuBar) {
      menuBar = settings.littleBayMenuBarItem;
      void setLittleBayMenuBarItem(menuBar);
    }
  };
  apply();
  useBrowser.subscribe((s, prev) => {
    if (s.settings.littleBayShortcut !== prev.settings.littleBayShortcut || s.settings.littleBayMenuBarItem !== prev.settings.littleBayMenuBarItem) apply();
  });
}
