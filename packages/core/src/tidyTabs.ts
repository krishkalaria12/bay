// Arc Max's Tidy Tabs: group today's tabs by topic.
//
// Without a model on this Mac, tabs are grouped by the site they come from, which is
// the strongest deterministic signal available locally. Tabs of a single site stay
// together; the rest gather in an "Other" group when there are enough of them.

export type TidyTabInput = { title?: string | null; url?: string | null };

export type TidyTabGroup = { name: string; indices: number[] };

function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostLabel(host: string): string {
  const label = host.split(".")[0] ?? "";
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
}

export function tidyTabs(tabs: TidyTabInput[]): TidyTabGroup[] {
  const groups = new Map<string, number[]>();
  const other: number[] = [];
  tabs.forEach((tab, index) => {
    const host = hostOf(tab?.url ?? null);
    if (!host) {
      other.push(index);
      return;
    }
    const key = host;
    const list = groups.get(key) ?? [];
    list.push(index);
    groups.set(key, list);
  });
  const out: TidyTabGroup[] = [];
  for (const [host, indices] of groups) {
    if (indices.length >= 2) out.push({ name: hostLabel(host) || host, indices });
    else other.push(...indices);
  }
  if (other.length >= 2) out.push({ name: "Other", indices: other });
  return out;
}

export const tidyTodayTabs = tidyTabs;
export const groupTabsByTopic = tidyTabs;
export const groupTodayTabsByTopic = tidyTabs;
