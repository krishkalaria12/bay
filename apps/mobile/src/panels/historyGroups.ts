/** Splits newest-first entries into Today, Yesterday, This week and Earlier, by the device's local days. */
export function groupByDay<T>(entries: readonly T[], now: number, at: (entry: T) => number): { label: string; entries: T[] }[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const yesterday = new Date(today).setDate(new Date(today).getDate() - 1);
  const week = new Date(today).setDate(new Date(today).getDate() - 6);
  const groups = [
    { label: "Today", from: today, entries: [] as T[] },
    { label: "Yesterday", from: yesterday, entries: [] as T[] },
    { label: "This week", from: week, entries: [] as T[] },
    { label: "Earlier", from: -Infinity, entries: [] as T[] },
  ];
  for (const entry of entries) groups.find((group) => at(entry) >= group.from)!.entries.push(entry);
  return groups.filter((group) => group.entries.length).map(({ label, entries: grouped }) => ({ label, entries: grouped }));
}
