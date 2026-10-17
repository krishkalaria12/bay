import { session } from "../../../../scripts/lib/instance.mjs";

/** Offline, disposable data for the Debug browser and its folder acceptance tests. */
export function nestedFoldersFixture() {
  const folder = (id, name, parentId, createdAt) => ({ id, name, parentId, spaceId: "default", icon: null, collapsed: false, createdAt });
  const page = (id, title, folderId) => ({
    id,
    title,
    url: `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title><body style="font:20px system-ui;padding:48px;background:#f6f3ed;color:#282b32"><h1>${title}</h1><p>Bay nested folders fixture. This page is fake and works offline.</p><input aria-label="Draft" value="Try editing, then Undo"><p>Move tabs and folders in the sidebar. Five folder levels are supported.</p>`)}`,
    ...(folderId ? { pinnedRow: true, folderId } : {}),
  });
  return session({
    spaces: [{ id: "default", name: "Folder playground", color: "blue", icon: "🗂️" }],
    settings: { density: "compact", launchTab: "lastTab", addressBar: "sidebar", tabLayout: "sidebar", warnBeforeClosingLastTab: false },
    windows: [{ id: "w1", activeTabIds: { default: "today" }, frame: [80, 80, 1200, 850] }],
    tabs: [
      page("overview", "Project overview", "projects"),
      page("design", "Design notes", "designs"),
      page("deep", "Level five document", "level5"),
      page("summary", "Project summary", "projects"),
      page("loose", "Loose pinned tab"),
      page("today", "Folder playground"),
    ].map((t) => t.id === "loose" ? { ...t, pinnedRow: true } : t),
    pinnedFolders: [
      folder("projects", "Projects", undefined, 1),
      folder("designs", "Design", "projects", 2),
      folder("research", "Research", "designs", 3),
      folder("archive", "Archive", "research", 4),
      folder("level5", "Level five", "archive", 5),
      folder("empty", "Empty subfolder", "projects", 6),
      folder("reading", "Reading", undefined, 7),
    ],
  });
}
