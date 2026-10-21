import { SPACE_SWATCHES } from "../lib/spaceSwatches";
import type { BrowserStore } from "../store/browser";
import type { Space, SpaceColor, SpaceTheme } from "../store/types";
import {
  commandBoolean,
  commandFields,
  commandIds,
  commandObject,
  commandText,
  invalidCommand,
  requireCommandSpace,
  type CommandReaders,
} from "./commandValidation";

// "app": the space follows the app's clean up setting again (the stored field is removed).
export type UserSpacePatch = Partial<Pick<Space, "name" | "color" | "icon" | "theme" | "followSite" | "folded">> & {
  cleanUpAfterHours?: number | null | "app";
};
export type UserCreateSpaceOptions = { name: string; color?: SpaceColor; theme?: SpaceTheme | null; icon?: string | null; shareWith?: string | null };
export type SpaceCommand =
  | { method: "createSpace"; options: UserCreateSpaceOptions }
  | { method: "updateSpace"; spaceId: string; patch: UserSpacePatch }
  | { method: "deleteSpace" | "setDefaultSpace"; spaceId: string }
  | { method: "reorderSpaces"; spaceIds: string[] };

export const SPACE_COMMAND_METHODS = ["createSpace", "updateSpace", "deleteSpace", "reorderSpaces", "setDefaultSpace"] as const;

const MAX_CLEAN_UP_HOURS = 24 * 365;
const name = (value: unknown) => commandText(value, 1024, true);
const icon = (value: unknown) => (value === null ? null : commandText(value, 1024, true));
const color = (value: unknown): SpaceColor =>
  typeof value === "string" && Object.hasOwn(SPACE_SWATCHES, value) ? (value as SpaceColor) : invalidCommand("invalid space color");
const fraction = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : invalidCommand("invalid theme value");
function theme(value: unknown): SpaceTheme | null {
  if (value === null) return null;
  const t = commandObject(value, ["colors", "intensity", "grain"]);
  if (!Array.isArray(t.colors) || t.colors.length < 1 || t.colors.length > 3) return invalidCommand("invalid theme colors");
  const colors = Array.from(t.colors, (c) => (typeof c === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c) ? c : invalidCommand("invalid theme color")));
  return { colors, intensity: fraction(t.intensity), grain: fraction(t.grain) };
}
function cleanUpHours(value: unknown): number | null | "app" {
  if (value === null || value === "app") return value;
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_CLEAN_UP_HOURS ? value : invalidCommand("invalid clean up hours");
}

export function parseSpaceCommand(value: unknown): SpaceCommand {
  const c = commandObject(value);
  const fields = (...allowed: string[]) => commandObject(c, ["method", ...allowed]);
  const spaceId = () => commandText(c.spaceId);
  switch (c.method) {
    case "createSpace": {
      fields("options");
      const o = commandObject(c.options, ["name", "color", "theme", "icon", "shareWith"]);
      const readers: CommandReaders<Omit<UserCreateSpaceOptions, "name">> = {
        color,
        theme,
        icon,
        shareWith: (v) => (v === null ? null : commandText(v)),
      };
      return { method: c.method, options: { name: name(o.name), ...commandFields(o, readers) } };
    }
    case "updateSpace": {
      fields("spaceId", "patch");
      const p = commandObject(c.patch, ["name", "color", "icon", "theme", "followSite", "folded", "cleanUpAfterHours"]);
      const readers: CommandReaders<UserSpacePatch> = {
        name,
        color,
        icon,
        theme,
        followSite: commandBoolean,
        folded: commandBoolean,
        cleanUpAfterHours: cleanUpHours,
      };
      return { method: c.method, spaceId: spaceId(), patch: commandFields(p, readers) };
    }
    case "deleteSpace":
    case "setDefaultSpace":
      fields("spaceId");
      return { method: c.method, spaceId: spaceId() };
    case "reorderSpaces":
      fields("spaceIds");
      return { method: c.method, spaceIds: commandIds(c.spaceIds) };
    default:
      return invalidCommand("unknown space command");
  }
}

export function executeSpaceCommand(store: BrowserStore, command: SpaceCommand): string | null {
  const s = store.getState();
  switch (command.method) {
    case "createSpace": {
      const shareWith = command.options.shareWith;
      if (shareWith) requireCommandSpace(s, shareWith);
      return s.createSpace(command.options);
    }
    case "updateSpace": {
      requireCommandSpace(s, command.spaceId);
      const { cleanUpAfterHours, ...patch } = command.patch;
      if (cleanUpAfterHours === undefined) s.updateSpace(command.spaceId, patch);
      else s.updateSpace(command.spaceId, { ...patch, cleanUpAfterHours: cleanUpAfterHours === "app" ? undefined : cleanUpAfterHours });
      break;
    }
    case "deleteSpace":
      requireCommandSpace(s, command.spaceId);
      if (s.spaceOrder.length <= 1) return invalidCommand("the last space cannot be deleted");
      s.deleteSpace(command.spaceId);
      break;
    case "setDefaultSpace":
      requireCommandSpace(s, command.spaceId);
      s.setDefaultSpace(command.spaceId);
      break;
    case "reorderSpaces":
      for (const id of command.spaceIds) requireCommandSpace(s, id);
      s.reorderSpaces(command.spaceIds);
      break;
  }
  return null;
}
