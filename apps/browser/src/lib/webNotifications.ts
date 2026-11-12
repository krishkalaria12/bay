// The app's notifications: the ones a site asks for, and the ones the app posts.
//
// The work is in lib/notificationService.ts. This is where the app reaches it.
import type { WebNotification } from "@bay/chromium";
import type { NotificationResponse } from "@bay/desktop";
import * as Effect from "effect/Effect";
import { runDesktop } from "../effect/runtime";
import { useBrowser } from "../store/browserStore";
import { focus, switchToTab } from "./actions";
import { NotificationService, shownNotifications } from "./notificationService";
import { webviews } from "./webviews";

/** Shows the notification a site asked for, if the app may show it. */
export function showWebNotification(tabId: string, n: WebNotification): void {
  void runDesktop(
    Effect.gen(function* () {
      const notifications = yield* NotificationService;

      yield* notifications.show(tabId, n);
    }),
  );
}

/** Takes down the notifications a page asked for. */
export function closeWebNotification(engineId: string): void {
  void runDesktop(
    Effect.gen(function* () {
      const notifications = yield* NotificationService;

      yield* notifications.close(engineId);
    }),
  );
}

/**
 * What the user did with a notification: it opens the page, or tells the page.
 *
 * The answer is read at once: the native side waits for it, and the page has to hear it now.
 */
export function handleWebNotificationResponse(response: NotificationResponse): boolean {
  if (!response.id.startsWith("web:")) return false;

  // SAFETY: data comes from the notification service's own postNotification data field, which sets engineId as a string.
  const engineId = (response.data as { engineId?: string } | null)?.engineId;

  if (engineId && shownNotifications.get(response.id) === engineId) shownNotifications.delete(response.id);

  const tab = response.tabId ? useBrowser.getState().tabs[response.tabId] : undefined;

  if (!tab) return true;

  if (response.action === "click") {
    switchToTab(tab.id);
    focus(tab.windowId);
  }

  if (engineId) webviews.get(tab.id)?.notificationAction(engineId, response.action);

  return true;
}

/** Whether the app may show notifications, asking the user once if it may not. */
export async function ensureNotificationPermission(windowId?: string): Promise<boolean> {
  return runDesktop(
    Effect.gen(function* () {
      const notifications = yield* NotificationService;

      return yield* notifications.ensurePermission(windowId);
    }),
  );
}
