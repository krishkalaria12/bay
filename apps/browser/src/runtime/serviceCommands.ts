import type { JsonInput, JsonValue } from "../lib/json";
import { lookup } from "@bay/core";
import * as v from "valibot";
import type * as sync from "../sync/engine";
import { commandBoolean as boolean, commandFields, commandIds, commandNullableText, commandObject, commandText, invalidCommand } from "./commandValidation";
import type { CalendarSettings, LiveConfig } from "../activity/activityStore";
import type { LiveFolder, LiveFolderKind, LiveSourceId } from "../activity/types";
import type { CaptureSource, LibraryMedia } from "../components/library/model";
import type { ClearRequest } from "../components/settings/workflows";

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
  tidyTabs: [string];
  downloadRename: [string, string];
  downloadUndo: [string, string];
  localFileOpen: [string, string, string];
  localFilePeek: [string, string, string];
  localFileClose: [string, string, string];
  localFileReconnect: [string];
  settingsUnlock: [string];
  settingsPasswords: [string];
  settingsImportCsv: [string];
  settingsExportCsv: [string];
  settingsClearData: [string, ClearRequest];
  librarySaveMedia: [string, { path: string; width: number; height: number }, string, CaptureSource | null];
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

const filename = (value: JsonInput) => {
  const name = commandText(value, 4096);

  if (/[\\/\0]/.test(name) || name === "." || name === "..") return invalidCommand("invalid download filename");

  return name;
};

const relativePath = (value: JsonInput) => {
  const path = commandText(value, 16384, true);

  if (/^[\\/]|^[a-z]:|\0/i.test(path) || path.split(/[\\/]/).includes("..")) return invalidCommand("invalid relative file path");

  return path;
};

const number = (value: JsonInput, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!v.is(v.number(), value) || !Number.isFinite(value) || value < 0 || value > maximum) return invalidCommand("invalid service number");

  return value;
};

const dimension = (value: JsonInput) => {
  const size = number(value, 1000000);

  if (size === 0) return invalidCommand("empty image dimension");

  return size;
};

const mediaImage = (value: JsonInput) => {
  const image = commandObject(value, ["path", "width", "height"]);
  const path = commandText(image.path, 16384);

  if (!/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) || path.includes("\0")) return invalidCommand("invalid media path");

  return { path, width: dimension(image.width), height: dimension(image.height) };
};

const captureSource = (value: JsonInput): CaptureSource | null => {
  if (value === null) return null;
  const source = commandObject(value, ["url", "title", "clip", "viewportWidth", "viewportHeight", "profileId"]);

  const result: CaptureSource = {
    url: commandText(source.url, 65536, true),
    title: commandText(source.title, 16384, true),
  };

  if (source.profileId !== undefined) result.profileId = commandText(source.profileId, 4096, true);

  if (source.viewportWidth !== undefined) result.viewportWidth = dimension(source.viewportWidth);

  if (source.viewportHeight !== undefined) result.viewportHeight = dimension(source.viewportHeight);

  if (source.clip !== undefined) {
    if (!Array.isArray(source.clip) || source.clip.length !== 4) return invalidCommand("invalid capture clip");
    const clip = source.clip.map((part) => number(part));

    if (!clip[2] || !clip[3]) return invalidCommand("empty capture clip");
    result.clip = clip;
  }

  return result;
};

