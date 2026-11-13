import * as Effect from "effect/Effect";
import { runForStore } from "../effect/runtime";
import { LocalFileService } from "../lib/localFileService";
import { DownloadWorkService } from "../lib/downloadWorkService";
import { TidyWorkService } from "../lib/tidyWorkService";
import { engineProfileFor } from "../store/model";
import { executeSettingsAction } from "../components/settings/authorityCommands";
import { LibraryService } from "../components/library/libraryService";
import { parseServiceResult } from "./serviceCommands";
import type { LocalFileAccess } from "@bay/desktop";
import { setSharing, dismissAsk } from "../telemetry/client";
import type { BrowserStore } from "../store/browserStore";
import type { ServiceCommand, ServiceResult } from "./serviceCommands";
import { invalidCommand, requireCommandSpace, requireCommandTab, requireCommandWindow } from "./commandValidation";
import { live, markRead, markUnread, moveFolder, setLiveView, updateCalendarSettings, updateConfig, updateFolder } from "../activity/activityStore";
import { deleteLiveFolder, newLiveFolder, openLiveItem, refreshFolder } from "../activity/activityEngine";
import { connectCalendar, refreshCalendar, setCalendarHidden, useCalendar } from "../activity/calendar";
import { dismiss } from "../activity/meetingAlerts";
import { groupCallInStore, joinMeetingInStore } from "../activity/meetingGroups";
import { joinLink } from "../activity/meetings";
import { connectBitbucket, connectConfluence, connectGithub, connectNotion, disconnect, startGithubDeviceFlow, type DeviceFlow } from "../activity/sources";
import { connectGoogleDrive } from "../activity/googleAuth";
import * as sync from "../sync/engine";

const flows = new Map<string, DeviceFlow>();
let nextFlow = 0;

export function stopServiceCommands() {
  for (const flow of flows.values()) flow.cancel();
  flows.clear();
}

