import { capabilities, isMac, platformOS } from "@bay/platform";
import { formatShortcut, menuShortcutStroke } from "@bay/platform/keys";
import type { ViewProps } from "@bay/platform";
import { requireNativeViewManager } from "./nativeViews";
import {
  requireNativeModule,
  requireOptionalNativeModule,
  nativeSnapshot,
  nativeDocumentWrite,
  nativeDocumentSave,
  type EventSubscription,
} from "@bay/platform/native";

export * from "./system";
export * from "./app";
export * from "./live";
export * from "./capture";
export * from "./easel";
export * from "./localFiles";
export * from "./cli";
export * from "./userScripts";

export type BrowserCommand =
  | "focusSidebar"
  | "sidebarKey"
  | "sidebarBlur"
  | "undoPinnedFolderMove"
  | "openLibrary"
  | "newEasel"
  | "newTab"
  | "newWindow"
  | "newIncognitoWindow"
  | "newLittleBay"
  | "joinMeeting"
  | "capturePortrait"
  | "toggleOpenLinksInLittleBay"
  | "removeFromSplit"
  | "togglePinRow"
  | "reopenClosedTab"
  | "reopenClosedWindow"
  | "restoreClosed"
  | "focusCommandBar"
  | "closeTab"
  | "closeAllTabs"
  | "print"
  | "copyUrl"
  | "copyUrlAsMarkdown"
  | "findInPage"
  | "findNext"
  | "findPrevious"
  | "setAppearance"
  | "reload"
  | "forceReload"
  | "toggleTabLayout"
  | "toggleSidebar"
  | "openSplitPane"
  | "useSelectionForFind"
  | "findAndReplace"
  | "jumpToSelection"
  | "focusNextPane"
  | "focusPreviousPane"
  | "toggleFullUrl"
  | "toggleAddressBar"
  | "toggleSidebarPosition"
  | "cast"
  | "zoomReset"
  | "zoomIn"
  | "zoomOut"
  | "devTools"
  | "toggleDeveloperMode"
  | "toggleDevTools"
  | "javaScriptConsole"
  | "inspectElements"
  | "viewSource"
  | "back"
  | "forward"
  | "nextTab"
  | "previousTab"
  | "selectTab"
  | "selectLastTab"
  | "togglePin"
  | "duplicateTab"
  | "moveTabToSpace"
  | "moveTabToWindow"
  | "bookmarkPage"
  | "addBookmarkToFolder"
  | "openBookmark"
  | "toggleMute"
  | "togglePageEngine"
  | "downloads"
  | "mergeAllWindows"
  | "switchSpace"
  | "nextSpace"
  | "previousSpace"
  | "newSpace"
  | "openSettings"
  | "importBrowserData"
  | "showHistory"
  | "clearBrowsingData"
  | "clearCookiesAndCache"
  | "manageBookmarks"
  | "bookmarkAllTabs"
  | "setBookmarksBar"
  | "toggleBookmarksBar"
  | "newTabInGroup"
  | "newGroupWithTabs"
  | "cleanUpTabs"
  | "tidyTabs"
  | "searchTabs"
  | "renameTab"
  | "changeTabIcon"
  | "returnToPinnedUrl"
  | "tabSwitcher"
  | "keepTab"
  | "closeOtherTabs"
  | "share"
  | "sendFeedback"
  | "keyboardShortcuts"
  | "copyDiagnostics"
  | "recordPerformanceIssue"
  | "toolTour"
  | "videoTour"
  | "releaseNotes"
  | "showOnboarding"
  | "taskManager"
  | "openExtension"
  | "addExtension"
  | "manageExtensions"
  | "pinExtensions"
  | "autofill"
  | "openFile"
  | "savePage"
  | "capture"
  | "captureFullPage"
  | "newBoost"
  | "editBoost"
  | "zapElements"
  | "toggleSiteBoosts"
  | "emailPageLocation"
  | "printWithSystemDialog"
  | "stop"
  | "caretBrowsing"
  | "moveTabDown"
  | "moveTabUp"
  | "closeTabGroup"
  | "openSpaceMenu";

