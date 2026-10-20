import type { BrowserStore } from "../store/browser";
import { executeLocationCommand, parseLocationCommand, type LocationCommand, type LocationCommandEffects } from "./locationCommands";
import { executeTabCommand, parseTabCommand, TAB_COMMAND_METHODS, type TabCommand } from "./tabCommands";
import { executeWindowCommand, parseWindowCommand, WINDOW_COMMAND_METHODS, type WindowCommand } from "./windowCommands";
import { executeSettingsCommand, parseSettingsCommand, SETTINGS_COMMAND_METHODS, type SettingsCommand } from "./settingsCommands";

export type BrowserCommand = LocationCommand | TabCommand | WindowCommand | SettingsCommand;
export type BrowserCommandValue<C extends BrowserCommand> = C extends { method: "createWindow" | "newTab" | "addCustomEngine" }
  ? string
  : C extends { method: "duplicateTab" | "moveTabsToWindow" }
    ? string | null
    : null;

export function browserCommandResultKind(method: BrowserCommand["method"]): "id" | "optionalId" | "none" {
  if (method === "createWindow" || method === "newTab" || method === "addCustomEngine") return "id";
  if (method === "duplicateTab" || method === "moveTabsToWindow") return "optionalId";
  return "none";
}

export function parseBrowserCommand(value: unknown): BrowserCommand {
  const method = value && typeof value === "object" && "method" in value ? value.method : undefined;
  if (typeof method === "string") {
    if ((TAB_COMMAND_METHODS as readonly string[]).includes(method)) return parseTabCommand(value);
    if ((WINDOW_COMMAND_METHODS as readonly string[]).includes(method)) return parseWindowCommand(value);
    if (SETTINGS_COMMAND_METHODS.includes(method)) return parseSettingsCommand(value);
  }
  return parseLocationCommand(value);
}

export function executeBrowserCommand(store: BrowserStore, command: BrowserCommand, effects?: LocationCommandEffects): string | null {
  if ((TAB_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeTabCommand(store, command as TabCommand, effects);
  if ((WINDOW_COMMAND_METHODS as readonly string[]).includes(command.method)) return executeWindowCommand(store, command as WindowCommand, effects);
  if (SETTINGS_COMMAND_METHODS.includes(command.method)) return executeSettingsCommand(store, command as SettingsCommand);
  return executeLocationCommand(store, command as LocationCommand, effects);
}
