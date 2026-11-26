import * as v from "valibot";
import { lookup, parseUrl } from "@bay/core";
import type { PluginManifest } from "@bay/chromium";
import { JsonValueSchema, parseJson, type JsonValue } from "../json";

// What a plugin's sandbox says (packages/rust/bay-plugins src/runtime.js) and what Bay lets it do: every call is
// checked here against the plugin's manifest before the service (pluginService.ts) acts on it. The sandbox's own
// script is the plugin's, so nothing it sends is trusted.

/** The most a message from a sandbox may be. */
export const MAX_MESSAGE = 8 * 1024 * 1024;
export const MAX_FETCH_BODY = 5 * 1024 * 1024;
export const MAX_STORED_VALUE = 64 * 1024;
export const MAX_VIEW_ITEMS = 200;
export const MAX_LIVE_ITEMS = 200;

const Count = v.pipe(v.number(), v.integer(), v.minValue(1));

const SandboxMessageSchema = v.variant("t", [
  v.object({ t: v.literal("call"), n: Count, m: v.string(), a: v.array(JsonValueSchema) }),
  v.object({ t: v.literal("done"), n: Count, ok: v.boolean(), v: v.optional(JsonValueSchema), e: v.optional(v.string()) }),
  v.object({ t: v.literal("ready") }),
  v.object({ t: v.literal("log"), level: v.string(), text: v.string() }),
]);

export type SandboxMessage = v.InferOutput<typeof SandboxMessageSchema>;

/** A message from a sandbox, or null for one Bay doesn't read. */
export function readSandboxMessage(text: string): SandboxMessage | null {
  if (text.length > MAX_MESSAGE) return null;
  const parsed = v.safeParse(SandboxMessageSchema, parseJson(text));

  return parsed.success ? parsed.output : null;
}

// MARK: Hosts

type Origin = { scheme: string; host: string; port: number };

const DEFAULT_PORTS = { http: 80, https: 443 };

/** A web address's origin, or null for one Bay won't fetch or open: no credentials, backslashes or spaces in it. */
export function webOrigin(url: string): Origin | null {
  if (url.length > 8192 || /[\s\\\p{Cc}]/u.test(url)) return null;
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1];
  const parsed = parseUrl(url);

  if (authority === undefined || authority.includes("@") || authority.includes("%") || !parsed || !parsed.host) return null;
  const port = lookup(DEFAULT_PORTS, parsed.scheme);

  if (port === undefined) return null;

  return { scheme: parsed.scheme, host: parsed.host, port: parsed.port ? Number(parsed.port) : port };
}

/** Whether `url` is on one of the manifest's hosts (`https://api.example.com`, `https://*.example.com:8443`). */
export function hostAllowed(patterns: readonly string[], url: string): boolean {
  const origin = webOrigin(url);

  if (!origin) return false;

  return patterns.some((pattern) => {
    const match = /^(https?):\/\/(\*\.)?([^:/]+)(?::(\d+))?$/.exec(pattern);

    if (!match) return false;
    const [, scheme, wildcard, host, port] = match;

    return (
      scheme === origin.scheme &&
      (port ? Number(port) : lookup(DEFAULT_PORTS, scheme!)) === origin.port &&
      (origin.host === host || (!!wildcard && origin.host.endsWith(`.${host}`)))
    );
  });
}

const webAddress = (url: string) => webOrigin(url) !== null;

// MARK: Calls

export type ToolbarState = { badge?: string; title?: string };

export type ViewItem = { id: string; title: string; subtitle?: string; icon?: string; url?: string };

export type FetchInit = { method: string; headers: Record<string, string>; body: string | null };

export type PluginCall =
  | { method: "fetch"; url: string; init: FetchInit }
  | { method: "tabs.open"; url: string; background: boolean }
  | { method: "tabs.active" }
  | { method: "settings.get" }
  | { method: "storage.get"; key: string }
  | { method: "storage.set"; key: string; value: JsonValue }
  | { method: "notify"; message: string }
  | { method: "toolbar.set"; id: string; state: ToolbarState }
  | { method: "view.set"; id: string; items: ViewItem[] }
  | { method: "live.refresh"; id: string };

