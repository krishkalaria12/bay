// Arc Max's Tidy Tabs, without the cloud: the on-device model proposes named groups for the loose tabs, and this module
// decides what it is asked and what of its answer the sidebar may use. The model only ever sees a tab's title and site.

/** Tidy is offered once the list holds this many tabs, grouped ones included (Arc's canAutoOrganizeTodayTabs). */
export const MIN_TIDY_TABS = 6;

/** The model reads about 4K tokens: a sidebar's worth of titles has to stop somewhere. */
export const MAX_TIDY_TABS = 60;

const MAX_TITLE_LENGTH = 80;
const MAX_GROUP_NAME_LENGTH = 32;

// A folder for what fit nowhere isn't tidier than loose tabs: those stay loose.
const CATCH_ALL_NAMES = new Set(["other", "others", "misc", "miscellaneous", "general", "uncategorized", "various"]);

export type TidyTab = { title: string; host: string };

/** One group of the model's answer: `tabs` are ids from the prompt. */
export type TidyProposal = { name: string; tabs: number[] };

export type TidyPlan = {
  /** New groups, in the order of their first tab. */
  newGroups: TidyProposal[];
  /** Tabs joining a group the list already has; `group` is its index in `existingGroups`. */
  joins: { group: number; tabs: number[] }[];
};

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function nameKey(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase();
}

/**
 * Whether the sidebar offers Tidy: enough tabs, one of them loose, and one that came in since the last run (`tidied`:
 * the tabs when it ran, null before any run). A run that grouped nothing would only do so again on the same tabs.
 */
export function offersTidy(tabCount: number, looseTabs: readonly string[], tidied: ReadonlySet<string> | null): boolean {
  if (tabCount < MIN_TIDY_TABS || !looseTabs.length) return false;

  return !tidied || looseTabs.some((id) => !tidied.has(id));
}

/** The request: each tab's place in this list is its id. `existingGroups` lets new tabs join what's already sorted. */
export function tidyTabsPrompt(tabs: readonly TidyTab[], existingGroups: readonly string[]): string {
  const lines = ["Here are my tabs, as 'id: title (site)':"];
  tabs.slice(0, MAX_TIDY_TABS).forEach((tab, id) => {
    const title = clip(tab.title || tab.host, MAX_TITLE_LENGTH);
    lines.push(tab.host ? `${id}: ${title} (${tab.host})` : `${id}: ${title}`);
  });

  if (existingGroups.length) {
    // Without the second half this model filed whatever was left over under any name it was given.
    const names = existingGroups.map((name) => `"${name}"`).join(", ");
    lines.push("", `I already have these groups. Reuse a name exactly only for a tab about that group's subject; a tab that isn't stays out of it: ${names}.`);
  }

  return lines.join("\n");
}

/**
 * The model's answer made safe: ids in range and used once (the first group wins), names trimmed and capped, a name
 * matching an existing group adds to it, two new groups with one name merge, and a new group needs two tabs.
 */
export function planTidyTabs(proposals: readonly TidyProposal[], tabCount: number, existingGroups: readonly string[]): TidyPlan {
  const count = Math.min(tabCount, MAX_TIDY_TABS);
  const existing = existingGroups.map(nameKey);
  const used = new Set<number>();
  const joins = new Map<number, number[]>();
  const fresh = new Map<string, TidyProposal>();

  for (const proposal of proposals) {
    const name = clip(proposal.name.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, ""), MAX_GROUP_NAME_LENGTH);
    const key = nameKey(name);

    if (!key || CATCH_ALL_NAMES.has(key)) continue;
    const ids = proposal.tabs.filter((id) => Number.isInteger(id) && id >= 0 && id < count && !used.has(id));
    // A repeated id in one group's answer counts once.
    const unique = [...new Set(ids)];
    const at = existing.indexOf(key);

    // A lone tab joins a group the list has; a new group waits to see whether it reaches two (below).
    if (at >= 0) {
      if (!unique.length) continue;
      unique.forEach((id) => used.add(id));
      joins.set(at, [...(joins.get(at) ?? []), ...unique]);
      continue;
    }

    const group = fresh.get(key) ?? { name, tabs: [] };
    group.tabs.push(...unique);
    unique.forEach((id) => used.add(id));
    fresh.set(key, group);
  }

  const newGroups = [...fresh.values()]
    .flatMap((group) => (group.tabs.length >= 2 ? [{ name: group.name, tabs: [...group.tabs].sort((a, b) => a - b) }] : []))
    .sort((a, b) => a.tabs[0]! - b.tabs[0]!);

  return { newGroups, joins: [...joins].map(([group, tabs]) => ({ group, tabs: [...tabs].sort((a, b) => a - b) })) };
}
