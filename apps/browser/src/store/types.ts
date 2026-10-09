
export type Frame = [number, number, number, number];

export type ProfileColor = "plum" | "blue" | "purple" | "pink" | "red" | "orange" | "yellow" | "green" | "neutral";

// A space's own theme, from the theme editor: its colours (one to three, a gradient), how strongly they tint the
// window (0–1) and its grain (0–1). Without one, a space takes its preset colour's.
export type SpaceTheme = { colors: string[]; intensity: number; grain: number };

export type Profile = {
  id: string;
  name: string;
  color: ProfileColor;
  icon: string | null;
  createdAt: number;
  dataId?: string;
  theme?: SpaceTheme | null;
  // How long its tabs stay unused before they're cleaned up (Arc's archive, per profile there): hours, never (null),
  // or the app's setting (unset).
  cleanUpAfterHours?: number | null;
};

export type BrowserWindow = {
  id: string;
  profileId: string;
  incognito: boolean;
  tabIds: string[];
  activeTabIds: Record<string, string>;
  sidebarOpen: boolean;
  tabLayout?: "sidebar" | "top";
  frame: Frame | null;
  createdAt: number;
  // Little Bay (Arc's Little Arc): one page, no sidebar, never saved with the session (store/small.ts).
  kind?: "small";
};

export type Tab = {
  id: string;
  windowId: string;
  profileId: string;
  url: string;
  title: string;
  favicon: string | null;
  pinned: boolean;
  // In the space's Pinned section (Arc's and Zen's pinned tabs): a full row below the Essentials (the pinned tiles),
  // loose or in one of its folders (`folderId`). It stays when tabs are cleaned up, and closing it only unloads it.
  pinnedRow?: boolean;
  folderId?: string;
  // A pinned page is every window's (store/mirroredPins.ts): each window's tab for it shares this key (else its id).
  pinKey?: string;
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
  windowId: string;
  profileId: string;
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
// are the window's tabs with its id, in the window's order.
export type PinnedFolder = {
  id: string;
  // Each window's folder for it shares this key (else its id), as pinned pages do.
  key?: string;
  windowId: string;
  profileId: string;
  name: string;
  icon: string | null;
  collapsed: boolean;
  createdAt: number;
};

export type SplitView = {
  id: string;
  windowId: string;
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

export type TabSnapshot = Pick<
  Tab,
  "url" | "title" | "favicon" | "pinned" | "muted" | "zoom" | "customTitle" | "customIcon" | "profileId"
> &
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

export type ClosedWindow = {
  kind: "window";
  id: string;
  window: Pick<BrowserWindow, "profileId" | "sidebarOpen" | "frame">;
  tabs: (TabSnapshot & { active: boolean; tabId?: string })[];
  groups: (Omit<TabGroup, "tabIds" | "windowId"> & { tabIndexes: number[] })[];
  closedAt: number;
};

export type ParkedPins = {
  tabs: (TabSnapshot & { id: string; groupId: string | null; folderId?: string })[];
  groups: Pick<TabGroup, "id" | "name" | "icon" | "color" | "collapsed">[];
  folders?: Pick<PinnedFolder, "id" | "name" | "icon" | "collapsed">[];
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
