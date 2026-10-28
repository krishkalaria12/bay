import { Cef } from "./native";
import { WebKit, isWebKitExternalApp } from "./webkit";

// A link to another app (codex:, zoommtg:, mailto:…). `app` is null when no app on this Mac opens
// it; `remember` is the "always allow" label, null when the choice can't be kept (private windows,
// insecure or opaque origins). The wording comes from native so the popover and the popup sheet match.
export type ExternalAppRequest = {
  id: string;
  url: string;
  scheme: string;
  origin: string | null;
  app: string | null;
  appPath: string | null;
  icon: string | null;
  title: string;
  message: string | null;
  remember: string | null;
};

export type ExternalAppAllowance = { origin: string; scheme: string; app: string | null; icon: string | null };

export const resolveExternalApp = (id: string, open: boolean, remember = false) =>
  isWebKitExternalApp(id) ? (WebKit?.resolveExternalApp(id, open, remember) ?? Promise.resolve()) : Cef.resolveExternalApp(id, open, remember);
// Both engines' allowances: WebKit pages keep their own (in memory, for the app's run).
export const getExternalAppAllowances = async (profile: string): Promise<ExternalAppAllowance[]> => {
  const [chromium, webkit] = await Promise.all([Cef.getExternalAppAllowances(profile), WebKit?.externalAppAllowances(profile).catch(() => []) ?? []]);
  const seen = new Set((chromium ?? []).map((a: ExternalAppAllowance) => `${a.origin}|${a.scheme}`));
  return [...(chromium ?? []), ...webkit.filter((a) => !seen.has(`${a.origin}|${a.scheme}`))];
};
export const removeExternalAppAllowance = (profile: string, origin: string, scheme: string) =>
  Promise.all([Cef.removeExternalAppAllowance(profile, origin, scheme), WebKit?.removeExternalAppAllowance(profile, origin, scheme)]).then(() => {});
