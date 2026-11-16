import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tab, wiki } from "./lib.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const look = (...colors) => ({ colors, intensity: 0.75, grain: 0.3 });
const twilight = look("#7F5AF0", "#E84393");
const midnight = look("#1E2A78", "#6A2C91");
const aurora = look("#16F2B3", "#0DB4F7");

const spaces = [
  { id: "default", name: "Studio", color: "purple", icon: "🎨", theme: twilight },
  { id: "home", name: "Home", color: "orange", icon: "🏠", theme: midnight },
  { id: "trip", name: "Lisbon", color: "green", icon: "✈️", theme: aurora },
];

// Favorites belong to a space, so each scene's space brings its own.
const favorites = (spaceId, keys) => keys.map((key) => tab(key, { spaceId, pinned: true }));

const studio = () => [
  tab("github", { pinnedRow: true, folderId: "launch" }),
  tab("notion", { title: "Launch checklist", pinnedRow: true, folderId: "launch" }),
  tab("figma", { title: "Sidebar, final", pinnedRow: true, folderId: "launch" }),
  tab("hn", { pinnedRow: true }),
  tab("arena", { pinnedRow: true }),
];

const launchFolder = { id: "launch", spaceId: "default", name: "Launch", icon: null, collapsed: false, createdAt: 1 };

const hero = {
  session: {
    settings: { appearance: "light" },
    spaces,
    windows: [{ id: "w1", spaceId: "default", frame: [60, 60, 1440, 900], activeTabIds: { default: "active" } }],
    tabs: [
      ...favorites("default", ["github", "figma", "linear", "notion", "youtube", "wikipedia"]),
      ...studio(),
      tab("bay", { id: "active" }),
      tab("wikipedia", { title: "Golden Gate Bridge – Wikipedia", url: "https://en.wikipedia.org/wiki/Golden_Gate_Bridge" }),
      tab("nytimes"),
      tab("airbnb", { title: "Stays in Lisbon – Airbnb" }),
    ],
    pinnedFolders: [launchFolder],
  },
  shots: [{ file: "bay-browser-for-mac", settle: 12000, publish: true }],
};

// Each space's sidebar, cropped out of its window at Retina size.
const sidebar = { left: 0, top: 0, width: 456, height: 1400 };

const inSpace = (id, appearance) =>
  `const s = nn.store.getState(); s.updateSettings({ appearance: "${appearance}" }); nn.actions.switchSpace(s.windowOrder[0], "${id}");`;

const spacesScene = {
  session: {
    settings: { appearance: "light" },
    spaces,
    windows: [{ id: "w1", spaceId: "default", frame: [60, 60, 1100, 700], activeTabIds: { default: "s1", home: "h1", trip: "l1" } }],
    tabs: [
      ...favorites("default", ["github", "figma", "linear", "notion", "youtube", "slack"]),
      ...studio(),
      tab("wikipedia", { id: "s1", title: "Web browser - Wikipedia", url: "https://en.wikipedia.org/wiki/Web_browser" }),
      tab("vercel", { title: "Deployments – Vercel" }),
      ...favorites("home", ["spotify", "youtube", "reddit"]),
      tab("notion", { spaceId: "home", title: "Home renovation", pinnedRow: true }),
      tab("airbnb", { spaceId: "home", title: "Weekend away", pinnedRow: true }),
      tab("wikipedia", { spaceId: "home", id: "h1", title: "Sourdough - Wikipedia", url: "https://en.wikipedia.org/wiki/Sourdough" }),
      tab("nytimes", { spaceId: "home", title: "Cooking – NYT" }),
      tab("reddit", { spaceId: "home", title: "r/houseplants" }),
      ...favorites("trip", ["gmail", "calendar", "airbnb"]),
      tab("notion", { spaceId: "trip", title: "Packing list", pinnedRow: true, folderId: "plans" }),
      tab("gmail", { spaceId: "trip", title: "Flight confirmation", pinnedRow: true, folderId: "plans" }),
      tab("calendar", { spaceId: "trip", title: "Trip calendar", pinnedRow: true, folderId: "plans" }),
      tab("wikipedia", { spaceId: "trip", id: "l1", title: "Lisbon - Wikipedia", url: "https://en.wikipedia.org/wiki/Lisbon" }),
      tab("airbnb", { spaceId: "trip", title: "Stays in Alfama – Airbnb" }),
      tab("nytimes", { spaceId: "trip", title: "36 Hours in Lisbon" }),
    ],
    pinnedFolders: [launchFolder, { id: "plans", spaceId: "trip", name: "Plans", icon: null, collapsed: false, createdAt: 2 }],
  },
  shots: [
    { file: "bay-spaces-studio", crop: sidebar, settle: 9000 },
    { file: "bay-spaces-home", crop: sidebar, before: inSpace("home", "dark"), settle: 7000 },
    { file: "bay-spaces-lisbon", crop: sidebar, before: inSpace("trip", "light"), settle: 7000 },
  ],
};

