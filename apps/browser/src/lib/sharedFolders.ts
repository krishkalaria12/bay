// Folders that stay shared (G11): a pinned folder bound to a real directory of link files, which iCloud Drive,
// Dropbox, OneDrive or any synced folder shares with other people. Bay reads the three kinds of link file
// (.webloc on macOS, .url on Windows, .desktop on Linux) and writes its own platform's.
//
// Sync is three-way: what the folder and the directory hold now, against what both held after the last sync. A
// change on one side only goes to the other; a link changed on both takes the directory's (someone else's) version.

export type Link = { url: string; title: string };

export type LinkFormat = "webloc" | "url" | "desktop";

export const LINK_EXTENSIONS: readonly LinkFormat[] = ["webloc", "url", "desktop"];

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" } as const;

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (c) => Object.entries(XML_ESCAPES).find(([ch]) => ch === c)?.[1] ?? c);

const unescapeXml = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, name: string) => {
    const lower = name.toLowerCase();

    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));

    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));

    return Object.entries(XML_ESCAPES).find(([, e]) => e === `&${lower};`)?.[0] ?? entity;
  });

export const formatOf = (name: string): LinkFormat | null => LINK_EXTENSIONS.find((ext) => name.toLowerCase().endsWith(`.${ext}`)) ?? null;

/** The title a link file's name gives it: the name without its extension. */
export const titleOf = (name: string) => name.replace(/\.(webloc|url|desktop)$/i, "").trim();

/** An INI-style file's value for `key` in `[section]` (.url and .desktop files). */
function iniValue(text: string, section: string, key: string): string | null {
  let inSection = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);

    if (header) {
      inSection = header[1]!.toLowerCase() === section.toLowerCase();
      continue;
    }

    const eq = line.indexOf("=");

    if (inSection && eq > 0 && line.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) return line.slice(eq + 1).trim();
  }

  return null;
}

