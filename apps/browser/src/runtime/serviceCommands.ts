import type { JsonInput, JsonValue } from "../lib/json";
import { lookup } from "@bay/core";
import * as v from "valibot";
import type * as sync from "../sync/engine";
import { commandBoolean as boolean, commandFields, commandIds, commandNullableText, commandObject, commandText, invalidCommand } from "./commandValidation";
import type { CalendarSettings, LiveConfig } from "../activity/activityStore";
import type { LiveFolder, LiveFolderKind, LiveSourceId } from "../activity/types";

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

/** What a service action answers with: JSON, as the runtime carries it. */
export type ServiceValue = JsonValue;

export type ServiceResult = null | boolean | string | { [key: string]: JsonValue };

const text = (value: JsonInput) => commandText(value, 4096);
const nullable = (value: JsonInput) => (value === null ? null : text(value));

// SAFETY: the check above established that the value is one of the choices.
const choice = <T extends string>(value: JsonInput, choices: readonly T[]): T =>
  v.is(v.string(), value) && choices.includes(value as T) ? (value as T) : invalidCommand("invalid service option");

const source = (value: JsonInput) => choice(value, ["github", "bitbucket", "notion", "confluence", "gdrive"] as const);

const folderPatch = (value: JsonInput) =>
  commandFields(commandObject(value, ["name", "icon", "collapsed", "sources", "filters"]), {
    name: (name) => commandText(name, 1024, true),
    icon: commandNullableText,
    collapsed: boolean,
    sources: (sources) => commandIds(sources).map(source),
    filters: (filters) => {
      const o = commandObject(filters, ["authored", "reviewRequests"]);

      return { authored: boolean(o.authored), reviewRequests: boolean(o.reviewRequests) };
    },
  });

const configText = (value: JsonInput) => commandText(value, 4096, true);

const configPatch = (value: JsonInput) =>
  commandFields(commandObject(value, ["githubClientId", "bitbucketUser", "confluenceSite", "confluenceEmail", "googleClientId"]), {
    githubClientId: configText,
    bitbucketUser: configText,
    confluenceSite: configText,
    confluenceEmail: configText,
    googleClientId: configText,
  });

const calendarPatch = (value: JsonInput) =>
  commandFields(commandObject(value, ["alertLead", "alertCondition", "showPreview", "showTimeToNext", "hiddenCalendarIds", "prompted"]), {
    alertLead: (lead) => choice(lead, ["never", "start", "1", "2", "3", "5", "10"]),
    alertCondition: (condition) => choice(condition, ["always", "activeOnly"] as const),
    showPreview: boolean,
    showTimeToNext: boolean,
    hiddenCalendarIds: commandIds,
    prompted: boolean,
  });

const readers: Record<ServiceAction, ((value: JsonInput) => ServiceValue)[]> = {
  liveCreate: [text, (kind) => choice(kind, ["pullRequests", "documents"])],
  liveUpdate: [text, folderPatch],
  liveRemove: [text],
  liveMove: [text, (delta) => (delta === -1 || delta === 1 ? delta : invalidCommand("invalid live folder move"))],
  liveRead: [text, (ids) => (ids === null ? null : commandIds(ids))],
  liveUnread: [text, text],
  liveView: [(view) => choice(view, ["expandedStacks", "showAll"]), text, boolean],
  liveConfig: [configPatch],
  liveRefresh: [text],
  liveOpen: [text, text, text, boolean],
  liveConnect: [
    source,
    (accounts) => {
      if (!Array.isArray(accounts) || accounts.length > 3) return invalidCommand("invalid account arguments");

      return accounts.map((account) => commandText(account, 65536));
    },
  ],
  liveDisconnect: [source],
  githubStart: [text],
  githubWait: [text],
  githubCancel: [text],
  googleConnect: [text, text, (secret) => commandText(secret, 65536)],
  calendarSettings: [calendarPatch],
  calendarRefresh: [],
  calendarConnect: [],
  calendarHidden: [text, boolean],
  alertDismiss: [text],
  alertJoin: [text, text, boolean],
  meetingGroup: [text, nullable],
  telemetrySetSharing: [boolean, (sharing) => choice(sharing, ["settings", "onboarding", "ask"])],
  telemetryDismissAsk: [],
  syncNow: [],
  setSyncFolder: [text],
  turnOnSync: [text],
  enterRecoveryPhrase: [text, text],
  stopSync: [(options) => commandFields(commandObject(options, ["deleteData"]), { deleteData: boolean })],
  setTypeSynced: [(type) => choice(type, ["bookmarks", "history", "tabs", "pinned", "passwords", "settings"]), boolean],
  setProfileSynced: [text, boolean],
  addRemoteProfile: [text],
  folderInfo: [nullable],
};

// SAFETY: the checks above established this shape.
export const SERVICE_COMMAND_ACTIONS = Object.keys(readers) as ServiceAction[];

export function parseServiceCommand(value: JsonInput): ServiceCommand {
  const o = commandObject(value, ["method", "action", "args"]);

  if (o.method !== "serviceAction" || !v.is(v.string(), o.action) || !Object.hasOwn(readers, o.action)) return invalidCommand("invalid service action");
  // SAFETY: the checks above established this shape.
  const action = o.action as ServiceAction;

  const args = o.args;

  if (!Array.isArray(args) || args.length !== readers[action].length) return invalidCommand("invalid service arguments");
  // SAFETY: the checks above established this shape.
  const read = readers[action].map((reader, index) => reader(args[index]));

  if (action === "liveConnect") {
    const sizes = { github: 1, bitbucket: 2, notion: 1, confluence: 3 } satisfies Record<string, number>;

    // SAFETY: the checks above established this shape.
    if ((read[1] as string[]).length !== (lookup(sizes, read[0] as string) ?? 0)) return invalidCommand("invalid account arguments");
  }

  // SAFETY: the checks above established this shape.
  return { method: "serviceAction", action, args: read } as ServiceCommand;
}

/** Validate requester-only data independently from the shared snapshot. */
export function parseServiceResult(value: JsonInput, action: ServiceAction): ServiceResult {
  if (["liveCreate", "liveOpen", "meetingGroup", "addRemoteProfile"].includes(action)) return value === null ? null : text(value);

  if (action === "calendarConnect") return boolean(value);

  if (action === "githubStart") {
    const o = commandObject(value, ["id", "userCode", "verificationUri", "expiresAt"]);

    if (!v.is(v.number(), o.expiresAt) || !Number.isFinite(o.expiresAt)) return invalidCommand("invalid account result");

    return { id: text(o.id), userCode: text(o.userCode), verificationUri: text(o.verificationUri), expiresAt: o.expiresAt };
  }

  if (action === "turnOnSync" || action === "enterRecoveryPhrase") {
    const o = commandObject(value, ["ok", "error", "count", "word"]);

    if (o.ok === true && Object.keys(o).length === 1) return { ok: true };

    if (!v.is(v.string(), o.error) || o.error.length > 4096 || o.ok !== undefined) return invalidCommand("invalid sync result");

    if (o.count !== undefined && (!v.is(v.number(), o.count) || !Number.isSafeInteger(o.count) || o.count < 0 || o.count > 10000))
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
