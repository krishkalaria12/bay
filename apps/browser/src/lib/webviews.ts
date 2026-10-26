import type { WebViewHandle } from "@bay/nncore";

export const webviews = new Map<string, WebViewHandle>();

// Told when a tab gets a (new) view: state a view keeps (a Boost's tab sheet) is set on it again.
const attached = new Set<(tabId: string, handle: WebViewHandle) => void>();
export function onWebviewAttached(listener: (tabId: string, handle: WebViewHandle) => void) {
  attached.add(listener);
  return () => void attached.delete(listener);
}

export function webviewRef(tabId: string) {
  let mine: WebViewHandle | null = null;
  return (handle: WebViewHandle | null) => {
    if (handle) {
      mine = handle;
      webviews.set(tabId, handle);
      for (const listener of attached) listener(tabId, handle);
    } else if (mine && webviews.get(tabId) === mine) {
      webviews.delete(tabId);
    }
  };
}