export type CommandEvent = {
  command: BrowserCommand;
  arg: string | null;
  windowId: string | null;
};

export type WindowEvent =
  | { type: "focus"; id: string }
  | { type: "close"; id: string }
  | { type: "frame"; id: string; frame: [number, number, number, number] }
  | { type: "closeRequest"; id: string }
  // Windows' shared runtime: openWindow named this open utility window again, with these options.
  | { type: "opened"; id: string; options: OpenWindowOptions }
  | ({ type: "state"; id: string } & WindowState);

/** A window's placement, as its caption buttons show it (Windows). */
export type WindowState = {
  maximized: boolean;
  fullscreen: boolean;
  /** Ephemeral native state, never restored from a session. */
  minimized?: boolean;
  /** Restored/normal window size, including while maximized or fullscreen. No screen position. */
  size?: [number, number];
};
/** Desktop decoration order, from left to right within each physical window edge. */
export type WindowButton = "minimize" | "maximize" | "close";
export type WindowButtonLayout = { left: readonly WindowButton[]; right: readonly WindowButton[] };
/** The caption the UI draws (Windows): its maximize button, in the window from the top-left, for Snap Layouts; and
 *  its theme, which the system backdrop follows. */
export type WindowCaption = { maximize: [number, number, number, number] | null; dark: boolean };

export type AppEvent =
  | { type: "reopen" }
  | { type: "willQuit" }
  | { type: "quitCancelled" }
  | { type: "appearance"; dark: boolean }
  | { type: "windowButtonLayout"; layout: WindowButtonLayout }
  | { type: "quitWarningSuppressed" }
  | { type: "resignActive" }
  | { type: "screenLocked" }
  | { type: "controlReleased" }
  // Option held on its own (and let go): the hidden sidebar shows while it is.
  | { type: "optionHeld"; windowId: string }
  | { type: "optionReleased" }
  | { type: "switcherKey"; key: "escape" | "next" | "previous" }
  | { type: "switcherMouseUp" };

type ShellEvents = {
  onCommand: (e: CommandEvent) => void;
  onOpenURLs: (e: { urls: string[]; sourceApp?: string }) => void;
  onWindowEvent: (e: WindowEvent) => void;
  onAppEvent: (e: AppEvent) => void;
};

export type MenuItem =
  | { separator: true }
  | {
      id: string;
      title: string;
      symbol?: string;
      swatch?: string;
      key?: string;
      modifiers?: ("command" | "shift" | "option" | "control")[];
      // Web hosts: the trailing hint, filled in from key and modifiers.
      shortcut?: string;
      enabled?: boolean;
      checked?: boolean;
      children?: MenuItem[];
    };

export type OpenWindowOptions = {
  frame?: [number, number, number, number] | null;
  incognito?: boolean;
  title?: string;
  focus?: boolean;
  kind?: "browser" | "small" | "settings" | "import" | "taskManager";
  profile?: string;
  // Restored size without a screen position; the compositor places the window.
  maximized?: boolean;
  // Little Bay also opens at its remembered size, centred on the active screen.
  size?: [number, number];
  // Settings: the pane to show, and the space it is about.
  pane?: string;
  spaceId?: string;
};

export type MenuEntry = { id: string; title: string; current?: boolean };
export type MenuBookmark = { id: string; title: string; url?: string; children?: MenuBookmark[] };

