export type Frame = [number, number, number, number];
export type WindowSize = [number, number];
export type WindowPlacement = { size?: WindowSize; maximized?: boolean };

// Only bookmark-style metadata belongs in JS. Security-scoped grants live in the native shell on this Mac.
export type LocalFilePin = {
  id: string;
  spaceId: string;
  path: string;
  name: string;
  kind: "file" | "folder";
  createdAt: number;
  order: number;
  expanded: boolean;
};

export type SpaceColor = "plum" | "blue" | "purple" | "pink" | "red" | "orange" | "yellow" | "green" | "neutral";

// A space's own theme, from the theme editor: its colours (one to three, a gradient), how strongly they tint the
// window (0–1) and its grain (0–1). Without one, a space takes its preset colour's.
export type SpaceTheme = { colors: string[]; intensity: number; grain: number };

export type Space = {
  id: string;
  name: string;
  color: SpaceColor;
  icon: string | null;
  createdAt: number;
  // An existing native directory alias: another space's, when it shares that space's sign-ins.
  profileId?: string;
  // Created to share another space's sign-ins (its native profile: logins, cookies, passwords, history, extensions),
  // so loading keeps it there. Older spaces that shared one without choosing to are split apart (isolateSavedSpaces).
  sharesSignIns?: boolean;
  theme?: SpaceTheme | null;
  // Whether a page's colour tints the window: by default only a space without a theme of its own takes it.
  followSite?: boolean;
  // How long its tabs stay unused before they're cleaned up (Arc's archive, per profile there): hours, never (null),
  // or the app's setting (unset).
  cleanUpAfterHours?: number | null;
  // Hide this space's pinned rows, folders and groups while leaving today's tabs visible.
  folded?: boolean;
};

// A window shows one space at a time; its tabs are the space's (store/model.ts tab lists), as Arc's: every window
// showing the space lists them, and a tab's page is in the window that last showed it (`Tab.windowId`).
export type BrowserWindow = {
  id: string;
  spaceId: string;
  incognito: boolean;
  activeTabIds: Record<string, string>;
  sidebarOpen: boolean;
  tabLayout?: "sidebar" | "top";
  frame: Frame | null;
  // Restored geometry on hosts where the compositor owns global placement.
  size?: WindowSize;
  maximized?: boolean;
  createdAt: number;
  // Little Bay (Arc's Little Arc): one page, no sidebar, never saved with the session (store/small.ts).
  kind?: "small";
};

export type Tab = {
  newTabHistory?: { url: string; title: string; favicon: string | null };
  id: string;
  // The window its page is in (the one that last showed it); "" when none has since it was made or its window
  // closed. A Little Bay page is its window's alone.
  windowId: string;
  spaceId: string;
  url: string;
  title: string;
  favicon: string | null;
  pinned: boolean;
  // In the space's Pinned section (Arc's and Zen's pinned tabs): a full row below the Essentials (the pinned tiles),
  // loose or in one of its folders (`folderId`). It stays when tabs are cleaned up, and closing it only unloads it.
  pinnedRow?: boolean;
  folderId?: string;
  // Kept (the tab menu's Keep Tab): as a pin does, it stays when tabs are cleaned up and awake when idle ones sleep.
  kept?: boolean;
  muted: boolean;
  zoom: number;
  customTitle: string | null;
  customIcon: string | null;
  pinnedUrl: string | null;
  navigation: { url: string; seq: number; userInitiated?: boolean } | null;
  adoptId?: string;
  openerId: string | null;
  // What a tab that hasn't loaded adopts when first shown (store/model.ts wake): a reopened window's tab
  // "restore:<closed tab>" (its back/forward list, from Chrome's TabRestoreService).
  wakeAdoptId?: string;
  liveItem?: { folderId: string; itemId: string };
  // A peek's page (store/peeks.ts): shown over this tab, its opener, and in no list until it's kept.
  peekOf?: string;
  unloaded?: boolean;
  createdAt: number;
  lastActiveAt: number;
};

