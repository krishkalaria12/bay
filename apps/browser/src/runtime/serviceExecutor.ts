import { setSharing, dismissAsk } from "../telemetry/client";
import type { BrowserStore } from "../store/browser";
import type { ServiceCommand, ServiceResult } from "./serviceCommands";
import { invalidCommand, requireCommandSpace, requireCommandTab, requireCommandWindow } from "./commandValidation";
import { live, markRead, markUnread, moveFolder, setLiveView, updateCalendarSettings, updateConfig, updateFolder } from "../live/store";
import { deleteLiveFolder, newLiveFolder, openLiveItem, refreshFolder } from "../live/engine";
import { connectCalendar, refreshCalendar, setCalendarHidden, useCalendar } from "../live/calendar";
import { dismiss } from "../live/alerts";
import { groupCallInStore, joinMeetingInStore } from "../live/meetingGroups";
import { joinLink } from "../live/meetings";
import { connectBitbucket, connectConfluence, connectGithub, connectNotion, disconnect, startGithubDeviceFlow, type DeviceFlow } from "../live/sources";
import { connectGoogleDrive } from "../live/googleAuth";
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
  switch (command.action) {
    case "liveCreate":
      publicWindow(command.args[0]);
      return await newLiveFolder(...command.args, browser);
    case "liveUpdate":
      folder(command.args[0]);
      updateFolder(...command.args);
      break;
    case "liveRemove":
      folder(command.args[0]);
      deleteLiveFolder(...command.args, browser);
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
      return await openLiveItem(w, id, item, { background }, browser);
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
