import { savePassword } from "@bay/nncore";
import type { Credential, ImportedExtension, ImportKind, ImportResult, SafariExport, SpaceSuggestion } from "@bay/import";
import { browserRead } from "../../store/read";
import { isIncognitoSpace, plural } from "../../store/model";
import type { SpaceColor } from "../../store/types";
import { importModule } from "./module";
import { destinationProfile, importBookmarks, importSafariBookmarks, importHistory, importTabs, importArcSpace } from "./commands";
export { importBookmarks, importSafariBookmarks, importHistory, importTabs, importArcSpace, importDiaProfile, openInWebStore } from "./commands";

export type ImportCounts = {
  bookmarks: number;
  history: number;
  tabs: number;
  passwords: number;
  cookies: number;
  addresses: number;
  cards: number;
  extensions: number;
  extensionSettings: number;
};

export const emptyCounts = (): ImportCounts => ({
  bookmarks: 0,
  history: 0,
  tabs: 0,
  passwords: 0,
  cookies: 0,
  addresses: 0,
  cards: 0,
  extensions: 0,
  extensionSettings: 0,
});

/** What an import brought, a phrase for each kind with any: "3 bookmarks", "1 address". */
export const importedSummary = (counts: ImportCounts) =>
  [
    counts.bookmarks && plural(counts.bookmarks, "bookmark"),
    counts.history && plural(counts.history, "history item"),
    counts.passwords && plural(counts.passwords, "password"),
    counts.cookies && plural(counts.cookies, "cookie"),
    counts.addresses && `${counts.addresses} ${counts.addresses === 1 ? "address" : "addresses"}`,
    counts.cards && plural(counts.cards, "card"),
    counts.tabs && plural(counts.tabs, "tab"),
    counts.extensions && plural(counts.extensions, "extension"),
    counts.extensionSettings && plural(counts.extensionSettings, "extension setting"),
  ].filter(Boolean) as string[];

export type ExtensionFailure = { spaceId: string; extension: ImportedExtension; message: string };

/** One source profile's extensions go only to its destination spaces. Shared destination profiles are written once. */
export async function importExtensions(spaceIds: string[], result: ImportResult, signal?: AbortSignal) {
  const api = importModule();
  let imported = 0;
  let storageImported = 0;
  const failed: ExtensionFailure[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const spaceId of spaceIds) {
    let profile: string;
    try {
      profile = destinationProfile(spaceId);
    } catch {
      failed.push(...(result.extensions ?? []).map((extension) => ({ spaceId, extension, message: "The destination space is unavailable" })));
      continue;
    }
    if (seen.has(profile)) continue;
    seen.add(profile);
    for (const extension of result.extensions ?? []) {
      if (signal?.aborted) throw Object.assign(new Error("Import cancelled"), { code: "cancelled" });
      try {
        if (!api || isIncognitoSpace(spaceId) || !browserRead.getState().spaces[spaceId]) throw new Error("The destination space is unavailable");
        const written = await api.writeExtension(result.browserId, result.profileId, extension.id, profile);
        if (written.installed) imported++;
        storageImported += written.storageImported;
        const name = browserRead.getState().spaces[spaceId]?.name ?? "Space";
        notes.push(...written.warnings.map((message) => `${extension.name} in ${name}: ${message}`));
      } catch (error) {
        failed.push({ spaceId, extension, message: (error as Error).message });
      }
      if (signal?.aborted) throw Object.assign(new Error("Import cancelled"), { code: "cancelled" });
    }
  }
  return { imported, storageImported, failed, notes };
}

export async function importPasswords(spaceId: string, credentials: Credential[]): Promise<number> {
  let saved = 0;
  for (const c of credentials) {
    const origin = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(c.realm?.startsWith("http") ? c.realm : c.url)?.[1];
    if (!origin || !c.password) continue;
    if (await savePassword(destinationProfile(spaceId), origin, c.username, c.password).catch(() => false)) saved++;
  }
  return saved;
}

/** Writes the cookies, addresses and cards an import kept natively (their values never reach JS) into the profile.
 * Never into a private profile: the token is dropped instead. `onFailed` hears the kinds the engine refused. */
