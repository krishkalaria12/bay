import type { BrowserStore } from "../store/browser";
import { commandObject, commandText, commandTimestamp, commandUrl, invalidCommand, requireCommandSpace } from "./commandValidation";

export type HistoryCommand = { method: "removeHistory"; spaceId: string; urls: string[] } | { method: "clearHistory"; spaceId: string; since?: number };

export const HISTORY_COMMAND_METHODS = ["removeHistory", "clearHistory"] as const;

const MAX_URLS = 10_000;
function urls(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_URLS) return invalidCommand("invalid history urls");
  return Array.from(value, (url) => commandUrl(url));
}

export function parseHistoryCommand(value: unknown): HistoryCommand {
  const c = commandObject(value);
  switch (c.method) {
    case "removeHistory":
      commandObject(c, ["method", "spaceId", "urls"]);
      return { method: c.method, spaceId: commandText(c.spaceId), urls: urls(c.urls) };
    case "clearHistory":
      commandObject(c, ["method", "spaceId", "since"]);
      return { method: c.method, spaceId: commandText(c.spaceId), ...(c.since !== undefined ? { since: commandTimestamp(c.since) } : {}) };
    default:
      return invalidCommand("unknown history command");
  }
}

export function executeHistoryCommand(store: BrowserStore, command: HistoryCommand): null {
  const s = store.getState();
  requireCommandSpace(s, command.spaceId);
  if (command.method === "removeHistory") s.removeHistory(command.spaceId, command.urls);
  else s.clearHistory(command.spaceId, command.since);
  return null;
}
