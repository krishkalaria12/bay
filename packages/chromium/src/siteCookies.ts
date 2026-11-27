import * as v from "valibot";
import { Cef } from "./native";
import { WebKit, type PageEngine } from "./webkit";

// A site's sign-in carried between the app's two engines when a page switches (apps/browser lib/engineSiteData.ts):
// its cookies read from one engine's store and written to the other's. Chromium's side is the engine's
// nn_cookies_site and nn_cookies_apply (engine/chromium nn_cookies.h), WebKit's WKHTTPCookieStore
// (../ios/WebKitHub.swift). Only unpartitioned cookies of the site and its subdomains, never a private window's.

const SiteCookieSchema = v.object({
  name: v.string(),
  value: v.string(),
  domain: v.string(),
  path: v.string(),
  created: v.optional(v.number()),
  expires: v.optional(v.number()),
  lastAccess: v.optional(v.number()),
  secure: v.boolean(),
  httpOnly: v.boolean(),
  sameSite: v.picklist(["unspecified", "none", "lax", "strict"]),
  priority: v.optional(v.picklist(["low", "medium", "high"])),
  sourceScheme: v.optional(v.picklist(["unset", "nonSecure", "secure"])),
  sourcePort: v.optional(v.number()),
});

export type SiteCookie = v.InferOutput<typeof SiteCookieSchema>;

/** What names a stored cookie: two with the same name, domain and path are the same cookie. */
export type CookieName = Pick<SiteCookie, "name" | "domain" | "path">;

const AppliedSchema = v.object({ set: v.number(), rejected: v.number(), removed: v.number() });

export type CookiesApplied = v.InferOutput<typeof AppliedSchema>;

const CookiesSchema = v.object({ cookies: v.array(SiteCookieSchema) });

/** Whether this build can carry sign-ins between its engines (a Mac with WebKit and new enough native code). */
export const canCarrySiteCookies = () => !!WebKit?.siteCookies && !!Cef.siteCookies;

/** A site's cookies in one engine's store for a profile, or null when they can't be read. */
export async function siteCookies(engine: PageEngine, profile: string, site: string): Promise<SiteCookie[] | null> {
  try {
    if (engine === "webkit") {
      const read = v.safeParse(v.array(SiteCookieSchema), await WebKit?.siteCookies?.(profile, site));

      return read.success ? read.output : null;
    }

    const reply = await Cef.siteCookies?.(profile, site);
    const read = v.safeParse(CookiesSchema, reply ? JSON.parse(reply) : null);

    return read.success ? read.output.cookies : null;
  } catch {
    return null;
  }
}

/** Writes `set` and removes `remove` in one engine's store for a profile; nothing else of the site's changes. */
export async function applySiteCookies(engine: PageEngine, profile: string, set: SiteCookie[], remove: CookieName[]): Promise<CookiesApplied | null> {
  try {
    if (engine === "webkit") {
      const applied = v.safeParse(AppliedSchema, await WebKit?.applySiteCookies?.(profile, set, remove));

      return applied.success ? applied.output : null;
    }

    const reply = await Cef.applySiteCookies?.(profile, JSON.stringify({ set, remove }));
    const applied = v.safeParse(AppliedSchema, reply ? JSON.parse(reply) : null);

    return applied.success ? applied.output : null;
  } catch {
    return null;
  }
}