export async function importNative(
  spaceId: string,
  token: string | undefined,
  kinds: ("cookies" | "autofill")[],
  onFailed?: (kind: ImportKind) => void,
): Promise<Pick<ImportCounts, "cookies" | "addresses" | "cards">> {
  const none = { cookies: 0, addresses: 0, cards: 0 };
  const api = importModule();
  if (!api || !token) return none;
  if (!kinds.length || isIncognitoSpace(spaceId) || browserRead.getState().spaces[spaceId] === undefined) {
    api.discardImported(token);
    return none;
  }
  try {
    const w = await api.writeImported(token, destinationProfile(spaceId), kinds);
    if (w.cookiesFailed) onFailed?.("cookies");
    if (w.autofillFailed) onFailed?.("autofill");
    return { cookies: w.cookies, addresses: w.addresses, cards: w.cards };
  } catch {
    kinds.forEach((k) => onFailed?.(k));
    return none;
  }
}

export async function applyResult(spaceId: string, result: ImportResult, browserName: string, onFailed?: (kind: ImportKind) => void): Promise<ImportCounts> {
  const counts = emptyCounts();
  counts.bookmarks += await importBookmarks(spaceId, result.bookmarks, browserName);
  if (result.history.length) counts.history += await importHistory(spaceId, result.history);
  // Sign-ins first, so the imported tabs load signed in.
  Object.assign(counts, await importNative(spaceId, result.vaultToken, ["cookies", "autofill"], onFailed));
  if (result.tabs.length && !result.spaces.length) counts.tabs += await importTabs(spaceId, result.tabs, "Imported");
  if (result.favorites.length)
    counts.tabs += await importTabs(
      spaceId,
      result.favorites.map((t) => ({ ...t, pinned: true })),
      null,
    );
  if (result.credentials.length) counts.passwords += await importPasswords(spaceId, result.credentials);
  return counts;
}

/** Each imported Arc space owns its profile. Shared source data is copied once into each destination;
 * cookies and autofill need a fresh native token because writing consumes the token. */
export async function applyArcProfile(
  destinations: { spaceId: string; space: SpaceSuggestion }[],
  result: ImportResult,
  browserName: string,
  readNative: () => Promise<Pick<ImportResult, "vaultToken" | "failed">>,
  onFailed?: (kind: ImportKind) => void,
): Promise<ImportCounts> {
  const total = emptyCounts();
  for (let i = 0; i < destinations.length; i++) {
    const { spaceId, space } = destinations[i]!;
    let token = result.vaultToken;
    if (i > 0 && token) {
      token = undefined;
      try {
        const fresh = await readNative();
        token = fresh.vaultToken;
        fresh.failed.forEach((kind) => onFailed?.(kind));
      } catch (error) {
        if ((error as { code?: string } | null)?.code === "cancelled") throw error;
        if (result.cookieCount) onFailed?.("cookies");
        if (result.addressCount || result.cardCount) onFailed?.("autofill");
      }
    }
    const counts = await applyResult(spaceId, { ...result, vaultToken: token }, browserName, onFailed);
    counts.tabs += await importArcSpace(spaceId, space);
    for (const key of Object.keys(total) as (keyof ImportCounts)[]) total[key] += counts[key];
  }
  return total;
}

/** `cookies`: whether the user kept Safari's cookies ticked (the export file has none; its cards always come). */
export async function applySafari(spaceId: string, data: SafariExport, cookies = true, onFailed?: (kind: ImportKind) => void): Promise<ImportCounts> {
  const counts = emptyCounts();
  counts.bookmarks = await importSafariBookmarks(spaceId, data.bookmarks);
  const history = data.profiles.find((p) => !p.name)?.history ?? data.profiles[0]?.history ?? [];
  counts.history = await importHistory(spaceId, history);
  Object.assign(counts, await importNative(spaceId, data.vaultToken, cookies ? ["cookies", "autofill"] : ["autofill"], onFailed));
  if (data.tabs.length) counts.tabs += await importTabs(spaceId, data.tabs, "Imported");
  counts.passwords = await importPasswords(spaceId, data.credentials);
  return counts;
}

export function profileColorFor(hex: string | undefined): SpaceColor | undefined {
  const m = hex && /^#?([0-9a-f]{6})/i.exec(hex);
  if (!m) return undefined;
  const v = parseInt(m[1]!, 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return "neutral";
  let h = 0;
  if (max === r) h = ((g - b) / (max - min) + 6) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h *= 60;
  const hues: [SpaceColor, number][] = [
    ["red", 0],
    ["orange", 25],
    ["yellow", 45],
    ["green", 140],
    ["blue", 210],
    ["purple", 265],
    ["pink", 330],
    ["red", 360],
  ];
  return hues.reduce((best, c) => (Math.abs(c[1] - h) < Math.abs(best[1] - h) ? c : best))[0];
}
