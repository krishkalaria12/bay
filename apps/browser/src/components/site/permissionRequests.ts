import { onPermission, onPermissionDismissed, type PermissionRequest } from "@bay/chromium";
import { patchPage, pageOf, tabForBrowser, usePages } from "../window/pageState";

const queues = new Map<string, PermissionRequest[]>();
const orphans: PermissionRequest[] = [];

// Requests the host asks of this window, per tab: the one showing, the rest waiting behind it.
export function startPermissionRequests() {
  onPermission((request) => {
    const tabId = tabForBrowser(request.browserId);
    if (!tabId) {
      orphans.push(request);
      return;
    }
    enqueue(tabId, request);
  });
  onPermissionDismissed(({ id }) => drop(id));
  // Attach queued requests once their tab browser ids arrive.
  usePages.subscribe((s, prev) => {
    if (s.browsers === prev.browsers || !orphans.length) return;
    for (const request of orphans.splice(0)) {
      const tabId = tabForBrowser(request.browserId);
      if (tabId) enqueue(tabId, request);
    }
  });
}

function enqueue(tabId: string, request: PermissionRequest) {
  if (!pageOf(tabId).permission) patchPage(tabId, { permission: request });
  else queues.set(tabId, [...(queues.get(tabId) ?? []), request]);
}

export function showNextPermission(tabId: string) {
  const queue = queues.get(tabId) ?? [];
  patchPage(tabId, { permission: queue.shift() ?? null });
  if (queue.length) queues.set(tabId, queue);
  else queues.delete(tabId);
}

function drop(id: string) {
  // A window that never showed the tab holds it here: the web host tells every window.
  for (let i = orphans.length - 1; i >= 0; i--) if (orphans[i]!.id === id) orphans.splice(i, 1);
  for (const [tabId, page] of Object.entries(usePages.getState().pages)) {
    if (page.permission?.id === id) showNextPermission(tabId);
  }
  for (const [tabId, queue] of queues)
    queues.set(
      tabId,
      queue.filter((r) => r.id !== id),
    );
}

export const queuedPermissions = (tabId: string) => queues.get(tabId) ?? [];
export const clearQueuedPermissions = (tabId: string) => queues.delete(tabId);
