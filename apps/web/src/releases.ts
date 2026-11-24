// Bay's versions, from the repo's release-notes/<platform>/<version>.md: each platform has its own versions and notes
// (release-notes/README.md). Each has `date:` and `headline:` frontmatter, then either `## Added`, `## Improved`…
// sections of "- **Title.** What changed." items, or (Mac 1.0.0) one list of them.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Item = { title: string; body: string };

export type Section = { title: string; items: Item[] };

export type Release = { version: string; date: string; headline: string; sections: Section[] };

// Astro builds from apps/web.
const root = resolve(process.cwd(), "../../release-notes");

export const platformIds = ["mac", "linux", "windows"] as const;

export type Platform = (typeof platformIds)[number];

/** Each platform's release notes live at /<platform>/release-notes/. */
export const platforms: Record<Platform, { name: string; updates: string }> = {
  mac: { name: "Mac", updates: "It updates itself; restart it when it says so." },
  linux: { name: "Linux", updates: "Your package manager keeps it up to date." },
  windows: { name: "Windows", updates: "It updates itself." },
};

export const notesPath = (platform: Platform, version?: string) => `/${platform}/release-notes/${version ? `${version}/` : ""}`;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The notes' inline Markdown, as HTML: bold, code (a key like ⌘L), and links. */
export function inline(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, '<kbd class="kbd">$1</kbd>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="underline decoration-line underline-offset-4 hover:decoration-ink" href="$2">$1</a>');
}

// What follows a bold title, as a sentence of its own: "**Spaces**, each with…" reads "Each with…".
const sentence = (text: string) => text.replace(/^[\s,:;–—-]+/, "").replace(/^[a-z]/, (c) => c.toUpperCase());

function parse(version: string, source: string): Release {
  const [, front = "", body = source] = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/) ?? [];
  const field = (name: string) => front.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  const sections: Section[] = [];
  let section: Section | null = null;
  let item: Item | null = null;

  for (const line of body.split("\n")) {
    const heading = line.match(/^#{2,3}\s+(.+)$/);

    if (heading) {
      section = { title: heading[1]!.trim(), items: [] };
      sections.push(section);
      item = null;
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);

    if (bullet) {
      if (!section) {
        section = { title: "", items: [] };
        sections.push(section);
      }

      // "**Title.** What changed", or a bullet with no title.
      const titled = bullet[1]!.match(/^\*\*(.+?)\*\*\s*(.*)$/);
      item = titled ? { title: titled[1]!.replace(/[.:]$/, ""), body: sentence(titled[2]!) } : { title: "", body: bullet[1]! };
      section.items.push(item);
    } else if (item && /^\s+\S/.test(line)) {
      item.body += ` ${line.trim()}`;
    } else if (line.trim()) {
      item = null;
    }
  }

  return { version, date: field("date"), headline: field("headline"), sections: sections.filter((s) => s.items.length) };
}

const newer = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);

  return 0;
};

/** Every version for the platform, newest first. */
export function releases(platform: Platform): Release[] {
  const dir = join(root, platform);

  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => /^\d+(\.\d+)*\.md$/.test(f))
    .map((f) => parse(f.slice(0, -3), readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => newer(a.version, b.version));
}

/** "October 10, 2026" (the dates are days, read in UTC so they never shift). */
export const longDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "10 added, 4 fixed", or for one untitled list, "10 highlights". */
export function counts(release: Release): string {
  const named = release.sections.filter((s) => s.title);

  if (!named.length) {
    const n = release.sections.reduce((sum, s) => sum + s.items.length, 0);

    return `${n} highlight${n === 1 ? "" : "s"}`;
  }

  return named.map((s) => `${s.items.length} ${s.title.toLowerCase()}`).join(", ");
}
