import type { Adapter } from "@bay/sync";
import { normalizeExternalLinkRules, type ExternalLinkRule } from "../lib/externalLinkRules";
import { useBrowser } from "../store/browser";

type ProfileLinks = Record<string, { syncId: string }>;
type SyncedRule = Omit<ExternalLinkRule, "destination"> & {
  destination: { kind: "space"; profileId: string } | { kind: "littleBay" } | { kind: "newWindow" };
};

const KEY = "linkRules:ordered";
const missingSpace = (syncId: string) => `sync-profile:${syncId}`;

function profileIdFor(rule: ExternalLinkRule, links: ProfileLinks): string | undefined {
  const destination = rule.destination;
  if (destination.kind !== "space") return;
  // A new sync chain assigns fresh profile IDs to existing local spaces.
  if (useBrowser.getState().spaces[destination.spaceId]) return links[destination.spaceId]?.syncId;
  // A deleted space that never synced cannot be linked elsewhere. Preserve its unavailable rule.
  return destination.syncProfileId ?? links[destination.spaceId]?.syncId ?? `unlinked-rule:${rule.id}`;
}

function localSpace(syncId: string, links: ProfileLinks): string {
  const spaces = useBrowser.getState().spaces;
  return Object.entries(links).find(([id, link]) => link.syncId === syncId && spaces[id])?.[0] ?? missingSpace(syncId);
}

// Profile links can arrive after the rules, without any new rule record to apply.
export function resolveLinkRuleSpaces(links: ProfileLinks): void {
  const store = useBrowser.getState();
  let changed = false;
  const rules = store.settings.externalLinkRules.map((rule) => {
    const destination = rule.destination;
    if (destination.kind !== "space") return rule;
    const syncProfileId = profileIdFor(rule, links);
    if (!syncProfileId) return rule;
    const spaceId = localSpace(syncProfileId, links);
    if (destination.syncProfileId === syncProfileId && destination.spaceId === spaceId) return rule;
    changed = true;
    return { ...rule, destination: { kind: "space" as const, spaceId, syncProfileId } };
  });
  if (changed) store.updateSettings({ externalLinkRules: rules });
}

export function linkRulesAdapter(links: () => ProfileLinks): Adapter {
  return {
    prefix: "linkRules:",
    adoptRemoteOnJoin: true,
    extract: () => {
      const rules: SyncedRule[] = [];
      for (const rule of useBrowser.getState().settings.externalLinkRules) {
        const { destination } = rule;
        if (destination.kind !== "space") {
          rules.push({ ...rule, destination });
          continue;
        }
        const profileId = profileIdFor(rule, links());
        // A new space gets its stable profile link after the first app-scope cycle.
        if (!profileId) return null;
        rules.push({ ...rule, destination: { kind: "space", profileId } });
      }
      // One record keeps first-match priority intact across devices.
      return { values: new Map([[KEY, { rules }]]) };
    },
    apply: (visible, changed) => {
      if (!changed.has(KEY)) return;
      const record = visible.get(KEY) as { rules?: unknown } | undefined;
      if (!record) return;
      if (!Array.isArray(record.rules)) return;
      const rules = record.rules.map((rule: unknown) => {
        if (!rule || typeof rule !== "object") return null;
        const incoming = rule as SyncedRule;
        const destination = incoming.destination;
        if (destination?.kind !== "space") return incoming;
        if (typeof destination.profileId !== "string" || !destination.profileId) return null;
        return {
          ...incoming,
          destination: { kind: "space", spaceId: localSpace(destination.profileId, links()), syncProfileId: destination.profileId },
        };
      });
      const normalized = normalizeExternalLinkRules(rules);
      // Ignore a malformed list as a whole, so corruption cannot silently remove a rule.
      if (normalized.length !== rules.length) return;
      useBrowser.getState().updateSettings({ externalLinkRules: normalized });
    },
  };
}
