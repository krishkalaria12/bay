import { capabilities } from "@bay/platform";
import { confirm, hasNotificationPermissionQuery, notificationPermission, openNotificationSettings, requestNotificationPermission } from "@bay/shell";

let asked = false;

// Ask once before opening Notification Settings.
export async function ensureNotificationPermission(windowId?: string): Promise<boolean> {
  // Linux has no desktop-wide permission query. Attempt delivery through the
  // native service when a host supports notifications without that query.
  if (!hasNotificationPermissionQuery()) return capabilities.notifications;
  const status = await notificationPermission();
  if (status === "granted" || status === "provisional") return true;
  if (status === "notDetermined") return requestNotificationPermission();
  if (asked) return false;
  asked = true;
  const { confirmed } = await confirm({
    title: "Bay Needs Notifications Permission",
    message: "You need to open System Settings to give Bay permission to show you Notifications.",
    confirmTitle: "Open System Settings",
    cancelTitle: "Not Now",
    windowId,
  });
  if (confirmed) void openNotificationSettings();
  return false;
}
