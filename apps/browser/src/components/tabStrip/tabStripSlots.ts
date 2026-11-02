// Only the first tab identifies a top-level drag slot. Repeated heads keep their first match.
export function firstSlotIndexes(slots: readonly { tabIds: readonly string[] }[]): Map<string | undefined, number> {
  const indexes = new Map<string | undefined, number>();
  slots.forEach((slot, i) => {
    const first = slot.tabIds[0];
    if (!indexes.has(first)) indexes.set(first, i);
  });
  return indexes;
}
