// What the platform can do, as data. This is the one place the app asks "is this available?" —
// call sites never branch on the OS themselves. Pure: the caller passes the OS and a module probe,
// so this is testable under plain Node and the bound values live in os.ts.

import type { PlatformOS } from "./types";

export type Capabilities = {
  /** BayGlassEffect renders real Liquid Glass (macOS 26+). Elsewhere: the Surface fallback. */
  liquidGlass: boolean;
  /** BayVisualEffect (NSVisualEffectView vibrancy). Elsewhere: the Surface fallback. */
  vibrancy: boolean;
  /** The Metal shader views (BayAreaLight, BayEdgeLight, BayPowerUp, BayWindowBackdrop). */
  shaders: boolean;
  /** A window backdrop is available (macOS vibrancy/glass, Windows Mica/Acrylic). */
  windowBackdrop: boolean;
  /** Dock membership and app icon switching (BayApp). Windows: the taskbar instead. */
  dock: boolean;
  /** BayDockSelection, the Dock icon's themed preview. Windows: none. */
  dockSelection: boolean;
  /** A global menu bar the app maintains (macOS). Windows: the in-window app menu. */
  menuBar: boolean;
  /** The window's buttons are the app's own views (BayShell traffic lights). */
  trafficLights: boolean;
  /** The app draws the window's caption buttons (minimize, maximize, close) at its top right (Windows). */
  captionButtons: boolean;
  /** BaySwipe: trackpad two-finger back/forward, the app's own. Windows: Chrome's overscroll. */
  swipe: boolean;
  /** BayCalendar (EventKit). Windows: none yet. */
  calendar: boolean;
  /** BayTranslate. Windows: none. */
  translation: boolean;
  /** AppleScript (Automation, the dev script runner). Windows: none. */
  appleScript: boolean;
  /** Handoff to other Apple devices. Windows: none. */
  handoff: boolean;
  /** The intro music (AVFoundation). Windows: Media Foundation, later. */
  introMusic: boolean;
  /** User notifications (UserNotifications, or Windows App SDK notifications). */
  notifications: boolean;
  /** Secret storage: Keychain on macOS, Credential Manager/DPAPI on Windows. */
  keychain: boolean;
  /** BayInlineCompletion, inline text completion in fields. */
  inlineCompletion: boolean;
  /** BayWindowProfile, swapping the profile a window shows. */
  windowProfiles: boolean;
  /** View tooltips (the `tooltip` prop on the platform views). Windows: Phase 5. */
  tooltips: boolean;
  /** Pointer hover (onMouseEnter/onMouseLeave on the platform views). */
  hover: boolean;
  /** Keyboard focus rings the app draws (the `enableFocusRing` prop). */
  focusRing: boolean;
  /** The `keyDownEvents` prop, keys a view takes before the page sees them. Windows: Phase 5. */
  keyDownEvents: boolean;
  /** File drags out of the app (the `draggedTypes` prop). Windows: BayFileDrag (OLE), Phase 4. */
  nativeDrag: boolean;
  /** Dragging the window by its own views (the `mouseDownCanMoveWindow` prop). Windows: Phase 5. */
  windowMoveByView: boolean;
};

/**
 * The capability table. `hasModule` answers whether a named native module is built into this app
 * (the caller probes with requireOptionalNativeModule), so a build without one degrades instead of
 * crashing. On Windows most macOS-only entries are false by design: the plan's out-of-scope list.
 */
export function capabilitiesFor(os: PlatformOS, hasModule: (name: string) => boolean): Capabilities {
  const mac = os === "macos";
  const windows = os === "windows";
  const webDesktop = windows || os === "linux";
  return {
    liquidGlass: mac && hasModule("BayGlassEffect"),
    vibrancy: mac && hasModule("BayVisualEffect"),
    shaders: mac && hasModule("BayAreaLight") && hasModule("BayEdgeLight") && hasModule("BayPowerUp") && hasModule("BayWindowBackdrop"),
    windowBackdrop: mac || webDesktop,
    dock: mac && hasModule("BayApp"),
    dockSelection: mac && hasModule("BayDockSelection"),
    menuBar: mac,
    trafficLights: mac,
    captionButtons: windows,
    swipe: mac && hasModule("BaySwipe"),
    calendar: mac && hasModule("BayCalendar"),
    translation: mac && hasModule("BayTranslate"),
    appleScript: mac && hasModule("BayApp"),
    handoff: mac,
    introMusic: mac && hasModule("BayApp"),
    notifications: hasModule("BayApp") && (mac || hasModule("BayNotifications")),
    keychain: hasModule("BayKeychain"),
    inlineCompletion: mac && hasModule("BayInlineCompletion"),
    windowProfiles: mac && hasModule("BayWindowProfile"),
    tooltips: mac,
    hover: mac || webDesktop,
    focusRing: mac,
    keyDownEvents: mac,
    nativeDrag: mac,
    windowMoveByView: mac,
  };
}