export type CallCheck = { ok: true; call: PluginCall } | { ok: false; error: string };

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

// What the network stack sets itself, or what would let a plugin pose as a page or as Bay.
const FORBIDDEN_HEADERS =
  /^(cookie|cookie2|host|origin|referer|content-length|connection|keep-alive|transfer-encoding|upgrade|te|trailer|expect|via|dnt|proxy-.*|sec-.*)$/i;

const SymbolName = v.pipe(v.string(), v.regex(/^[a-z0-9.]{1,60}$/));

const Line = (max: number) =>
  v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(max),
    v.check((text) => !/\p{Cc}/u.test(text), "control characters"),
  );

const ToolbarStateSchema = v.strictObject({ badge: v.optional(Line(4)), title: v.optional(v.pipe(Line(60), v.minLength(1))) });

const ViewItemSchema = v.strictObject({
  id: v.pipe(Line(100), v.minLength(1)),
  title: v.pipe(Line(200), v.minLength(1)),
  subtitle: v.optional(Line(300)),
  icon: v.optional(SymbolName),
  url: v.optional(v.pipe(v.string(), v.check(webAddress, "a web address"))),
});

const FetchInitSchema = v.strictObject({
  method: v.picklist(METHODS),
  headers: v.pipe(
    v.record(v.pipe(v.string(), v.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/)), v.pipe(v.string(), v.maxLength(8192))),
    v.check((headers) => Object.keys(headers).length <= 64, "too many headers"),
  ),
  body: v.nullable(v.pipe(v.string(), v.maxLength(MAX_FETCH_BODY))),
});

const StorageKey = v.pipe(v.string(), v.regex(/^[\w.:-]{1,100}$/));

const refuse = (error: string): CallCheck => ({ ok: false, error });

/** The call a sandbox asked for, if its plugin may make it. */
export function checkCall(manifest: PluginManifest, method: string, args: readonly JsonValue[]): CallCheck {
  const [first, second] = args;
  const text = (value: JsonValue | undefined) => (v.is(v.string(), value) ? value : null);
  const { contributes, permissions } = manifest;

  switch (method) {
    case "fetch": {
      const url = text(first);

      if (!url || !webAddress(url)) return refuse("bay.fetch takes an http or https address");

      if (!hostAllowed(permissions.hosts, url))
        return refuse(`The plugin's manifest doesn't list ${url.replace(/^([a-z]+:\/\/[^/?#]*).*$/i, "$1")} in permissions.hosts`);
      const init = v.safeParse(FetchInitSchema, second);

      if (!init.success) return refuse("bay.fetch's options aren't ones Bay sends");
      const forbidden = Object.keys(init.output.headers).find((name) => FORBIDDEN_HEADERS.test(name));

      if (forbidden) return refuse(`bay.fetch can't set the ${forbidden} header`);

      if (init.output.body !== null && (init.output.method === "GET" || init.output.method === "HEAD"))
        return refuse(`A ${init.output.method} request has no body`);

      return { ok: true, call: { method, url, init: init.output } };
    }

    case "tabs.open": {
      const url = text(first);
      const options = v.safeParse(v.strictObject({ background: v.optional(v.boolean()) }), second ?? {});

      if (!url || !webAddress(url) || !options.success) return refuse("bay.tabs.open takes an http or https address");

      return { ok: true, call: { method, url, background: options.output.background ?? false } };
    }

    case "tabs.active":
      return permissions.tabs ? { ok: true, call: { method } } : refuse("The plugin's manifest doesn't ask for permissions.tabs");
    case "settings.get":
      return { ok: true, call: { method } };
    case "storage.get":
    case "storage.set": {
      const key = v.safeParse(StorageKey, first);

      if (!key.success) return refuse("A storage key is 1–100 letters, digits, _ . : or -");

      if (method === "storage.get") return { ok: true, call: { method, key: key.output } };
      const value = second ?? null;

      if (JSON.stringify(value).length > MAX_STORED_VALUE) return refuse(`A stored value is at most ${MAX_STORED_VALUE / 1024} KB`);

      return { ok: true, call: { method, key: key.output, value } };
    }

    case "notify": {
      const message = v.safeParse(v.pipe(Line(300), v.minLength(1)), first);

      return message.success ? { ok: true, call: { method, message: message.output } } : refuse("bay.notify takes a line of text");
    }

    case "toolbar.set": {
      const id = text(first);
      const state = v.safeParse(ToolbarStateSchema, second ?? {});

      if (!id || !contributes.toolbar.some((b) => b.id === id)) return refuse(`The plugin adds no toolbar button "${id}"`);

      if (!state.success) return refuse("A toolbar button takes a badge (4 characters at most) and a title");

      return { ok: true, call: { method, id, state: state.output } };
    }

    case "view.set": {
      const id = text(first);
      const items = v.safeParse(v.pipe(v.array(ViewItemSchema), v.maxLength(MAX_VIEW_ITEMS)), second);

      if (!id || !contributes.sidebarViews.some((view) => view.id === id)) return refuse(`The plugin adds no sidebar view "${id}"`);

      if (!items.success) return refuse(`A view's items are up to ${MAX_VIEW_ITEMS} of {id, title, subtitle?, icon?, url?}`);

      return { ok: true, call: { method, id, items: items.output } };
    }

    case "live.refresh": {
      const id = text(first);

      return id && contributes.liveSources.some((s) => s.id === id) ? { ok: true, call: { method, id } } : refuse(`The plugin adds no live source "${id}"`);
    }

    default:
      return refuse(`Bay has no plugin call "${method}"`);
  }
}

