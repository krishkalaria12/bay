import type * as sync from "../sync/engine";
import { commandBoolean as boolean, commandFields, commandIds, commandNullableText, commandObject, commandText, invalidCommand } from "./commandValidation";
import type { CalendarSettings, LiveConfig } from "../live/store";
import type { LiveFolder, LiveFolderKind, LiveSourceId } from "../live/types";

export type ServiceArgs = {
  liveCreate: [string, LiveFolderKind];
  liveUpdate: [string, Partial<Pick<LiveFolder, "name" | "icon" | "collapsed" | "sources" | "filters">>];
  liveRemove: [string];
  liveMove: [string, -1 | 1];
  liveRead: [string, string[] | null];
  liveUnread: [string, string];
  liveView: ["expandedStacks" | "showAll", string, boolean];
  liveConfig: [Partial<LiveConfig>];
  liveRefresh: [string];
  liveOpen: [string, string, string, boolean];
  liveConnect: [LiveSourceId, string[]];
  liveDisconnect: [LiveSourceId];
  githubStart: [string];
  githubWait: [string];
  githubCancel: [string];
  googleConnect: [string, string, string];
  calendarSettings: [Partial<CalendarSettings>];
  calendarRefresh: [];
  calendarConnect: [];
  calendarHidden: [string, boolean];
  alertDismiss: [string];
  alertJoin: [string, string, boolean];
  meetingGroup: [string, string | null];
  telemetrySetSharing: [boolean, "settings" | "onboarding" | "ask"];
  telemetryDismissAsk: [];
  syncNow: [];
  setSyncFolder: [string];
  turnOnSync: [string];
  enterRecoveryPhrase: [string, string];
  stopSync: [{ deleteData?: boolean }];
  setTypeSynced: [sync.DataType, boolean];
  setProfileSynced: [string, boolean];
  addRemoteProfile: [string];
  folderInfo: [string | null];
};
export type ServiceAction = keyof ServiceArgs;
export type ServiceCommand = { [K in ServiceAction]: { method: "serviceAction"; action: K; args: ServiceArgs[K] } }[ServiceAction];
export type ServiceResult = null | boolean | string | { [key: string]: unknown };
const text = (v: unknown) => commandText(v, 4096);
const nullable = (v: unknown) => (v === null ? null : text(v));
const choice = <T extends string>(v: unknown, choices: readonly T[]): T =>
  typeof v === "string" && choices.includes(v as T) ? (v as T) : invalidCommand("invalid service option");
const source = (v: unknown) => choice(v, ["github", "bitbucket", "notion", "confluence", "gdrive"] as const);
const folderPatch = (v: unknown) =>
  commandFields(commandObject(v, ["name", "icon", "collapsed", "sources", "filters"]), {
    name: (v) => commandText(v, 1024, true),
    icon: commandNullableText,
    collapsed: boolean,
    sources: (v) => commandIds(v).map(source),
    filters: (v) => {
      const o = commandObject(v, ["authored", "reviewRequests"]);
      return { authored: boolean(o.authored), reviewRequests: boolean(o.reviewRequests) };
    },
  });
const configText = (v: unknown) => commandText(v, 4096, true);
const configPatch = (v: unknown) =>
  commandFields(commandObject(v, ["githubClientId", "bitbucketUser", "confluenceSite", "confluenceEmail", "googleClientId"]), {
    githubClientId: configText,
    bitbucketUser: configText,
    confluenceSite: configText,
    confluenceEmail: configText,
    googleClientId: configText,
  });
const calendarPatch = (v: unknown) =>
  commandFields(commandObject(v, ["alertLead", "alertCondition", "showPreview", "showTimeToNext", "hiddenCalendarIds", "prompted"]), {
    alertLead: (v) => choice(v, ["never", "start", "1", "2", "3", "5", "10"]),
    alertCondition: (v) => choice(v, ["always", "activeOnly"] as const),
    showPreview: boolean,
    showTimeToNext: boolean,
    hiddenCalendarIds: commandIds,
    prompted: boolean,
  });