export type MenuState = {
  checked: string[];
  disabled: string[];
  titles: Record<string, string>;
  spaces: MenuEntry[];
  windows: MenuEntry[];
  bookmarkFolders: MenuEntry[];
  recentBookmarks: MenuBookmark[];
  bookmarksBar: MenuBookmark[];
  otherBookmarks: MenuBookmark[];
  recentlyClosed: MenuEntry[];
  recentlyClosedGroups?: MenuEntry[];
  warnBeforeQuitting: boolean;
  warnBeforeClosingWindow?: boolean;
  downloadsInProgress?: number;
  extensions?: { id: string; title: string; icon?: string | null; enabled: boolean }[];
  shortcuts?: Record<string, string[]>;
};

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmTitle?: string;
  cancelTitle?: string;
  destructive?: boolean;
  suppression?: string;
  windowId?: string;
};

export type PromptOptions = {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  confirmTitle?: string;
  windowId?: string;
};

const Shell = requireNativeModule<{
  globalWindowCoordinates?: boolean;
  addListener<K extends keyof ShellEvents>(name: K, listener: ShellEvents[K]): EventSubscription;
  showMenu(items: MenuItem[]): Promise<string | null>;
  copyText(text: string): void;
  copyImage(base64: string): boolean;
  setSwitcherCapture(active: boolean): Promise<void>;
  startDictation(): void;
  pickFiles(): Promise<string[]>;
  fontFamilies?(): string[];
  saveTextFile?(name: string, contents: string): Promise<boolean>;
  openTextFile?(extensions: string[]): Promise<string | null>;
  readDocument(name: string): string | null;
  writeDocument(name: string, contents: string): void;
  saveDocument(name: string, contents: string): Promise<void>;
  removeDocument(name: string): void;
  openWindow(id: string, options: OpenWindowOptions): Promise<void>;
  closeWindow(id: string): Promise<void>;
  focusWindow(id: string): Promise<void>;
  setTrafficLightsCenter(id: string, center: [number, number] | null): Promise<void>;
  setTrafficLightsMode(id: string, mode: TrafficLightsMode, color: string | null): Promise<void>;
  dragPreviewBegin?(windowId: string, chip: Rect4, grab: [number, number]): Promise<void>;
  dragPreviewPage?(base64: string, frame: Rect4): Promise<void>;
  dragPreviewUpdate?(shape: DragPreviewShape, point: [number, number]): Promise<void>;
  dragPreviewCancel?(): Promise<void>;
  raiseView?(tag: number, levels: number, raised: boolean): Promise<void>;
  dragPreviewPlaceholder?(title: string, favicon: string | null): Promise<void>;
  windowFrame?(id: string): Promise<Rect4 | null>;
  dragPreviewEnd?(windowId: string | null, frame: Rect4 | null): Promise<void>;
  setWindowTitle(id: string, title: string): Promise<void>;
  windowIds(): Promise<string[]>;
  minimizeWindow?(id: string): Promise<void>;
  toggleMaximizeWindow?(id: string): Promise<void>;
  windowState?(id: string): Promise<WindowState>;
  windowButtonLayout?(): WindowButtonLayout;
  setWindowCaption?(id: string, caption: WindowCaption): Promise<void>;
  setAppearance(mode: "auto" | "light" | "dark"): Promise<void>;
  isDarkAppearance(): Promise<boolean>;
  setMenuState(state: Omit<MenuState, MenuBookmarkKey>): Promise<void>;
  setKeyShortcuts?(shortcuts: KeyShortcut[]): Promise<void>;
  focusSidebarRow?(windowId: string, tag: number): Promise<void>;
  setSidebarKeyboard?(windowId: string, active: boolean): Promise<void>;
  setSidebarMoveUndo?(windowId: string, available: boolean, focus: boolean): Promise<void>;
  setMenuBookmarks(bookmarks: Pick<MenuState, MenuBookmarkKey>): Promise<void>;
  replyToTerminate(ok: boolean): Promise<void>;
  confirm(options: ConfirmOptions): Promise<{ confirmed: boolean; suppressed: boolean }>;
  prompt(options: PromptOptions): Promise<string | null>;
}>("BayShell");