export type TabLive = {
  isLoading: boolean;
  progress: number;
  canGoBack: boolean;
  canGoForward: boolean;
  playingAudio: boolean;
  themeColor: string | null;
};

export type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export type TabGroup = {
  id: string;
  spaceId: string;
  name: string;
  icon: string | null;
  color: GroupColor | null;
  collapsed: boolean;
  pinned: boolean;
  tabIds: string[];
  createdAt: number;
  autoUngroup?: boolean;
  // The pinned tab whose links, opened behind, this group collects (Dia: they gather below the pinned tabs).
  pinnedOpenerId?: string;
};

// A folder of the Pinned section (Arc's and Zen's): it holds pinned rows, and stays when it's emptied. Its members
// are its space's tabs with its id, in their list's order.
export type PinnedFolder = {
  id: string;
  // Absent on root folders and older flat sessions.
  parentId?: string;
  // Empty folders can retain a position before a sibling folder or row. Missing anchors append.
  beforeId?: string;
  spaceId: string;
  name: string;
  icon: string | null;
  collapsed: boolean;
  createdAt: number;
};

export type SplitView = {
  id: string;
  tabIds: string[];
  orientation: "horizontal" | "vertical";
  sizes: number[];
  stack?: { index: number; sizes: [number, number] };
};

export type HistoryEntry = {
  url: string;
  title: string;
  favicon: string | null;
  visits: number;
  lastVisit: number;
  visitTimes?: number[];
};

// `id` is Chrome's UUID for the node (BookmarkModel). `syncKey` is its sync record's key when that isn't the id: a
// bookmark synced before Chrome kept bookmarks keeps the key its old id gave it (sync/adapters.ts).
export type BookmarkNode =
  | { kind: "url"; id: string; parentId: string; title: string; url: string; favicon: string | null; addedAt: number; syncKey?: string }
  | { kind: "folder"; id: string; parentId: string | null; title: string; children: string[]; addedAt: number; syncKey?: string };

export type BookmarkFolder = Extract<BookmarkNode, { kind: "folder" }>;

export type Bookmarks = {
  nodes: Record<string, BookmarkNode>;
  roots: Record<string, { bar: string; other: string }>;
};

export type TabSnapshot = Pick<Tab, "url" | "title" | "favicon" | "pinned" | "muted" | "zoom" | "customTitle" | "customIcon" | "spaceId"> &
  Partial<Pick<Tab, "pinnedUrl" | "pinnedRow">>;

export type ClosedTab = {
  kind: "tab";
  id: string;
  tab: TabSnapshot;
  tabId?: string;
  windowId: string;
  index: number;
  group: Pick<TabGroup, "id" | "name" | "icon" | "color"> | null;
  closedAt: number;
  pinnedTile?: boolean;
  small?: boolean;
};

// A closed window: its tabs stay their space's, so reopening it is the window (where it was, on its space). A launch
// that doesn't restore the last session (settings.restoreSession) keeps the tabs it closed here too.
export type ClosedWindow = {
  kind: "window";
  id: string;
  // `shownTabId`: the tab it showed, which it shows again when it comes back (if nothing else shows it by then).
  window: Pick<BrowserWindow, "spaceId" | "sidebarOpen" | "frame" | "size" | "maximized"> & { shownTabId?: string };
  tabs: (TabSnapshot & { active: boolean; tabId?: string })[];
  groups: (Omit<TabGroup, "tabIds"> & { tabIndexes: number[] })[];
  closedAt: number;
};

export type ClosedGroup = {
  kind: "group";
  id: string;
  group: Pick<TabGroup, "id" | "name" | "icon" | "color" | "pinned">;
  tabs: TabSnapshot[];
  windowId: string;
  index: number;
  closedAt: number;
};

export type FindState = {
  open: boolean;
  query: string;
  count: number | null;
  active: number;
  focusRequest?: number;
  replace?: boolean;
};

export type PanelState = {
  open: boolean;
  initialText: string;
  mode?: "newTab" | "navigate";
  sessionId?: string;
  groupId?: string;
};

export type WindowUi = { panel: PanelState; downloadsOpen: boolean };
