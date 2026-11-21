import { isMac, menuKeyName, virtualKeyCode } from "@bay/platform";
import type { HotKeyStatus } from "@bay/desktop";
import { create } from "zustand";
import type { LittleBayShortcut } from "../../store/settings";

// Little Bay from any app (packages/shell LittleBayAccess.swift), as Little Arc's: a shortcut and a menu bar button,
// each opening a Little Bay ready to type with Bay in the background or not. Settings › Links turns them on. The
// Little Bay service registers them (service.ts).

/** Arc's ⌥⌘N, as the shortcut starts when it's turned on: "n" is key code 45 (kVK_ANSI_N). */
export const DEFAULT_LITTLE_BAY_SHORTCUT: LittleBayShortcut = { key: "n", keyCode: 45, modifiers: ["option", "command"] };

/** Resolves a saved shortcut using this host's key codes. */
export const hotKeyCode = (shortcut: { key: string; keyCode: number }, mac: boolean = isMac): number | null =>
  mac ? shortcut.keyCode : virtualKeyCode(menuKeyName(shortcut.key));

/** Whether the shortcut is registered: "taken" when another app holds it. */
export const useLittleBayAccess = create<{ status: HotKeyStatus }>()(() => ({ status: "off" }));

/** Whether two choices are the same shortcut. */
export const sameShortcut = (a: LittleBayShortcut | null, b: LittleBayShortcut | null) =>
  a === b || (!!a && !!b && a.keyCode === b.keyCode && [...a.modifiers].sort().join() === [...b.modifiers].sort().join());