// MARK: Answers

const PluginLiveItemSchema = v.strictObject({
  id: v.pipe(Line(200), v.minLength(1)),
  url: v.pipe(v.string(), v.check(webAddress, "a web address")),
  title: v.pipe(Line(300), v.minLength(1)),
  subtitle: v.optional(Line(300)),
  // An avatar or site image, on the web.
  icon: v.optional(v.pipe(v.string(), v.check(webAddress, "a web address"))),
  updatedAt: v.optional(v.pipe(v.number(), v.finite())),
});

export type PluginLiveItem = v.InferOutput<typeof PluginLiveItemSchema>;

/** A live source's answer: its items, or why Bay can't show them. */
export function readLiveItems(value: JsonValue): { ok: true; items: PluginLiveItem[] } | { ok: false; error: string } {
  const items = v.safeParse(v.pipe(v.array(PluginLiveItemSchema), v.maxLength(MAX_LIVE_ITEMS)), value);

  return items.success
    ? { ok: true, items: items.output }
    : { ok: false, error: `A live source answers up to ${MAX_LIVE_ITEMS} of {id, url, title, subtitle?, icon?, updatedAt?}` };
}

export type LinkDecision = { kind: "space"; space: string } | { kind: "littleBay" } | { kind: "newWindow" };

const LinkDecisionSchema = v.union([
  v.strictObject({ space: v.pipe(Line(200), v.minLength(1)) }),
  v.strictObject({ littleBay: v.literal(true) }),
  v.strictObject({ newWindow: v.literal(true) }),
]);

/** Where a plugin's decide hook sends a link: a space (by id or name), Little Bay or a new window; null leaves it. */
export function readLinkDecision(value: JsonValue): LinkDecision | null {
  const parsed = v.safeParse(LinkDecisionSchema, value);

  if (!parsed.success) return null;
  const answer = parsed.output;

  if ("space" in answer) return { kind: "space", space: answer.space };

  return "littleBay" in answer ? { kind: "littleBay" } : { kind: "newWindow" };
}

// MARK: Settings

export type SettingValue = string | boolean;

/** A setting's value as its manifest allows it, or null (a secret is never one of these). */
export function settingValue(setting: PluginManifest["settings"][number], value: JsonValue): SettingValue | null {
  switch (setting.type) {
    case "text":
      return v.is(v.pipe(v.string(), v.maxLength(4096)), value) ? value : null;
    case "toggle":
      return v.is(v.boolean(), value) ? value : null;
    case "choice":
      return v.is(v.string(), value) && setting.options.some((o) => o.value === value) ? value : null;
    default:
      return null;
  }
}