export const readDocument = (name: string) => nativeSnapshot("BayShell", "readDocument", [name], () => Shell.readDocument(name));
/** The caption buttons the app draws (capabilities.captionButtons), in Windows' order. Linux hosts still publish the
 *  desktop's button layout (snapshots.BayShell.windowButtonLayout), but Bay's Linux windows show no buttons. */
export const windowButtonLayout = (): WindowButtonLayout => ({ left: [], right: capabilities.captionButtons ? ["minimize", "maximize", "close"] : [] });
export const writeDocument = (name: string, contents: string) => nativeDocumentWrite(name, contents, () => Shell.writeDocument(name, contents));
/** Resolves once the document is on disk (writeDocument returns before), rejects if it can't be written. */
export const saveDocument = (name: string, contents: string) => nativeDocumentSave(name, contents, () => Shell.saveDocument(name, contents));
export const removeDocument = (name: string) => nativeDocumentWrite(name, null, () => Shell.removeDocument(name));

export const focusSidebarRow = (windowId: string, tag: number) => Shell.focusSidebarRow?.(windowId, tag) ?? Promise.resolve();

export const setSidebarKeyboard = (windowId: string, active: boolean) => Shell.setSidebarKeyboard?.(windowId, active) ?? Promise.resolve();

/** Claims sidebar focus only after a move; ordinary text/page focus retains its own Undo. */
export const setSidebarMoveUndo = (windowId: string, available: boolean, focus = false) =>
  Shell.setSidebarMoveUndo?.(windowId, available, focus) ?? Promise.resolve();

export const startDictation = () => Shell.startDictation();
export const setSwitcherCapture = (active: boolean) => void Shell.setSwitcherCapture(active);
export const pickFiles = () => Shell.pickFiles();
export const fontFamilies = (): string[] => Shell.fontFamilies?.() ?? [];
export const saveTextFile = (name: string, contents: string) => Shell.saveTextFile?.(name, contents) ?? Promise.resolve(false);
export const openTextFile = (extensions: string[] = []) => Shell.openTextFile?.(extensions) ?? Promise.resolve(null);

export function copyText(text: string) {
  Shell.copyText(text);
}

/** An image (base64 PNG or JPEG) on the clipboard; false if it isn't one. */
export async function copyImage(base64: string): Promise<boolean> {
  return await Shell.copyImage(base64);
}

// macOS draws key and modifiers itself; the web hosts show the label Bay's keyboard tables would.
const withShortcutLabels = (items: MenuItem[]): MenuItem[] =>
  items.map((item) => {
    if ("separator" in item) return item;
    const labeled = { ...item };
    if (item.children) labeled.children = withShortcutLabels(item.children);
    if (item.key) labeled.shortcut = formatShortcut(menuShortcutStroke(item.key, item.modifiers), platformOS);
    return labeled;
  });

export function showMenu(items: MenuItem[]): Promise<string | null> {
  return Shell.showMenu(isMac ? items : withShortcutLabels(items));
}

export const openWindow = (id: string, options: OpenWindowOptions = {}) => Shell.openWindow(id, options);

export type WindowProfileProps = ViewProps & {
  profile: string;
  neighbours: string[];
};
export const WindowProfile = requireNativeViewManager<WindowProfileProps>("BayWindowProfile");

export const closeWindow = (id: string) => Shell.closeWindow(id);
export const focusWindow = (id: string) => Shell.focusWindow(id);
export const setWindowTitle = (id: string, title: string) => Shell.setWindowTitle(id, title);
export const setTrafficLightsCenter = (id: string, center: [number, number] | null) =>
  capabilities.trafficLights ? Shell.setTrafficLightsCenter(id, center) : Promise.resolve();
/**
 * The window buttons: "shown"; "hover", only while the pointer is over the window's top (Zen's, with the page under
 * them); "hidden" (Arc's with the sidebar closed, shown with its peek).
 */