const webAddress = (url: string | null) => (url && /^(https?|file):\/\//i.test(url) ? url : null);

/** A link file's address and title; null for one that isn't a web link (or a binary .webloc, which the host decodes). */
export function parseLink(name: string, text: string): Link | null {
  const format = formatOf(name);
  let url: string | null = null;
  let title = titleOf(name);

  if (format === "webloc") {
    const match = /<key>\s*URL\s*<\/key>\s*<string>([\s\S]*?)<\/string>/i.exec(text);
    url = match ? unescapeXml(match[1]!.trim()) : null;
  } else if (format === "url") url = iniValue(text, "InternetShortcut", "URL");
  else if (format === "desktop") {
    if (iniValue(text, "Desktop Entry", "Type")?.toLowerCase() !== "link") return null;
    url = iniValue(text, "Desktop Entry", "URL");
    title = iniValue(text, "Desktop Entry", "Name") || title;
  }

  const address = webAddress(url);

  return address ? { url: address, title: title || address } : null;
}

/** A link as the file `format` writes. */
export function linkText(link: Link, format: LinkFormat): string {
  if (format === "url") return `[InternetShortcut]\r\nURL=${link.url}\r\n`;

  if (format === "desktop") return `[Desktop Entry]\nVersion=1.0\nType=Link\nName=${link.title.replace(/[\r\n]/g, " ")}\nURL=${link.url}\nIcon=text-html\n`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>URL</key>",
    `\t<string>${escapeXml(link.url)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** A file name for a link's title, safe on every platform and not already `taken` (compared ignoring case). */
export function fileNameFor(title: string, format: LinkFormat, taken: ReadonlySet<string>): string {
  const base =
    [...title]
      .map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f || '/\\:*?"<>|'.includes(c) ? " " : c))
      .join("")
      .replace(/\s+/g, " ")
      .replace(/^[\s.]+|[\s.]+$/g, "")
      .slice(0, 100) || "Link";

  const lower = new Set([...taken].map((n) => n.toLowerCase()));

  for (let n = 1; ; n++) {
    const name = `${n === 1 ? base : `${base} ${n}`}.${format}`;

    if (!lower.has(name.toLowerCase())) return name;
  }
}

// MARK: Sync

/** What both sides held after the last sync: each file, its link, and the tab it is. */
export type Known = Record<string, Link & { tabId: string }>;

export type FolderTab = Link & { id: string };

export type DirectoryLink = Link & { name: string };

export type SyncPlan = {
  /** New tabs for links that appeared in the directory, by file name. */
  addTabs: DirectoryLink[];
  removeTabs: string[];
  updateTabs: (Link & { tabId: string })[];
  /** Files to write: new or changed tabs. */
  writeFiles: (DirectoryLink & { tabId: string })[];
  removeFiles: string[];
  /** What both sides hold once the plan is done; added tabs are filled in by file name when they exist. */
  known: Known;
};

const same = (a: Link, b: Link) => a.url === b.url && a.title === b.title;

export function planSync(known: Known, files: DirectoryLink[], tabs: FolderTab[], format: LinkFormat): SyncPlan {
  const plan: SyncPlan = { addTabs: [], removeTabs: [], updateTabs: [], writeFiles: [], removeFiles: [], known: {} };
  const fileByName = new Map(files.map((f) => [f.name, f]));
  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const seenFiles = new Set<string>();
  const seenTabs = new Set<string>();
  const taken = new Set(files.map((f) => f.name));

  for (const [name, was] of Object.entries(known)) {
    const file = fileByName.get(name);
    const tab = tabById.get(was.tabId);

    if (file) seenFiles.add(name);

    if (tab) seenTabs.add(tab.id);

    const fileChanged = !!file && !same(file, was);
    const tabChanged = !!tab && !same(tab, was);

    if (!file && !tab) continue;

    if (!file) {
      // Removed from the directory: the tab goes, unless it changed here since.
      if (tabChanged) {
        plan.writeFiles.push({ name, url: tab!.url, title: tab!.title, tabId: tab!.id });
        plan.known[name] = { url: tab!.url, title: tab!.title, tabId: tab!.id };
      } else plan.removeTabs.push(tab!.id);
      continue;
    }

    if (!tab) {
      // Removed from the folder: the file goes, unless someone changed it since.
      if (fileChanged) plan.addTabs.push(file);
      else plan.removeFiles.push(name);
      continue;
    }

    if (fileChanged) {
      plan.updateTabs.push({ tabId: tab.id, url: file.url, title: file.title });
      plan.known[name] = { url: file.url, title: file.title, tabId: tab.id };
    } else if (tabChanged) {
      // A file's name is its title: a renamed tab renames its file.
      const renamed = tab.title !== was.title ? fileNameFor(tab.title, formatOf(name) ?? format, new Set([...taken].filter((n) => n !== name))) : name;

      if (renamed !== name) {
        plan.removeFiles.push(name);
        taken.add(renamed);
      }

      plan.writeFiles.push({ name: renamed, url: tab.url, title: tab.title, tabId: tab.id });
      plan.known[renamed] = { url: tab.url, title: tab.title, tabId: tab.id };
    } else plan.known[name] = was;
  }

  for (const file of files) if (!seenFiles.has(file.name)) plan.addTabs.push(file);

  for (const tab of tabs) {
    if (seenTabs.has(tab.id)) continue;
    const name = fileNameFor(tab.title, format, taken);
    taken.add(name);
    plan.writeFiles.push({ name, url: tab.url, title: tab.title, tabId: tab.id });
    plan.known[name] = { url: tab.url, title: tab.title, tabId: tab.id };
  }

  return plan;
}

/** Whether the plan changes anything. */
export const planChanges = (plan: SyncPlan) =>
  plan.addTabs.length + plan.removeTabs.length + plan.updateTabs.length + plan.writeFiles.length + plan.removeFiles.length > 0;
