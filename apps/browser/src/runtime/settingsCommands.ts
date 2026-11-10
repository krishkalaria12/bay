import { isJsonObject, type JsonInput, type JsonObject, type JsonValue } from "../lib/json";
import * as v from "valibot";
import type { EngineInput } from "@bay/core";
import type { BrowserStore } from "../store/browserStore";
import { DEFAULT_SETTINGS, searchEngines, type Settings } from "../store/settings";
import { normalizeExternalLinkRules } from "../lib/externalLinkRules";

export type UserSettingsPatch = Partial<Omit<Settings, "customSearchEngines" | "extensionSearchEngines">>;

export type SettingsCommand =
  | { method: "updateSettings"; patch: UserSettingsPatch }
  | { method: "setTabLayout"; layout: Settings["tabLayout"] }
  | { method: "setSearchEngine" | "removeCustomEngine"; id: string }
  | { method: "addCustomEngine"; input: EngineInput }
  | { method: "updateCustomEngine"; id: string; input: EngineInput };

export const SETTINGS_COMMAND_METHODS = ["updateSettings", "setTabLayout", "setSearchEngine", "removeCustomEngine", "addCustomEngine", "updateCustomEngine"];

class SettingsCommandError extends Error {
  readonly code = "invalid_request";
}

const invalid: (message?: string) => never = (message = "Invalid settings command") => {
  throw new SettingsCommandError(message);
};

/** A command payload is parsed JSON: a plain object of named fields. */
function record(value: JsonInput): JsonObject {
  if (!isJsonObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();

  return value;
}

function fields(value: JsonObject, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function text(value: JsonInput, empty = true): string {
  if (!v.is(v.string(), value) || (!empty && !value.trim()) || value.length > 1_048_576) return invalid();

  return value;
}

function strings(value: JsonInput): string[] {
  if (!Array.isArray(value) || value.length > 10000) return invalid();

  return Array.from(value, (item) => text(item));
}

const choices: Partial<Record<keyof Settings, readonly string[]>> = {
  launchTab: ["newTab", "lastTab"],
  commandBarPreference: ["website", "search"],
  tabLayout: ["sidebar", "top"],
  newTabPosition: ["top", "bottom"],
  sidebarPosition: ["left", "right"],
  bookmarksBar: ["always", "newTab", "never"],
  appearance: ["auto", "light", "dark"],
  density: ["comfortable", "compact"],
  windowMaterial: ["solid", "glass"],
  addressBar: ["toolbar", "sidebar"],
  libraryIn: ["sidebar", "page"],
};

/** Renderer preferences cannot replace engines reported by native extensions or
 * bypass custom-engine validation. Hydration/sync remain authority-only paths.
 */
function patchFrom(value: JsonInput): Partial<Settings> {
  const input = record(value);
  const patch: Record<string, JsonValue> = {};

  for (const [name, item] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, name) || name === "customSearchEngines" || name === "extensionSearchEngines") return invalid();
    // SAFETY: the checks above established this shape.
    const key = name as keyof Settings;
    const fallback = DEFAULT_SETTINGS[key];
    const allowed = choices[key];

    if (allowed) {
      if (!v.is(v.string(), item) || !allowed.includes(item)) invalid();
      patch[key] = item;
    } else if (key === "littleBaySize") {
      if (!Array.isArray(item) || item.length !== 2 || !Array.from(item).every((size) => v.is(v.number(), size) && Number.isFinite(size) && size > 0))
        invalid();
      // SAFETY: the checks above established this shape.
      patch[key] = [...(item as number[])];
    } else if (key === "externalLinkRules") {
      if (!Array.isArray(item)) return invalid();

      for (const value of item) {
        const rule = record(value);
        fields(rule, ["id", "pattern", "sourceApp", "destination"]);
        const destination = record(rule.destination);
        fields(destination, destination.kind === "space" ? ["kind", "spaceId", "syncProfileId"] : ["kind"]);
      }

      const normalized = normalizeExternalLinkRules(item);

      if (normalized.length !== item.length) invalid();
      patch[key] = normalized.map((rule) => ({ ...rule, destination: { ...rule.destination } }));
    } else if (key === "shortcuts" || key === "neverTranslateSites") {
      patch[key] = Object.fromEntries(Object.entries(record(item)).map(([name, values]) => [text(name, false), strings(values)]));
    } else if (Array.isArray(fallback)) patch[key] = strings(item);
    else if (fallback === null || v.is(v.number(), fallback)) {
      if (item === null && (fallback === null || key === "cleanUpInactiveTabsAfterHours")) patch[key] = null;
      else {
        if (!v.is(v.number(), item) || !Number.isFinite(item) || item < 0) invalid();
        patch[key] = item;
      }
    } else if (v.is(v.boolean(), fallback)) {
      if (!v.is(v.boolean(), item)) invalid();
      patch[key] = item;
    } else patch[key] = text(item);
  }

  // SAFETY: the checks above established this shape.
  return patch as Partial<Settings>;
}

function engineInput(value: JsonInput): EngineInput {
  const input = record(value);
  fields(input, ["name", "keyword", "url"]);

  return { name: text(input.name), keyword: text(input.keyword), url: text(input.url) };
}

export function parseSettingsCommand(value: JsonInput): SettingsCommand {
  const c = record(value);

  switch (c.method) {
    case "updateSettings":
      fields(c, ["method", "patch"]);

      return { method: c.method, patch: patchFrom(c.patch) };
    case "setTabLayout":
      fields(c, ["method", "layout"]);

      if (c.layout !== "sidebar" && c.layout !== "top") return invalid();

      return { method: c.method, layout: c.layout };
    case "setSearchEngine":
    case "removeCustomEngine":
      fields(c, ["method", "id"]);

      return { method: c.method, id: text(c.id, false) };
    case "addCustomEngine":
      fields(c, ["method", "input"]);

      return { method: c.method, input: engineInput(c.input) };
    case "updateCustomEngine":
      fields(c, ["method", "id", "input"]);

      return { method: c.method, id: text(c.id, false), input: engineInput(c.input) };
    default:
      return invalid();
  }
}

export function executeSettingsCommand(store: BrowserStore, command: SettingsCommand): string | null {
  const s = store.getState();

  switch (command.method) {
    case "updateSettings":
      if (command.patch.defaultSpaceId !== undefined && !Object.hasOwn(s.spaces, command.patch.defaultSpaceId)) invalid("Space no longer exists");

      if (command.patch.searchEngine !== undefined && !searchEngines(s.settings).some((engine) => engine.id === command.patch.searchEngine))
        invalid("Search engine no longer exists");
      s.updateSettings(command.patch);
      break;
    case "setTabLayout":
      // Choosing the global layout also clears each window's previous override.
      // One store update means clients never see an intermediate mixed layout.
      store.setState({
        windows: Object.fromEntries(Object.entries(s.windows).map(([id, w]) => [id, { ...w, tabLayout: command.layout }])),
        settings: { ...s.settings, tabLayout: command.layout },
      });
      break;
    case "setSearchEngine":
      if (!searchEngines(s.settings).some((engine) => engine.id === command.id)) invalid("Search engine no longer exists");
      s.setSearchEngine(command.id);
      break;
    case "removeCustomEngine":
      s.removeCustomEngine(command.id);
      break;
    case "addCustomEngine": {
      const result = s.addCustomEngine(command.input);

      if ("error" in result) return invalid(result.error);

      return result.id;
    }

    case "updateCustomEngine": {
      const error = s.updateCustomEngine(command.id, command.input);

      if (error) invalid(error);
      break;
    }
  }

  return null;
}
