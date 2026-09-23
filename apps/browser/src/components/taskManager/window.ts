import { hasWindowHost, openWindow } from "@bay/shell";

/** Window › Task Manager: a utility window (Windows.swift kind "taskManager") with its own React root. */
export const TASK_MANAGER_WINDOW_ID = "task-manager";

export function openTaskManager() {
  if (hasWindowHost) void openWindow(TASK_MANAGER_WINDOW_ID, { kind: "taskManager", title: "Task Manager" });
}
