import { tab } from "./lib.mjs";

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

export const scenes = { hero, spaces: spacesScene };
