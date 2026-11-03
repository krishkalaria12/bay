// The actions Settings › Shortcuts lists on the Chrome-hosted desktop, which has no menu bar to read them from. They
// are macOS's menu (Menus.swift), by the same ids, so a choice means the same thing on every platform.

export type ShortcutAction = { id: string; title: string; path: string[] };

const group = (path: string[], items: [title: string, id: string][]): ShortcutAction[] => items.map(([title, id]) => ({ id, title, path }));

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  ...group(
    ["Bay"],
    [
      ["Settings…", "openSettings"],
      ["Import from Another Browser…", "importBrowserData"],
    ],
  ),
  ...group(
    ["File"],
    [
      ["New Tab", "newTab"],
      ["New Tab in Group", "newTabInGroup"],
      ["New Window", "newWindow"],
      ["New Incognito Window", "newIncognitoWindow"],
      ["New Little Bay Window", "newLittleBay"],
      ["Open Links from Other Apps in Main Window", "toggleOpenLinksInLittleBay"],
      ["Reopen Closed Tab", "reopenClosedTab"],
      ["Reopen Closed Window", "reopenClosedWindow"],
      ["Open File…", "openFile"],
      ["Join Meeting", "joinMeeting"],
      ["Open Command Bar", "focusCommandBar"],
      ["Close Tab", "closeTab"],
      ["Close Other Tabs", "closeOtherTabs"],
      ["Close All Tabs", "closeAllTabs"],
      ["Clean Up Tabs", "cleanUpTabs"],
      ["Save Page As…", "savePage"],
      ["New Easel", "newEasel"],
      ["Open Library", "openLibrary"],
      ["Capture", "capture"],
      ["Capture Full Page", "captureFullPage"],
      ["Capture in Portrait", "capturePortrait"],
      ["Boost This Site", "newBoost"],
      ["Zap Elements", "zapElements"],
      ["Share…", "share"],
      ["Email Page Location", "emailPageLocation"],
      ["Print…", "print"],
      ["Print Using System Dialog…", "printWithSystemDialog"],
    ],
  ),
  ...group(
    ["Edit"],
    [
      ["Copy URL", "copyUrl"],
      ["Copy URL as Markdown", "copyUrlAsMarkdown"],
    ],
  ),
  ...group(
    ["Edit", "Find"],
    [
      ["Find…", "findInPage"],
      ["Find and Replace…", "findAndReplace"],
      ["Find Next", "findNext"],
      ["Find Previous", "findPrevious"],
      ["Use Selection for Find", "useSelectionForFind"],
      ["Jump to Selection", "jumpToSelection"],
    ],
  ),
  ...group(
    ["Edit", "AutoFill"],
    [
      ["Contact…", "autofill:contact"],
      ["Passwords…", "autofill:passwords"],
      ["Credit Card…", "autofill:creditCard"],
    ],
  ),
  ...group(
    ["View", "Appearance"],
    [
      ["Automatic", "setAppearance:auto"],
      ["Light", "setAppearance:light"],
      ["Dark", "setAppearance:dark"],
    ],
  ),
  ...group(
    ["View"],
    [
      ["Stop", "stop"],
      ["Refresh", "reload"],
      ["Force Refresh the Page", "forceReload"],
      ["Show Tabs in Sidebar", "toggleTabLayout"],
      ["Auto-Hide Tabs", "toggleSidebar"],
      ["Focus Sidebar", "focusSidebar"],
      ["Open Split Pane", "openSplitPane"],
      ["Focus Next Split Pane", "focusNextPane"],
      ["Focus Previous Split Pane", "focusPreviousPane"],
      ["Remove Pane from Split", "removeFromSplit"],
      ["Toggle Bookmarks Bar", "toggleBookmarksBar"],
      ["Show Full URL", "toggleFullUrl"],
      ["Show Address Bar in Sidebar", "toggleAddressBar"],
      ["Show Sidebar on Right", "toggleSidebarPosition"],
      ["Cast…", "cast"],
      ["Zoom to Actual Size", "zoomReset"],
      ["Zoom In", "zoomIn"],
      ["Zoom Out", "zoomOut"],
    ],
  ),
  ...group(
    ["View", "Show Bookmarks Bar"],
    [
      ["Always", "setBookmarksBar:always"],
      ["On New Tab Only", "setBookmarksBar:newTab"],
      ["Never", "setBookmarksBar:never"],
    ],
  ),
  ...group(
    ["View", "Developer"],
    [
      ["View Source", "viewSource"],
      ["Developer Tools", "devTools"],
      ["Inspect Elements", "inspectElements"],
      ["JavaScript Console", "javaScriptConsole"],
    ],
  ),
  ...group(
    ["Tabs"],
    [
      ["Go Back", "back"],
      ["Go Forward", "forward"],
      ["Next Tab", "nextTab"],
      ["Previous Tab", "previousTab"],
      ["Search Tabs…", "searchTabs"],
      ["Pin Tab", "togglePinRow"],
      ["Add to Essentials", "togglePin"],
      ["Keep Tab", "keepTab"],
      ["Duplicate", "duplicateTab"],
      ["New Group with Tab", "newGroupWithTabs"],
      ["Rename…", "renameTab"],
      ["Change Icon…", "changeTabIcon"],
      ["Mute Site", "toggleMute"],
    ],
  ),
  ...group(
    ["Bookmarks"],
    [
      ["Bookmark This Page", "bookmarkPage"],
      ["Bookmark All Tabs…", "bookmarkAllTabs"],
      ["Manage Bookmarks", "manageBookmarks"],
    ],
  ),
  // Reached from pages in macOS's menus; here they have a key of their own.
  ...group(
    ["History"],
    [
      ["Show All History", "showHistory"],
      ["Clear Browsing Data…", "clearBrowsingData"],
    ],
  ),
  ...group(
    ["Window"],
    [
      ["Downloads", "downloads"],
      ["Merge All Windows", "mergeAllWindows"],
    ],
  ),
  ...group(["Help"], [["Keyboard Shortcuts", "keyboardShortcuts"]]),
];
