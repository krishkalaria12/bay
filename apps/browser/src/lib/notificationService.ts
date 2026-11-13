// The app's notifications: the ones a site asks for, and the ones the app posts.
//
// A notification is a job: the permission is asked for once, the icon is fetched with a timeout, and a page that
// closed or was replaced in the meantime gets nothing. The app's own updates are Sparkle's business, not this.
import type { WebNotification } from "@bay/chromium";
import {
  confirm,
  notificationPermission,
  openNotificationSettings,
  postNotification,
  removeNotifications,
  requestNotificationPermission,
  type NotificationOptions,
} from "@bay/desktop";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { ReadBrowser } from "../effect/windowPorts";

import { webviews } from "./webviews";
import { NOTIFICATION_ICON_PIXELS, NOTIFICATION_ICON_TIMEOUT_MS } from "./constants";
import { Diagnostics } from "../effect/ports/diagnostics";

/** The notification could not be shown. */
export class NotificationFailure extends TaggedError("NotificationFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** The native side of the notifications, as the service reaches it. */
export class NotificationEngine extends Context.Service<
  NotificationEngine,
  {
    readonly post: (notification: NotificationOptions) => Effect.Effect<void, NotificationFailure>;
    readonly remove: (ids: string[]) => Effect.Effect<void, NotificationFailure>;
    readonly permission: () => Effect.Effect<PermissionStatus, NotificationFailure>;
    readonly requestPermission: () => Effect.Effect<boolean, NotificationFailure>;
    readonly openSettings: () => Effect.Effect<void, NotificationFailure>;
    readonly ask: (options: ConfirmOptions) => Effect.Effect<{ confirmed: boolean }, NotificationFailure>;
    /** Loads an icon through the page's own request context. */
    readonly downloadIcon: (tabId: string, url: string, pixels: number) => Effect.Effect<string | undefined, NotificationFailure>;
  }
>()("bay/NotificationEngine") {
  static readonly layer = Layer.succeed(NotificationEngine)({
    post: (notification) =>
      Effect.tryPromise({
        try: () => postNotification(notification),
        catch: (cause) => new NotificationFailure({ operation: "notification.post", cause }),
      }),
    remove: (ids) =>
      Effect.tryPromise({
        try: () => removeNotifications(ids),
        catch: (cause) => new NotificationFailure({ operation: "notification.remove", cause }),
      }),
    permission: () =>
      Effect.tryPromise({
        try: () => notificationPermission(),
        catch: (cause) => new NotificationFailure({ operation: "notification.permission", cause }),
      }),
    requestPermission: () =>
      Effect.tryPromise({
        try: () => requestNotificationPermission(),
        catch: (cause) => new NotificationFailure({ operation: "notification.request", cause }),
      }),
    openSettings: () =>
      Effect.tryPromise({
        try: () => openNotificationSettings(),
        catch: (cause) => new NotificationFailure({ operation: "notification.settings", cause }),
      }),
    ask: (options) =>
      Effect.tryPromise({
        try: () => confirm(options),
        catch: (cause) => new NotificationFailure({ operation: "notification.ask", cause }),
      }),
    downloadIcon: (tabId, url, pixels) =>
      Effect.suspend(() => {
        const view = webviews.get(tabId);

        if (!view) return Effect.succeed(undefined);

        return Effect.raceFirst(
          Effect.tryPromise({
            try: () => view.downloadImage(url, pixels),
            catch: (cause) => new NotificationFailure({ operation: "notification.icon", cause }),
          }).pipe(Effect.map((image) => image?.uri ?? undefined)),
          Effect.sleep(Duration.millis(NOTIFICATION_ICON_TIMEOUT_MS)).pipe(Effect.as(undefined)),
        );
      }),
  });
}

/** What the native side says about the app's permission. */
export type PermissionStatus = "granted" | "provisional" | "denied" | "notDetermined";

/** The native side's question to the user. */
export type ConfirmOptions = {
  readonly title: string;
  readonly message: string;
  readonly confirmTitle: string;
  readonly cancelTitle: string;
  readonly windowId?: string;
};

// The notifications the app has shown, by their own id: the engine's id is what a page knows.
export const shownNotifications = new Map<string, string>();

export class NotificationService extends Context.Service<
  NotificationService,
  {
    /** Shows the notification a site asked for, if the app may show it. */
    readonly show: (tabId: string, notification: WebNotification) => Effect.Effect<void>;
    /** Takes down the notifications a page asked for. */
    readonly close: (engineId: string) => Effect.Effect<void>;
    /** Whether the app may show notifications, asking the user once if it may not. */
    readonly ensurePermission: (windowId?: string) => Effect.Effect<boolean>;
  }
>()("bay/NotificationService") {
  static readonly layer = Layer.effect(
    NotificationService,
    Effect.gen(function* () {
      const browser = yield* ReadBrowser;
      const engine = yield* NotificationEngine;
      const diagnostics = yield* Diagnostics;

      // Whether the user has already been asked to open the settings.
      let asked = false;

      const macId = (n: WebNotification) => (n.tag ? `web:${n.origin}#${n.tag}` : `web:${n.id}`);

      // A failure to ask or to show is not the user's problem: it is reported once, and the page carries on.
      const report = (operation: string, cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));

        return diagnostics.report({ operation: { name: operation }, message: error.message, cause: error });
      };

      const ensurePermission = (windowId?: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const denied: PermissionStatus = "denied";
          const status = yield* engine.permission().pipe(Effect.catch(() => Effect.succeed(denied)));

          if (status === "granted" || status === "provisional") return true;

          if (status === "notDetermined") {
            return yield* engine.requestPermission().pipe(Effect.catch(() => Effect.succeed(false)));
          }

          // Ask once before opening the settings.
          if (asked) return false;

          asked = true;

          const answer = yield* engine
            .ask({
              title: "Bay Needs Notifications Permission",
              message: "You need to open System Settings to give Bay permission to show you Notifications.",
              confirmTitle: "Open System Settings",
              cancelTitle: "Not Now",
              windowId,
            })
            .pipe(Effect.catch(() => Effect.succeed({ confirmed: false })));

          if (answer.confirmed) {
            yield* engine.openSettings().pipe(Effect.catch((failure) => report("notification.settings", failure)));
          }

          return false;
        });

      const show = (tabId: string, n: WebNotification): Effect.Effect<void> =>
        Effect.gen(function* () {
          const s = browser.getState();
          const tab = s.tabs[tabId];
          const window = tab ? s.windows[tab.windowId] : undefined;

          // Dismiss incognito notifications.
          if (!tab || !window || window.incognito) {
            webviews.get(tabId)?.notificationAction(n.id, "close");

            return;
          }

          const id = macId(n);

          shownNotifications.set(id, n.id);

          let site = n.origin;

          try {
            site = new URL(n.origin).host;
          } catch {}

          const allowed = yield* ensurePermission(tab.windowId);

          // The page closed, or the notification was taken down, while the permission was asked for.
          if (!allowed || shownNotifications.get(id) !== n.id) return;

          // An icon that does not come is not a reason to skip the notification.
          const icon = n.icon
            ? yield* engine.downloadIcon(tabId, n.icon, NOTIFICATION_ICON_PIXELS).pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined;

          if (shownNotifications.get(id) !== n.id) return;

          const posted = yield* Effect.exit(
            engine.post({
              id,
              title: n.title,
              body: n.body,
              subtitle: site,
              silent: n.silent,
              icon,
              tabId,
              windowId: tab.windowId,
              origin: n.origin,
              dismissible: true,
              data: { engineId: n.id },
            }),
          );

          if (Exit.isFailure(posted)) yield* report("notification.post", posted.cause);
        });

      const close = (engineId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (const [id, shownId] of shownNotifications) {
            if (shownId !== engineId) continue;

            shownNotifications.delete(id);
            yield* engine.remove([id]).pipe(Effect.catch((error) => report("notification.remove", error)));
          }
        });

      return NotificationService.of({ show, close, ensurePermission });
    }),
  );
}
