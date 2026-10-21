import { requireNativeModule } from "./native";

export type EmbeddedTab = { surfaceId: string; browserId: number; chromeTabId: number };
export type EmbeddedTabProps = {
  url?: string;
  profile?: string;
  adoptId?: string;
  transferKey?: string;
  active?: boolean;
  visible?: boolean;
  [key: string]: unknown;
};
export type EmbeddedViewEvent = { tag: number; event: string; payload: unknown };

/** Chrome owns the WebContents independently of its DOM embed's lifetime. */
export type WebViewHost = {
  mount(tag: number, windowId: string, props: EmbeddedTabProps): Promise<EmbeddedTab>;
  update(tag: number, props: EmbeddedTabProps): Promise<void>;
  call(tag: number, method: string, args: unknown[]): Promise<unknown>;
  unmount(tag: number): Promise<void>;
};

export const requireWebViewHost = (): WebViewHost => requireNativeModule<WebViewHost>("BayWebView");