export type TrafficLightsMode = "shown" | "hover" | "hidden";
export const setTrafficLightsMode = (id: string, mode: TrafficLightsMode, color?: string) =>
  capabilities.trafficLights ? Shell.setTrafficLightsMode(id, mode, color ?? null) : Promise.resolve();
type Rect4 = [number, number, number, number];
export type DragPreviewShape = "hidden" | "pill" | "card";
// The dragged tab's picture under the pointer, a native panel that floats over everything (Windows.swift ›
// DragPreview). Rects and points are in the source window from its top-left; `end`'s frame (the new window's, as
// asked for) is on screen, in AppKit's coordinates. Optional: builds from before it have no picture, nothing else
// changes.
export const dragPreview = {
  begin: (windowId: string, chip: Rect4, grab: [number, number]) => void Shell.dragPreviewBegin?.(windowId, chip, grab),
  page: (base64: string, frame: Rect4) => void Shell.dragPreviewPage?.(base64, frame),
  update: (shape: DragPreviewShape, point: [number, number]) => void Shell.dragPreviewUpdate?.(shape, point),
  /** `windowId`: the new window the tab went to; the picture grows into it. */
  end: (windowId: string | null = null, frame: Rect4 | null = null) => void Shell.dragPreviewEnd?.(windowId, frame),
  cancel: () => void Shell.dragPreviewCancel?.(),
  /** A tab with no picture: its icon (a data: or file: URL) and title where its page would be. */
  placeholder: (title: string, favicon: string | null) => void Shell.dragPreviewPlaceholder?.(title, favicon),
};
/** Draws the view with React tag `tag` (and `levels` of its ancestors) over its siblings, or back in React's order:
 * React Native macOS's zIndex doesn't reorder them. A no-op on builds without it. */
export const raiseView = (tag: number | null, levels: number, raised: boolean) => {
  if (tag != null) void Shell.raiseView?.(tag, levels, raised);
};
/** The window's frame now, on screen (AppKit's coordinates); null without global screen coordinates. */
export const windowFrame = (id: string): Promise<Rect4 | null> => Shell.windowFrame?.(id) ?? Promise.resolve(null);
export const windowIds = () => Shell.windowIds();

/** A key the window's host runs as an app command (onCommand) rather than Chrome's: `keyCode` is the key's virtual-key
 *  code, as Chromium's key events carry it. */
export type KeyShortcut = { command: BrowserCommand; arg: string | null; keyCode: number; ctrl: boolean; shift: boolean; alt: boolean };
/** Hands the host the window's key shortcuts (hosts whose menus don't carry them: the Chrome-hosted desktop). */
export const setKeyShortcuts = (shortcuts: KeyShortcut[]) => Shell.setKeyShortcuts?.(shortcuts) ?? Promise.resolve();

// The window's own caption buttons (capabilities.captionButtons): no-ops on hosts whose system draws them.
export const minimizeWindow = (id: string) => Shell.minimizeWindow?.(id) ?? Promise.resolve();
export const toggleMaximizeWindow = (id: string) => Shell.toggleMaximizeWindow?.(id) ?? Promise.resolve();
export const windowState = (id: string): Promise<WindowState> => Shell.windowState?.(id) ?? Promise.resolve({ maximized: false, fullscreen: false });
export const setWindowCaption = (id: string, caption: WindowCaption) => Shell.setWindowCaption?.(id, caption) ?? Promise.resolve();

export const setAppearance = (mode: "auto" | "light" | "dark") => Shell.setAppearance(mode);
export const isDarkAppearance = () => Shell.isDarkAppearance();

type MenuBookmarkKey = "bookmarkFolders" | "recentBookmarks" | "bookmarksBar" | "otherBookmarks";
/**
 * Sends the menu state with the bookmark lists only when `bookmarksChanged`, so the native menus rebuild (and the
 * bridge carries) thousands of bookmarks only when they change.
 */
