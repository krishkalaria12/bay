import type { Adapter } from "@bay/sync";
import { normalizeBoost, type Boost } from "../lib/boosts";
import { applySyncedBoosts, startBoosts, useBoosts } from "../components/boosts/state";

// Boosts across Macs: one record a Boost, its look and CSS (and whether it's on). Its JavaScript never leaves this
// Mac: scripts live beside Boosts (useBoosts' scripts), not in them, so nothing here can carry one. A Boost another
// Mac sends can't bring code with it either: it has no script field, and normalizeBoost drops anything it doesn't know.

const PREFIX = "boost:";

type BoostRecord = Omit<Boost, "id">;

export const boostsAdapter: Adapter = {
  prefix: PREFIX,
  extract: () => {
    startBoosts();
    const s = useBoosts.getState();
    // Unreadable here: publish nothing rather than deletions.
    if (!s.loaded || s.error) return null;
    return { values: new Map(Object.values(s.boosts).map(({ id, ...record }) => [`${PREFIX}${id}`, record satisfies BoostRecord])) };
  },
  apply: (visible, changed) => {
    startBoosts();
    if (useBoosts.getState().error) return false;
    const upserts: Boost[] = [];
    const removed: string[] = [];
    for (const key of changed) {
      if (!key.startsWith(PREFIX)) continue;
      const id = key.slice(PREFIX.length);
      if (!visible.has(key)) {
        removed.push(id);
        continue;
      }
      // A malformed record changes nothing: only a tombstone removes a Boost.
      const boost = normalizeBoost({ ...(visible.get(key) as object), id });
      if (boost) upserts.push(boost);
    }
    if (upserts.length || removed.length) applySyncedBoosts(upserts, removed);
  },
  editedAt: (value) => {
    const at = (value as { updatedAt?: unknown } | null)?.updatedAt;
    return typeof at === "number" && Number.isFinite(at) ? at : undefined;
  },
};
