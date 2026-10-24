import { parseUrl, punycodeEncode } from "@bay/core";

export type LinkDestination =
  | { kind: "space"; spaceId: string; syncProfileId?: string }
  | { kind: "littleBay" }
  | { kind: "mostRecentSpace" }
  | { kind: "newWindow" };

export type LinkMatchType = "contains" | "equals";

export type ExternalLinkRule = {
  id: string;
  pattern: string;
  // Rules saved before match modes were introduced retain their host/path wildcard behavior.
  matchType?: LinkMatchType;
  sourceApp?: string;
  destination: LinkDestination;
};

// React Native's URL shim changes trailing slashes and does not escape paths. Use the app's parser in every runtime.
function webUrl(input: string) {
  const parsed = parseUrl(input);
  if (!parsed || !["http", "https"].includes(parsed.scheme) || !parsed.host || /[\s\\]/.test(parsed.host)) return null;
  if (parsed.host.startsWith("[") && !/^\[[a-f0-9:.]+\]$/i.test(parsed.host)) return null;
  const port = parsed.port ? Number(parsed.port) : null;
  if (port !== null && (port < 0 || port > 65535)) return null;
  const protocol = `${parsed.scheme}:`;
  const hostname = parsed.host
    .normalize("NFC")
    .split(".")
    .map((label) => ([...label].some((character) => character.charCodeAt(0) > 127) ? `xn--${punycodeEncode(label)}` : label))
    .join(".");
  const host = hostname + (port === null || (protocol === "https:" && port === 443) || (protocol === "http:" && port === 80) ? "" : `:${port}`);
  const segments: string[] = [];
  const rawPath = parsed.path.replaceAll("\\", "/") || "/";
  const parts = rawPath.split("/");
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const dots = part.replace(/%2e/gi, ".");
    if (dots === "..") {
      if (segments.length > 1) segments.pop();
    } else if (dots !== ".") segments.push(part);
    if ((dots === "." || dots === "..") && index === parts.length - 1) segments.push("");
  }
  const pathname = urlText(segments.join("/") || "/", "path");
  const authority = input.trim().match(/^[a-z]+:\/\/([^/?#]*)/i)?.[1] ?? "";
  const credentials = authority.includes("@") ? authority.slice(0, authority.lastIndexOf("@") + 1) : "";
  const query = urlText(parsed.query, "query");
  const hash = urlText(parsed.hash, "fragment");
  return {
    protocol,
    host,
    pathname,
    query,
    hash,
    href: `${protocol}//${urlText(credentials, "path")}${host}${pathname}${query}${hash}`,
  };
}

function parsePattern(input: string, protocol = "https:") {
  const value = input.trim();
  if (!value || /[\s?#@\\]/.test(value)) return null;
  const scheme = value.match(/^([a-z*]+):\/\//i);
  if (scheme && !/^https?$/i.test(scheme[1]!)) return null;
  const address = scheme ? value.slice(scheme[0].length) : value;
  const slash = address.indexOf("/");
  const host = slash < 0 ? address : address.slice(0, slash);
  if (!host || !/^[a-z0-9.*:[\]-]+$/i.test(host)) return null;
  let placeholder = "baywildcard";
  while (host.toLowerCase().includes(placeholder)) placeholder += "x";
  try {
    const url = webUrl(`${scheme ? scheme[1]!.toLowerCase() + ":" : protocol}//${host.replaceAll("*", placeholder)}${slash < 0 ? "" : address.slice(slash)}`);
    if (!url) return null;
    return {
      protocol: scheme ? `${scheme[1]!.toLowerCase()}:` : null,
      host: url.host.replaceAll(placeholder, "*"),
      path: slash < 0 ? null : url.pathname,
    };
  } catch {
    return null;
  }
}

export function validateLinkPattern(pattern: string, matchType?: LinkMatchType): string | null {
  if (matchType) {
    if (!pattern.trim() || [...pattern].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
      return "Enter the URL or text to match.";
    if (matchType === "contains") return null;
    if (webUrl(pattern.trim())) return null;
    return "Enter a complete http:// or https:// URL, including its query string or fragment if needed.";
  }
  return parsePattern(pattern) ? null : "Enter a host or path, such as github.com/acme/*. Use * as a wildcard; leave out query strings and fragments.";
}

export function normalizeLinkDestination(input: unknown): LinkDestination | null {
  if (!input || typeof input !== "object") return null;
  const target = input as LinkDestination;
  if (target.kind === "littleBay" || target.kind === "mostRecentSpace" || target.kind === "newWindow") return { kind: target.kind };
  if (target.kind !== "space" || typeof target.spaceId !== "string" || !target.spaceId) return null;
  if (target.syncProfileId !== undefined && (typeof target.syncProfileId !== "string" || !target.syncProfileId)) return null;
  return { kind: "space", spaceId: target.spaceId, ...(target.syncProfileId ? { syncProfileId: target.syncProfileId } : {}) };
}

export function defaultLinkDestination(settings: {
  externalLinkDefault: LinkDestination | null;
  openLinksInLittleBay: boolean;
  defaultSpaceId: string;
}): LinkDestination {
  return settings.externalLinkDefault ?? (settings.openLinksInLittleBay ? { kind: "littleBay" } : { kind: "space", spaceId: settings.defaultSpaceId });
}

export function normalizeExternalLinkRules(input: unknown): ExternalLinkRule[] {
  if (!Array.isArray(input)) return [];
  const ids = new Set<string>();
  return input
    .filter((rule): rule is ExternalLinkRule => {
      if (
        !rule ||
        typeof rule.id !== "string" ||
        !rule.id ||
        ids.has(rule.id) ||
        typeof rule.pattern !== "string" ||
        (rule.matchType !== undefined && rule.matchType !== "contains" && rule.matchType !== "equals") ||
        validateLinkPattern(rule.pattern, rule.matchType)
      )
        return false;
      if (rule.sourceApp !== undefined && (typeof rule.sourceApp !== "string" || !/^[\w.-]+$/.test(rule.sourceApp))) return false;
      if (!normalizeLinkDestination(rule.destination)) return false;
      ids.add(rule.id);
      return true;
    })
    .map((rule) => ({ ...rule, pattern: rule.pattern.trim() }));
}

// Only * is special. Hostnames are matched separately, so a path or query cannot impersonate a host.
function glob(value: string, pattern: string): boolean {
  let at = 0,
    p = 0,
    star = -1,
    retry = 0;
  while (at < value.length) {
    if (pattern[p] === "*") {
      star = p++;
      retry = at;
    } else if (p < pattern.length && pattern[p] === value[at]) {
      at++;
      p++;
    } else if (star >= 0) {
      p = star + 1;
      at = ++retry;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

export function matchingLinkRule(rules: readonly ExternalLinkRule[], address: string, sourceApp?: string): ExternalLinkRule | undefined {
  const url = webUrl(address);
  if (!url) return;
  return rules.find((rule) => {
    if (rule.sourceApp && rule.sourceApp.toLowerCase() !== sourceApp?.toLowerCase()) return false;
    if (rule.matchType === "contains") {
      if (
        url.href.includes(urlText(rule.pattern)) ||
        url.pathname.includes(urlText(rule.pattern, "path")) ||
        url.query.includes(urlText(rule.pattern, "query")) ||
        url.hash.includes(urlText(rule.pattern, "fragment"))
      )
        return true;
      const prefix = webUrl(rule.pattern);
      return !!prefix && url.href.includes(prefix.href);
    }
    if (rule.matchType === "equals") {
      return url.href === webUrl(rule.pattern)?.href;
    }
    const pattern = parsePattern(rule.pattern, url.protocol);
    return (
      !!pattern &&
      (!pattern.protocol || pattern.protocol === url.protocol) &&
      glob(url.host.toLowerCase(), pattern.host) &&
      (pattern.path === null || glob(url.pathname, pattern.path))
    );
  });
}

// Escape each URL component without decoding existing escapes or conflating literal and escaped delimiters.
function urlText(value: string, component?: "path" | "query" | "fragment"): string {
  const escaped = component === "path" ? '"#<>?^`{}' : component === "query" ? "\"#<>'" : component === "fragment" ? '"<>`' : "";
  let text = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code > 126) {
      try {
        text += encodeURIComponent(character);
      } catch {
        text += "%EF%BF%BD";
      }
    } else if (code <= 32 || escaped.includes(character)) text += `%${code.toString(16).padStart(2, "0").toUpperCase()}`;
    else text += character;
  }
  return text.replace(/%[a-f0-9]{2}/gi, (escape) => escape.toUpperCase());
}