export function setMenuStateParts(state: MenuState, bookmarksChanged: boolean) {
  const { bookmarkFolders, recentBookmarks, bookmarksBar, otherBookmarks, ...rest } = state;
  if (bookmarksChanged) void Shell.setMenuBookmarks({ bookmarkFolders, recentBookmarks, bookmarksBar, otherBookmarks });
  return Shell.setMenuState(rest);
}
export const replyToTerminate = (ok: boolean) => Shell.replyToTerminate(ok);

export type ConfirmResult = { confirmed: boolean; suppressed: boolean };
/** The app's own dialog for a confirm or a prompt, or null to leave it to the system's. */
export type DialogPresenter = {
  confirm(options: ConfirmOptions): Promise<ConfirmResult> | null;
  prompt(options: PromptOptions): Promise<string | null> | null;
};
let dialogPresenter: DialogPresenter | null = null;
/** The app's in-window dialogs take the system's place where it can show them. */
export const setDialogPresenter = (presenter: DialogPresenter | null) => {
  dialogPresenter = presenter;
};
export const confirm = (options: ConfirmOptions): Promise<ConfirmResult> => dialogPresenter?.confirm(options) ?? Shell.confirm(options);
export const prompt = (options: PromptOptions): Promise<string | null> => dialogPresenter?.prompt(options) ?? Shell.prompt(options);

export const onCommand = (listener: (e: CommandEvent) => void) => Shell.addListener("onCommand", listener);
export const onWindowEvent = (listener: (e: WindowEvent) => void) => Shell.addListener("onWindowEvent", listener);
export const onAppEvent = (listener: (e: AppEvent) => void) => Shell.addListener("onAppEvent", listener);
export const onOpenURLs = (listener: (urls: string[], sourceApp?: string) => void) =>
  Shell.addListener("onOpenURLs", ({ urls, sourceApp }) => listener(urls, sourceApp));

export const WindowDragRegion = requireNativeViewManager<ViewProps>("BayShell");

export type SymbolProps = ViewProps & {
  name: string;
  size?: number;
  weight?: "light" | "regular" | "medium" | "semibold" | "bold";
  color?: string;
  /** "hierarchical": `color`, the symbol's secondary layers lighter. "multicolor": its own colours where it has them. */
  rendering?: "monochrome" | "hierarchical" | "multicolor";
};

export const Symbol = requireNativeViewManager<SymbolProps>("BaySymbol");

export type FadeLabelProps = ViewProps & {
  text: string;
  fontSize?: number;
  weight?: "light" | "regular" | "medium" | "semibold" | "bold";
  color?: string;
  fadeWidth?: number;
};

export const FadeLabel = requireNativeViewManager<FadeLabelProps>("BayFadeLabel");

export const ActivitySpinner = requireNativeViewManager<ViewProps>("BayActivitySpinner");

export type ContextMenuAreaProps = ViewProps & {
  onContextMenu?: () => void;
  captureDescendants?: boolean;
};

const NativeContextMenuArea = requireNativeViewManager<Omit<ContextMenuAreaProps, "onContextMenu"> & { onContextMenu?: () => void }>("BayContextMenuArea");

export function ContextMenuArea(props: ContextMenuAreaProps) {
  return <NativeContextMenuArea {...props} />;
}

export type SurfaceProps = ViewProps & {
  fill?: string;
  cornerRadius?: number;
  borderColor?: string;
  borderWidth?: number;
  borderColors?: string[];
  shadowColor?: string;
  shadowOpacity?: number;
  shadowRadius?: number;
  shadowOffset?: [number, number];
};

type NativeSurfaceProps = Omit<SurfaceProps, "shadowColor" | "shadowOpacity" | "shadowRadius" | "shadowOffset"> & {
  surfaceShadowColor?: string;
  surfaceShadowOpacity?: number;
  surfaceShadowRadius?: number;
  surfaceShadowOffset?: [number, number];
};

const NativeSurface = requireNativeViewManager<NativeSurfaceProps>("BaySurface");