// The feature shots: one window each, staged with made-up tabs on public pages, then put in the state the section
// shows (a Peek open, two tabs split, the command bar mid-search) before it's photographed.
const featureWindow = (tabs, extra = {}) => ({
  settings: { appearance: "light" },
  spaces: [spaces[0]],
  windows: [{ id: "w1", spaceId: "default", frame: [60, 60, 1280, 800], activeTabIds: { default: "active" } }],
  tabs: [...favorites("default", ["github", "figma", "linear", "notion", "slack", "youtube"]), ...tabs],
  ...extra,
});

const folders = {
  session: featureWindow(
    [
      tab("github", { title: "Pull requests", pinnedRow: true, folderId: "launch" }),
      tab("notion", { title: "Launch checklist", pinnedRow: true, folderId: "launch" }),
      tab("figma", { title: "Sidebar, final", pinnedRow: true, folderId: "launch" }),
      wiki("Web_browser", { pinnedRow: true, folderId: "research" }),
      tab("arena", { title: "Sidebar ideas", pinnedRow: true, folderId: "reading" }),
      wiki("Tab_(interface)", { pinnedRow: true, folderId: "reading" }),
      tab("vercel", { title: "Deployments – Vercel", pinnedRow: true, folderId: "side" }),
      tab("stripe", { title: "Payments – Stripe", pinnedRow: true, folderId: "side" }),
      wiki("Information_architecture", { id: "active" }),
      tab("hn"),
      tab("nytimes"),
    ],
    {
      pinnedFolders: [
        { ...launchFolder },
        { id: "research", spaceId: "default", name: "Research", icon: null, collapsed: false, createdAt: 2 },
        { id: "reading", parentId: "research", spaceId: "default", name: "Reading", icon: null, collapsed: false, createdAt: 3 },
        { id: "side", spaceId: "default", name: "Side project", icon: null, collapsed: true, createdAt: 4 },
      ],
    },
  ),
  shots: [{ file: "bay-folders", settle: 10000 }],
};

const peek = {
  session: featureWindow([wiki("Golden_Gate_Bridge", { id: "active" }), tab("hn"), tab("airbnb", { title: "Stays in Sausalito – Airbnb" }), tab("nytimes")]),
  shots: [
    {
      file: "bay-peek",
      before: `nn.store.getState().openPeek("active", "https://en.wikipedia.org/wiki/Joseph_Strauss_(engineer)");`,
      settle: 10000,
    },
  ],
};

const split = {
  session: featureWindow([
    wiki("Lisbon", { id: "active" }),
    wiki("Alfama", { id: "beside" }),
    tab("airbnb", { title: "Stays in Alfama – Airbnb" }),
    tab("nytimes", { title: "36 Hours in Lisbon" }),
  ]),
  shots: [{ file: "bay-split-view", before: `nn.splits.openInSplit("beside");`, settle: 10000 }],
};

const privacy = {
  session: featureWindow([
    tab("recipes", { id: "active", title: "Best Chocolate Chip Cookies Recipe", url: "https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/" }),
    wiki("Web_browser"),
    tab("hn"),
  ]),
  // The site panel, as clicking the address opens it; the page has loaded by then, so its count is in.
  shots: [
    {
      file: "bay-privacy",
      before: `return new Promise((done) => setTimeout(() => done(nn.pageState.setState((s) => ({ popover: { ...s.popover, active: "siteControls" } }))), 15000));`,
      settle: 1200,
    },
  ],
};

const command = {
  session: featureWindow([wiki("Web_browser", { id: "active" }), wiki("Golden_Gate_Bridge"), tab("hn"), tab("nytimes")]),
  // ⌘T, then typing the name of a tab that's already open: it comes first, as a switch.
  shots: [
    {
      file: "bay-command-bar",
      before: `nn.runCommand({ command: "newTab", windowId: "w1" });
        return new Promise((done) => setTimeout(() => { const id = nn.omnibox.ids()[0]; nn.omnibox.get(id).type("golden gate br"); done(id); }, 1500));`,
      settle: 4000,
    },
  ],
};

const tidy = {
  session: {
    ...featureWindow([wiki("Web_browser", { id: "active" })]),
    spaces: [
      { ...spaces[0], name: "Work", cleanUpAfterHours: 12 },
      { ...spaces[1], cleanUpAfterHours: 168 },
      { ...spaces[2], cleanUpAfterHours: null },
    ],
  },
  // Settings › Spaces, where each space keeps its own time.
  shots: [{ file: "bay-clean-up", before: `nn.openSettings("spaces", "default");`, settle: 4000, pick: "smallest" }],
};

const importer = {
  session: featureWindow([wiki("Web_browser", { id: "active" })]),
  // The importer reads the repo's fixture profiles, not this Mac's.
  env: { BAY_IMPORT_SOURCE_DIR: resolve(repo, "packages/import/fixtures/home/Library/Application Support") },
  shots: [{ file: "bay-import", before: `nn.pages.openImport();`, settle: 15000, pick: "smallest" }],
};

export const scenes = { hero, spaces: spacesScene, folders, peek, split, privacy, command, tidy, import: importer };
