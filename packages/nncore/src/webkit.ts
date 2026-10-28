import { requireOptionalNativeModule, type EventSubscription } from "@bay/platform/native";
import type { ExternalAppAllowance } from "./externalApps";
import type { BrowsingDataType, Download, PermissionRequest, PermissionResult } from "./module";
import type { SiteSettings, SiteSettingType, SiteSettingValue } from "./siteSettings";

// The engine a tab's page runs in. Chromium (NNCore) has no Widevine, so DRM video (Netflix, Disney+…) plays only in
// WebKit (WKWebView, ../ios/WebKit*.swift, Expo module BayWebKit), which has FairPlay. Each engine keeps its own
// cookies and site data per profile.
export type PageEngine = "chromium" | "webkit";

type WebKitNative = {
  addListener(name: "onDownload", listener: (d: Download) => void): EventSubscription;
  addListener(name: "onPermission", listener: (p: PermissionRequest) => void): EventSubscription;
  addListener(name: "onPermissionDismissed", listener: (p: { id: string }) => void): EventSubscription;
  prepareTransfer(key: string): void;
  releaseTransfer(key: string): void;
  resolvePermission(id: string, result: PermissionResult, remember: boolean): Promise<void>;
  downloadCommand(action: "cancel" | "pause" | "resume", id: string): Promise<void>;
  endPrivateSession(session: string): Promise<void>;
  sitePermissions(profile: string, origin: string): Promise<Partial<SiteSettings>>;
  setSitePermission(profile: string, origin: string, kind: string, value: string): Promise<void>;
  resolveExternalApp(id: string, open: boolean, remember: boolean): Promise<void>;
  externalAppAllowances(profile: string): Promise<ExternalAppAllowance[]>;
  removeExternalAppAllowance(profile: string, origin: string, scheme: string): Promise<void>;
  clearBrowsingData(profile: string, types: BrowsingDataType[], since: number | null): Promise<void>;
  deleteProfileData(profile: string): Promise<boolean>;
  info(): Promise<{ safariVersion: string; userAgentSuffix: string; passkeys: boolean }>;
};

// Optional: a build without the module (older native code) keeps every page in Chromium.
export const WebKit = requireOptionalNativeModule<WebKitNative>("BayWebKit");
export const hasWebKit = () => !!WebKit;

const NO_SUBSCRIPTION: EventSubscription = { remove() {} };

export const isWebKitDownload = (id: string) => id.startsWith("wk-download-");
export const isWebKitPermission = (id: string) => id.startsWith("wk-permission-");
export const isWebKitExternalApp = (id: string) => id.startsWith("wk-external-");
/** The site settings a WebKit page has: the rest are Chromium's. */
export const WEBKIT_SITE_SETTINGS: readonly SiteSettingType[] = ["camera", "microphone"];

export const webKitListener = <T>(name: "onDownload" | "onPermission" | "onPermissionDismissed", listener: (value: T) => void): EventSubscription =>
  WebKit ? WebKit.addListener(name as "onDownload", listener as (d: Download) => void) : NO_SUBSCRIPTION;

/** A private window's WebKit store (in memory) goes with the window. */
export const endWebKitPrivateSession = (session: string) => WebKit?.endPrivateSession(session) ?? Promise.resolve();
export const getWebKitSiteSettings = async (profile: string, origin: string): Promise<SiteSettings> =>
  ((await WebKit?.sitePermissions(profile, origin)) ?? {}) as SiteSettings;
export const setWebKitSiteSetting = (profile: string, origin: string, type: SiteSettingType, value: SiteSettingValue) =>
  WebKit?.setSitePermission(profile, origin, type, value) ?? Promise.resolve();
export const webKitInfo = () => WebKit?.info() ?? Promise.resolve(null);