export function Surface({ shadowColor, shadowOpacity, shadowRadius, shadowOffset, ...props }: SurfaceProps) {
  return (
    <NativeSurface
      {...props}
      surfaceShadowColor={shadowColor}
      surfaceShadowOpacity={shadowOpacity}
      surfaceShadowRadius={shadowRadius}
      surfaceShadowOffset={shadowOffset}
    />
  );
}

export type VisualEffectProps = ViewProps & {
  material?: string;
  blendingMode?: "withinWindow" | "behindWindow";
  cornerRadius?: number;
};

export const VisualEffect = requireNativeViewManager<VisualEffectProps>("BayVisualEffect");

export type GlassEffectProps = ViewProps & {
  cornerRadius?: number;
  tint?: string;
  glassStyle?: "regular" | "clear";
  dark?: boolean;
};

const GlassEffectModule = requireOptionalNativeModule<{ isLiquidGlass(): boolean }>("BayGlassEffect");

export const isLiquidGlass = (): boolean => GlassEffectModule?.isLiquidGlass() ?? false;

export const GlassEffect = requireNativeViewManager<GlassEffectProps>("BayGlassEffect");

export type IconTheme = { kind: "blur" } | { kind: "template"; fill: string; stroke?: string };

const DockSelectionModule = requireOptionalNativeModule<{
  iconTheme(uri: string | null, emoji: string | null): Promise<IconTheme | null>;
}>("BayDockSelection");

export const iconTheme = (source: { uri: string } | { emoji: string }): Promise<IconTheme | null> =>
  DockSelectionModule?.iconTheme("uri" in source ? source.uri : null, "emoji" in source ? source.emoji : null) ?? Promise.resolve(null);

export type DockSelectionProps = ViewProps & {
  image?: string;
  emoji?: string;
  theme?: IconTheme["kind"];
  fill?: string;
  stroke?: string;
  cornerRadius?: number;
  strokeWidth?: number;
  iconSize?: number;
  dark: boolean;
  glass?: boolean;
};

export const DockSelection = requireNativeViewManager<DockSelectionProps>("BayDockSelection");

const InlineCompletionModule = requireOptionalNativeModule<{
  complete(tag: number, typed: string, completion: string): Promise<InlineWrite>;
}>("BayInlineCompletion");

export type InlineWrite = 0 | 1 | 2;

export const completeInline = (tag: number, typed: string, completion: string) =>
  InlineCompletionModule?.complete(tag, typed, completion) ?? Promise.resolve(0 as InlineWrite);

type TranslationModule = {
  readonly available: boolean;
  userLanguages(): string[];
  languageName(identifier: string): string;
  detect(text: string): Promise<string | null>;
  status(source: string, target: string): Promise<"installed" | "supported" | "unsupported">;
  supportedLanguages(): Promise<string[]>;
  prepare(source: string, target: string): Promise<void>;
  translate(source: string, target: string, texts: string[]): Promise<string[]>;
  translateBlocks(source: string, target: string, blocks: string[][]): Promise<(string[] | null)[]>;
};
const TranslationNative = requireOptionalNativeModule<TranslationModule>("BayTranslate");

// Null before macOS 26, which has no translation API for apps.
export const translation: Omit<TranslationModule, "available"> | null = TranslationNative?.available ? TranslationNative : null;

type TidyNamesModule = {
  readonly available: boolean;
  suggest(filename: string, pageTitle: string, pageUrl: string, candidate: string): Promise<string | null>;
};
const TidyNamesNative = requireOptionalNativeModule<TidyNamesModule>("BayTidyNames");

// Null unless launched with BAY_TIDY_DOWNLOADS_AI=true on a Mac with Apple Intelligence; Tidy Downloads then leans on
// the local cleaner alone.
export const tidyNames: Omit<TidyNamesModule, "available"> | null =
  TidyNamesNative && nativeSnapshot("BayTidyNames", "available", [], () => TidyNamesNative.available) ? TidyNamesNative : null;
