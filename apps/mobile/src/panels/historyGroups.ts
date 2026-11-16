/** Which day a group covers; the panels show it as a `history.group.<id>` message. */
export type DayGroupId = "today" | "yesterday" | "week" | "earlier";

/** Splits newest-first entries into Today, Yesterday, This week and Earlier, by the device's local days. */
export function groupByDay<T>(entries: readonly T[], now: number, at: (entry: T) => number): { id: DayGroupId; label: string; entries: T[] }[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const yesterday = new Date(today).setDate(new Date(today).getDate() - 1);
  const week = new Date(today).setDate(new Date(today).getDate() - 6);

  // SAFETY: each group starts with an empty entries list; every entry is pushed exactly once below.
  const groups = [
    { id: "today" as const, label: "Today", from: today, entries: [] as T[] },
    { id: "yesterday" as const, label: "Yesterday", from: yesterday, entries: [] as T[] },
    { id: "week" as const, label: "This week", from: week, entries: [] as T[] },
    { id: "earlier" as const, label: "Earlier", from: -Infinity, entries: [] as T[] },
  ];

  for (const entry of entries) groups.find((group) => at(entry) >= group.from)!.entries.push(entry);

  return groups.flatMap((group) => (group.entries.length ? [{ id: group.id, label: group.label, entries: group.entries }] : []));
}
