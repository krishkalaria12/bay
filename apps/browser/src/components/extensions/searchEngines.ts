// The search engines the extensions have registered: what the app keeps of them.
//
// The engine's list is the app's list, profile by profile: a profile's engines replace its own, and the other
// profiles' engines are left alone. When the list is read is the service's business (components/extensions/service.ts).
import type { EngineSearchEngineList } from "@bay/chromium";
import { extensionEnginesFromChrome } from "@bay/core";
import type { JsonValue } from "../../lib/json";
import { useBrowser } from "../../store/browserStore";

/** The profile's search engines, as the app keeps them. */
export function applyExtensionSearchEngines(profile: string, list: EngineSearchEngineList): void {
  const json: JsonValue | null | undefined = JSON.parse(JSON.stringify(list));

  if (json == null) return;

  const engines = extensionEnginesFromChrome(profile, json);
  const s = useBrowser.getState();
  const current = s.settings.extensionSearchEngines ?? [];
  const next = [...current.filter((e) => e.profile !== profile), ...engines];

  if (JSON.stringify(next) !== JSON.stringify(current)) s.updateSettings({ extensionSearchEngines: next });
}