export async function executeServiceCommand(browser: BrowserStore, command: ServiceCommand, isActive: () => boolean = () => true): Promise<ServiceResult> {
  if (!isActive()) throw new Error("Service command owner is stopped");

  const folder = (id: string) => {
    const f = live().folders[id];

    if (!f) return invalidCommand("live folder no longer exists");
    requireCommandSpace(browser.getState(), f.spaceId);

    return f;
  };

  const calendarEvent = (occurrence: string | null) => useCalendar.getState().events.find((e) => e.occurrence === occurrence);

  const publicWindow = (id: string) => {
    const w = requireCommandWindow(browser.getState(), id);

    if (w.incognito) return invalidCommand("service action requires a public window");

    return w;
  };

  const pinInWindow = (windowId: string, pinId: string) => {
    const window = publicWindow(windowId);
    const pin = browser.getState().localFiles[pinId];

    if (!pin || pin.spaceId !== window.spaceId) return invalidCommand("file does not belong to the window's space");
    requireCommandSpace(browser.getState(), pin.spaceId);

    return pin;
  };

  const download = (id: string) => {
    const state = browser.getState();
    const item = state.downloads.find((item) => item.id === id);

    if (!item || !state.spaceOrder.some((id) => engineProfileFor(id, state.spaces) === (item.profile ?? "")))
      return invalidCommand("download no longer exists");

    return item;
  };

  const fileResult = (access: LocalFileAccess): ServiceResult => {
    const result: LocalFileAccess = { status: access.status };

    if (access.path !== undefined) result.path = access.path;

    if (access.name !== undefined) result.name = access.name;

    if (access.kind !== undefined) result.kind = access.kind;

    if (access.url !== undefined) result.url = access.url;

    if (access.browserReadable !== undefined) result.browserReadable = access.browserReadable;

    return result;
  };

  switch (command.action) {
    case "settingsUnlock":
    case "settingsPasswords":
    case "settingsImportCsv":
    case "settingsExportCsv":
    case "settingsClearData": {
      requireCommandSpace(browser.getState(), command.args[0]);
      const result = await executeSettingsAction(browser, command.action, command.args);

      return parseServiceResult(result, command.action);
    }

    case "librarySaveMedia": {
      const [windowId, image, name, source] = command.args;
      const window = publicWindow(windowId);
      const profile = engineProfileFor(window.spaceId, browser.getState().spaces);

      if (source?.profileId !== undefined && source.profileId !== profile) return invalidCommand("capture belongs to another profile");

      const result = await runForStore(
        browser,
        Effect.flatMap(LibraryService, (library) => library.saveMedia(image, name, source ?? undefined)),
      );

      return parseServiceResult(result === null ? null : JSON.parse(JSON.stringify(result)), command.action);
    }

    case "tidyTabs": {
      publicWindow(command.args[0]);

      const outcome = await runForStore(
        browser,
        Effect.flatMap(TidyWorkService, (tidy) => tidy.run({ windowId: command.args[0] })),
      );

      return outcome.kind === "tidied" || outcome.kind === "nothing" ? { ...outcome, loose: [...outcome.loose] } : outcome;
    }

    case "downloadRename": {
      const item = download(command.args[0]);
      const name = command.args[1];

      return runForStore(
        browser,
        Effect.flatMap(DownloadWorkService, (work) => work.rename(item, { filename: name, stem: name, extension: "", basis: "file" })),
      );
    }

    case "downloadUndo": {
      const item = download(command.args[0]);

      return runForStore(
        browser,
        Effect.flatMap(DownloadWorkService, (work) => work.undo(item, command.args[1])),
      );
    }

    case "localFileOpen":
    case "localFilePeek": {
      const [windowId, pinId, relativePath] = command.args;
      pinInWindow(windowId, pinId);

      const access = await runForStore(
        browser,
        Effect.flatMap(LocalFileService, (files) =>
          command.action === "localFileOpen" ? files.open(windowId, pinId, relativePath) : files.peek(windowId, pinId, relativePath),
        ),
      );

      return fileResult(access);
    }

    case "localFileClose": {
      const [windowId, pinId, relativePath] = command.args;
      pinInWindow(windowId, pinId);
      await runForStore(
        browser,
        Effect.flatMap(LocalFileService, (files) => files.close(windowId, pinId, relativePath)),
      );
      break;
    }

    case "localFileReconnect": {
      const pin = browser.getState().localFiles[command.args[0]];

      if (!pin) return invalidCommand("file no longer exists");
      requireCommandSpace(browser.getState(), pin.spaceId);

      return runForStore(
        browser,
        Effect.flatMap(LocalFileService, (files) => files.reconnect(command.args[0])),
      );
    }

    case "liveCreate":
      publicWindow(command.args[0]);

      // The live engine is bound to the store this command came from (runtime/serviceState.ts), so the folders
      // it keeps are the authority's own.
      return await newLiveFolder(...command.args);
    case "liveUpdate":
      folder(command.args[0]);
      updateFolder(...command.args);
      break;
    case "liveRemove":
      folder(command.args[0]);
      deleteLiveFolder(...command.args);
      break;
    case "liveMove":
      folder(command.args[0]);
      moveFolder(...command.args);
      break;
    case "liveRead":
      folder(command.args[0]);
      markRead(command.args[0], command.args[1] ?? undefined);
      break;
    case "liveUnread":
      folder(command.args[0]);
      markUnread(...command.args);
      break;
    case "liveView":
      setLiveView(...command.args);
      break;
    case "liveConfig":
      updateConfig(...command.args);
      break;
    case "liveRefresh":
      folder(command.args[0]);
      await refreshFolder(...command.args);
      break;
    case "liveOpen": {
      const [w, id, itemId, background] = command.args;
      publicWindow(w);
      folder(id);
      const s = live();
      const item = s.items[id]?.find((i) => i.id === itemId) ?? s.completed[id]?.find((i) => i.item.id === itemId)?.item;

      if (!item) return invalidCommand("live item no longer exists");

      return await openLiveItem(w, id, item, { background });
    }

    case "liveConnect": {
      const [id, a] = command.args;

      if (id === "github") await connectGithub(a[0]!);
      else if (id === "bitbucket") await connectBitbucket(a[0]!, a[1]!);
      else if (id === "notion") await connectNotion(a[0]!);
      else if (id === "confluence") await connectConfluence(a[0]!, a[1]!, a[2]!);
      break;
    }

    case "liveDisconnect":
      await disconnect(...command.args);
      break;
    case "githubStart": {
      if (flows.size >= 8) return invalidCommand("too many account requests");
      const flow = await startGithubDeviceFlow(...command.args);
      const id = `flow-${++nextFlow}`;
      flows.set(id, flow);
      void flow.done.catch(() => {});

      return { id, userCode: flow.userCode, verificationUri: flow.verificationUri, expiresAt: flow.expiresAt };
    }

    case "githubWait": {
      const flow = flows.get(command.args[0]);

      if (!flow) return invalidCommand("account request expired");

      try {
        await flow.done;
      } finally {
        flows.delete(command.args[0]);
      }

      break;
    }

    case "githubCancel":
      flows.get(command.args[0])?.cancel();
      flows.delete(command.args[0]);
      break;
    case "googleConnect":
      publicWindow(command.args[0]);
      await connectGoogleDrive(...command.args);
      break;
    case "calendarSettings":
      updateCalendarSettings(...command.args);
      break;
    case "calendarRefresh":
      await refreshCalendar();
      break;
    case "calendarConnect":
      return connectCalendar();
    case "calendarHidden":
      setCalendarHidden(...command.args);
      break;
    case "alertDismiss": {
      const event = calendarEvent(command.args[0]);

      if (event) dismiss(event);
      break;
    }

    case "alertJoin": {
      const [w, id, all] = command.args;
      publicWindow(w);
      const event = calendarEvent(id);
      const link = event && joinLink(event);

      if (event && link) {
        joinMeetingInStore(browser, w, event, link.url, all);
        dismiss(event);
      }

      break;
    }

    case "meetingGroup": {
      const [id, occurrence] = command.args;
      const t = requireCommandTab(browser.getState(), id);
      requireCommandSpace(browser.getState(), t.spaceId);

      return groupCallInStore(browser, id, calendarEvent(occurrence));
    }

    case "telemetrySetSharing":
      setSharing(...command.args);
      break;
    case "telemetryDismissAsk":
      dismissAsk();
      break;
    case "syncNow":
      await sync.syncNow();
      break;
    case "setSyncFolder":
      await sync.setSyncFolder(...command.args);
      break;
    case "turnOnSync":
      return sync.turnOnSync(...command.args);
    case "enterRecoveryPhrase":
      return sync.enterRecoveryPhrase(...command.args);
    case "stopSync":
      await sync.stopSync(...command.args);
      break;
    case "setTypeSynced":
      await sync.setTypeSynced(...command.args);
      break;
    case "setProfileSynced":
      requireCommandSpace(browser.getState(), command.args[0]);
      await sync.setProfileSynced(...command.args);
      break;
    case "addRemoteProfile":
      return sync.addRemoteProfile(...command.args);
    case "folderInfo":
      return sync.folderInfo(...command.args);
  }

  return null;
}