const clearRequest = (value: JsonInput) => {
  const request = commandObject(value, ["since", "history", "siteData"]);

  const result: ClearRequest = { history: boolean(request.history), siteData: boolean(request.siteData) };

  if (request.since !== undefined) return { ...result, since: number(request.since) };

  return result;
};

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
  tidyTabs: [text],
  downloadRename: [text, filename],
  downloadUndo: [text, filename],
  localFileOpen: [text, text, relativePath],
  localFilePeek: [text, text, relativePath],
  localFileClose: [text, text, relativePath],
  localFileReconnect: [text],
  settingsUnlock: [text],
  settingsPasswords: [text],
  settingsImportCsv: [text],
  settingsExportCsv: [text],
  settingsClearData: [text, clearRequest],
  librarySaveMedia: [text, mediaImage, (value) => commandText(value, 16384, true), captureSource],
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

  if (action === "calendarConnect" || action === "localFileReconnect" || action === "settingsUnlock") return boolean(value);

  if (action === "settingsPasswords") {
    if (value === null) return null;
    const o = commandObject(value, ["passwords", "never"]);

    if (!Array.isArray(o.passwords) || o.passwords.length > 10000 || !Array.isArray(o.never) || o.never.length > 10000)
      return invalidCommand("invalid password metadata result");

    return {
      passwords: o.passwords.map((value) => {
        const item = commandObject(value, ["origin", "username", "created", "modified"]);

        return {
          origin: commandText(item.origin, 65536),
          username: commandText(item.username, 16384, true),
          created: number(item.created),
          modified: number(item.modified),
        };
      }),
      never: o.never.map((origin) => commandText(origin, 65536)),
    };
  }

  if (action === "settingsImportCsv") {
    const o = commandObject(value, ["kind", "saved", "reason"]);
    const kind = choice(o.kind, ["imported", "cancelled", "unavailable", "failed"]);

    if (kind === "imported" && Object.keys(o).length === 2) return { kind, saved: number(o.saved, 1000000) };

    if (kind === "failed" && Object.keys(o).length === 2) return { kind, reason: commandText(o.reason, 4096) };

    if ((kind === "cancelled" || kind === "unavailable") && Object.keys(o).length === 1) return { kind };

    return invalidCommand("invalid password import outcome");
  }

  if (action === "settingsExportCsv") {
    const o = commandObject(value, ["status", "path"]);
    const status = choice(o.status, ["succeeded", "cancelled", "writeFailed", "reauthFailed", "inProgress"]);

    if (o.path !== undefined) return { status, path: commandText(o.path, 16384) };

    return { status };
  }

  if (action === "settingsClearData") {
    const o = commandObject(value, ["history", "engine"]);

    return { history: boolean(o.history), engine: choice(o.engine, ["none", "cleared", "failed"]) };
  }

  if (action === "librarySaveMedia") {
    if (value === null) return null;
    const o = commandObject(value, ["id", "path", "width", "height", "name", "createdAt", "source"]);
    const image = mediaImage({ path: o.path ?? null, width: o.width ?? null, height: o.height ?? null });

    const media: LibraryMedia = {
      ...image,
      id: text(o.id),
      name: commandText(o.name, 16384, true),
      createdAt: number(o.createdAt),
    };

    if (o.source !== undefined) {
      const source = captureSource(o.source);

      if (source === null) return invalidCommand("invalid media source");
      media.source = source;
    }

    return media;
  }

  if (action === "downloadRename" || action === "downloadUndo") return value === null ? null : text(value);

  if (action === "tidyTabs") {
    const o = commandObject(value, ["kind", "groups", "moved", "loose", "source"]);
    const kind = choice(o.kind, ["tidied", "nothing", "gone", "busy"]);

    if (kind === "gone" || kind === "busy") {
      if (Object.keys(o).length !== 1) return invalidCommand("unexpected tidy result fields");

      return { kind };
    }

    const loose = commandIds(o.loose);

    if (kind === "nothing") {
      if (Object.keys(o).length !== 2) return invalidCommand("unexpected tidy result fields");

      return { kind, loose };
    }

    if (Object.keys(o).length !== 5) return invalidCommand("invalid tidy result fields");

    const count = (value: JsonInput) => {
      if (!v.is(v.number(), value) || !Number.isSafeInteger(value) || value < 0 || value > 1000000) return invalidCommand("invalid tidy result count");

      return value;
    };

    return { kind, loose, groups: count(o.groups), moved: count(o.moved), source: choice(o.source, ["model", "site"]) };
  }

  if (action === "localFileOpen" || action === "localFilePeek") {
    const o = commandObject(value, ["status", "path", "name", "kind", "url", "browserReadable"]);
    choice(o.status, ["available", "missing", "inaccessible"]);

    for (const key of ["path", "name", "url"]) if (o[key] !== undefined) commandText(o[key], 16384, true);

    if (o.kind !== undefined) choice(o.kind, ["file", "folder"]);

    if (o.browserReadable !== undefined) boolean(o.browserReadable);

    return o;
  }

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
