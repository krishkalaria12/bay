// The search engines the extensions have registered: what the app keeps of them.
//
// The engine's list is the app's list, profile by profile: a profile's engines replace its own, and the other
// profiles' engines are left alone. When the list is read is the service's business (components/extensions/service.ts).
import * as chromium from "@bay/chromium";
import type { EngineSearchEngineList } from "@bay/chromium";
import { extensionEnginesFromChrome } from "@bay/core";
import type { JsonValue } from "../../lib/json";
import { useBrowser, type BrowserStore } from "../../store/browserStore";
import { useExtensions } from "./store";

/** The profile's search engines, as the app keeps them. */
export function applyExtensionSearchEngines(profile: string, list: EngineSearchEngineList, store: Pick<BrowserStore, "getState">): void {
  const json: JsonValue | null | undefined = JSON.parse(JSON.stringify(list));

  if (json == null) return;

  const engines = extensionEnginesFromChrome(profile, json);
  const s = store.getState();
  const current = s.settings.extensionSearchEngines ?? [];
  const next = [...current.filter((e) => e.profile !== profile), ...engines];

  if (JSON.stringify(next) !== JSON.stringify(current)) s.updateSettings({ extensionSearchEngines: next });
}

/** Reads a profile's search engines again, and keeps them. A read that fails leaves them as they were. */
export async function refreshExtensionSearchEngines(profile: string, store: BrowserStore = useBrowser, active = () => true) {
  let list: JsonValue | null | undefined;

  try {
    list = JSON.parse(JSON.stringify(await chromium.searchEngineList(profile)));
  } catch (error) {
    console.warn("[extensions] search engines failed", error);

    return;
  }

  if (list == null || !active()) return;

  const engines = extensionEnginesFromChrome(profile, list);
  const s = store.getState();
  const current = s.settings.extensionSearchEngines ?? [];
  const next = [...current.filter((e) => e.profile !== profile), ...engines];

  if (JSON.stringify(next) !== JSON.stringify(current)) s.updateSettings({ extensionSearchEngines: next });
}

/** Watches the extensions the engine reports and refreshes each profile's search engines. The answer is the
 * stop that ends the watch.
 */
export function startExtensionSearchEngines(store: BrowserStore = useBrowser) {
  let stopped = false;
  const delayed = new Set<ReturnType<typeof setTimeout>>();
  const timers: Record<string, ReturnType<typeof setTimeout>> = {};
  const read = new Set<string>();

  const unsubscribe = useExtensions.subscribe((e, prev) => {
    if (e.lists === prev.lists) return;

    for (const [profile, list] of Object.entries(e.lists)) {
      if (list === prev.lists[profile]) continue;
      clearTimeout(timers[profile]);
      timers[profile] = setTimeout(() => void refreshExtensionSearchEngines(profile, store, () => !stopped), 400);

      // The engine registers a new extension's search engine a moment after the install: the first read of a
      // profile waits for that, the later ones do not.
      if (!read.has(profile)) delayed.add(setTimeout(() => void refreshExtensionSearchEngines(profile, store, () => !stopped), 3000));
      read.add(profile);
    }
  });

  return () => {
    stopped = true;
    unsubscribe();

    for (const timer of [...Object.values(timers), ...delayed]) clearTimeout(timer);
  };
}