const readers: Record<ServiceAction, ((v: unknown) => unknown)[]> = {
  liveCreate: [text, (v) => choice(v, ["pullRequests", "documents"])],
  liveUpdate: [text, folderPatch],
  liveRemove: [text],
  liveMove: [text, (v) => (v === -1 || v === 1 ? v : invalidCommand("invalid live folder move"))],
  liveRead: [text, (v) => (v === null ? null : commandIds(v))],
  liveUnread: [text, text],
  liveView: [(v) => choice(v, ["expandedStacks", "showAll"]), text, boolean],
  liveConfig: [configPatch],
  liveRefresh: [text],
  liveOpen: [text, text, text, boolean],
  liveConnect: [
    source,
    (v) => {
      if (!Array.isArray(v) || v.length > 3) return invalidCommand("invalid account arguments");
      return v.map((v) => commandText(v, 65536));
    },
  ],
  liveDisconnect: [source],
  githubStart: [text],
  githubWait: [text],
  githubCancel: [text],
  googleConnect: [text, text, (v) => commandText(v, 65536)],
  calendarSettings: [calendarPatch],
  calendarRefresh: [],
  calendarConnect: [],
  calendarHidden: [text, boolean],
  alertDismiss: [text],
  alertJoin: [text, text, boolean],
  meetingGroup: [text, nullable],
  telemetrySetSharing: [boolean, (v) => choice(v, ["settings", "onboarding", "ask"])],
  telemetryDismissAsk: [],
  syncNow: [],
  setSyncFolder: [text],
  turnOnSync: [text],
  enterRecoveryPhrase: [text, text],
  stopSync: [(v) => commandFields(commandObject(v, ["deleteData"]), { deleteData: boolean })],
  setTypeSynced: [(v) => choice(v, ["bookmarks", "history", "tabs", "pinned", "passwords", "settings"]), boolean],
  setProfileSynced: [text, boolean],
  addRemoteProfile: [text],
  folderInfo: [nullable],
};
export const SERVICE_COMMAND_ACTIONS = Object.keys(readers) as ServiceAction[];
export function parseServiceCommand(value: unknown): ServiceCommand {
  const o = commandObject(value, ["method", "action", "args"]);
  if (o.method !== "serviceAction" || typeof o.action !== "string" || !Object.hasOwn(readers, o.action)) return invalidCommand("invalid service action");
  const action = o.action as ServiceAction;
  if (!Array.isArray(o.args) || o.args.length !== readers[action].length) return invalidCommand("invalid service arguments");
  const args = readers[action].map((read, i) => read((o.args as unknown[])[i]));
  if (action === "liveConnect") {
    const sizes: Record<string, number> = { github: 1, bitbucket: 2, notion: 1, confluence: 3 };
    if ((args[1] as string[]).length !== sizes[args[0] as string]) return invalidCommand("invalid account arguments");
  }
  return { method: "serviceAction", action, args } as ServiceCommand;
}
/** Validate requester-only data independently from the shared snapshot. */
export function parseServiceResult(value: unknown, action: ServiceAction): ServiceResult {
  if (["liveCreate", "liveOpen", "meetingGroup", "addRemoteProfile"].includes(action)) return value === null ? null : text(value);
  if (action === "calendarConnect") return boolean(value);
  if (action === "githubStart") {
    const o = commandObject(value, ["id", "userCode", "verificationUri", "expiresAt"]);
    if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt)) return invalidCommand("invalid account result");
    return { id: text(o.id), userCode: text(o.userCode), verificationUri: text(o.verificationUri), expiresAt: o.expiresAt };
  }
  if (action === "turnOnSync" || action === "enterRecoveryPhrase") {
    const o = commandObject(value, ["ok", "error", "count", "word"]);
    if (o.ok === true && Object.keys(o).length === 1) return { ok: true };
    if (typeof o.error !== "string" || o.error.length > 4096 || o.ok !== undefined) return invalidCommand("invalid sync result");
    if (o.count !== undefined && (typeof o.count !== "number" || !Number.isSafeInteger(o.count) || o.count < 0 || o.count > 10000))
      return invalidCommand("invalid phrase count");
    if (o.word !== undefined) commandText(o.word, 4096);
    return o;
  }
  if (action === "folderInfo") {
    if (value === null) return null;
    const o = commandObject(value, ["path", "defaultPath", "iCloudAvailable", "inICloud", "exists", "writable", "hasSyncData"]);
    text(o.path);
    text(o.defaultPath);
    for (const k of ["iCloudAvailable", "inICloud", "exists", "writable", "hasSyncData"]) boolean(o[k]);
    return o;
  }
  return value === null ? null : invalidCommand("unexpected service result");
}
