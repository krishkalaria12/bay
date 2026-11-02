import { requireNativeModule, requireNativeViewManager } from "expo-modules-core";
import { View, type ViewProps } from "react-native";

export type MenuShortcut = {
  id: string;
  title: string;
  path: string[];
  key: string;
  modifiers: ShortcutModifier[];
  defaultKey: string;
  defaultModifiers: ShortcutModifier[];
  remappable: boolean;
};

export type ShortcutModifier = "control" | "option" | "shift" | "command" | "function";

type LaunchAtLoginStatus = "enabled" | "requiresApproval" | "notRegistered" | "notFound";

const System = requireNativeModule<{
  isDefaultBrowser(): Promise<boolean>;
  setAsDefaultBrowser(): Promise<boolean>;
  launchAtLoginStatus(): Promise<LaunchAtLoginStatus>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  fileExists(path: string): boolean;
  // Optional: a build from before it has none.
  downloadsFolder?(): string | null;
  openFile(path: string): Promise<boolean>;
  revealFile(path: string): Promise<boolean>;
  copyFile?(path: string): Promise<boolean>;
  moveToTrash(path: string): Promise<boolean>;
  // Optional: a build from before Tidy Downloads has none.
  renameFile?(path: string, name: string): Promise<string | null>;
  fileIcon(path: string, size: number): Promise<string | null>;
  appIcon(pid: number, size: number): Promise<string | null>;
  hapticTick(): void;
  menuShortcuts(): Promise<MenuShortcut[]>;
  recordShortcut(): Promise<RecordedShortcut | null>;
  cancelRecording(): Promise<void>;
  setLittleBayMenuBarItem(on: boolean): Promise<void>;
  setLittleBayHotKey(keyCode: number | null, modifiers: ShortcutModifier[]): Promise<HotKeyStatus>;
}>("BaySystem");

/** A shortcut as typed: its character, its modifiers and the key's code (for a global shortcut). */
export type RecordedShortcut = { key: string; modifiers: ShortcutModifier[]; keyCode: number };
/** A global shortcut's registration: "taken" when another app holds the key, or macOS refused it. */
export type HotKeyStatus = "ok" | "off" | "taken";

export const isDefaultBrowser = () => System.isDefaultBrowser();
export const setAsDefaultBrowser = () => System.setAsDefaultBrowser();
export const launchAtLoginStatus = () => System.launchAtLoginStatus();
export const setLaunchAtLogin = (enabled: boolean) => System.setLaunchAtLogin(enabled);

export const fileExists = (path: string) => System.fileExists(path);
/** ~/Downloads, as macOS names it. */
export const downloadsFolder = (): string | null => System.downloadsFolder?.() ?? null;
export const openFile = (path: string) => System.openFile(path);
export const revealFile = (path: string) => System.revealFile(path);
/** A file URL on the pasteboard, ready to paste into Finder or attach to a message. */
export const copyFile = (path: string): Promise<boolean> => System.copyFile?.(path) ?? Promise.resolve(false);
export const moveToTrash = (path: string) => System.moveToTrash(path);
/** Renames a file beside itself, with a fresh " (n)" name on a collision. The new path, or null. */
export const renameFile = (path: string, name: string): Promise<string | null> => System.renameFile?.(path, name) ?? Promise.resolve(null);
export const fileIcon = (path: string, size = 32) => System.fileIcon(path, size);
export const runningAppIcon = (pid: number, size = 32) => System.appIcon(pid, size);
export const hapticTick = () => System.hapticTick();
export const menuShortcuts = () => System.menuShortcuts();
export const recordShortcut = () => System.recordShortcut();
export const cancelShortcutRecording = () => System.cancelRecording();
/** Little Bay's menu bar button (Settings › Links), opening one from any app. */
export const setLittleBayMenuBarItem = (on: boolean) => System.setLittleBayMenuBarItem(on);
/** Little Bay's shortcut from any app (a Carbon hot key); null turns it off. */
export const setLittleBayHotKey = (keyCode: number | null, modifiers: ShortcutModifier[] = []) => System.setLittleBayHotKey(keyCode, modifiers);

export type MiddleClickEvent = { shiftKey: boolean; altKey: boolean; metaKey: boolean };

export type SideButton = "back" | "forward";

export type MouseAreaProps = ViewProps & {
  path?: string | null;
  onMiddleClick?: (e: MiddleClickEvent) => void;
  /** A mouse's side buttons (3 and 4) released over the area or anything in it that doesn't take them. */
  onSideButton?: (button: SideButton) => void;
};

type NativeMouseAreaProps = Omit<MouseAreaProps, "onMiddleClick" | "onSideButton"> & {
  onMiddleClick?: (e: { nativeEvent: MiddleClickEvent }) => void;
  onSideButton?: (e: { nativeEvent: { button: SideButton } }) => void;
  hearsSideButtons?: boolean;
};

const NativeMouseArea = System ? requireNativeViewManager<NativeMouseAreaProps>("BayFileDrag") : null;

export function MouseArea({ path, onMiddleClick, onSideButton, ...props }: MouseAreaProps) {
  if (!NativeMouseArea) return <View {...props} />;
  return (
    <NativeMouseArea
      path={path}
      onMiddleClick={onMiddleClick && ((e) => onMiddleClick(e.nativeEvent))}
      hearsSideButtons={!!onSideButton}
      onSideButton={onSideButton && ((e) => onSideButton(e.nativeEvent.button))}
      {...props}
    />
  );
}
