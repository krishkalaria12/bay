export type LinkDestination = { kind: "space"; spaceId: string; syncProfileId?: string } | { kind: "littleBay" } | { kind: "newWindow" };

export type ExternalLinkRule = {
  id: string;
  pattern: string;
  sourceApp?: string;
  destination: LinkDestination;
};

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
    const url = new URL(`${scheme ? scheme[1]!.toLowerCase() + ":" : protocol}//${host.replaceAll("*", placeholder)}`);
    if (!url.hostname) return null;
    return {
      protocol: scheme ? `${scheme[1]!.toLowerCase()}:` : null,
      host: url.host.replaceAll(placeholder, "*"),
      path: slash < 0 ? null : address.slice(slash),
    };
  } catch {
    return null;
  }
}

export function validateLinkPattern(pattern: string): string | null {
  return parsePattern(pattern) ? null : "Enter a host or path, such as github.com/acme/*. Use * as a wildcard; leave out query strings and fragments.";
}

export function normalizeExternalLinkRules(input: unknown): ExternalLinkRule[] {
  if (!Array.isArray(input)) return [];
  const ids = new Set<string>();
  return input
    .filter((rule): rule is ExternalLinkRule => {
      if (!rule || typeof rule.id !== "string" || !rule.id || ids.has(rule.id) || typeof rule.pattern !== "string" || validateLinkPattern(rule.pattern))
        return false;
      if (rule.sourceApp !== undefined && (typeof rule.sourceApp !== "string" || !/^[\w.-]+$/.test(rule.sourceApp))) return false;
      const target = rule.destination;
      if (!target || !["space", "littleBay", "newWindow"].includes(target.kind)) return false;
      if (target.kind === "space" && (typeof target.spaceId !== "string" || !target.spaceId)) return false;
      if (target.kind === "space" && target.syncProfileId !== undefined && (typeof target.syncProfileId !== "string" || !target.syncProfileId)) return false;
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
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  return rules.find((rule) => {
    if (rule.sourceApp && rule.sourceApp.toLowerCase() !== sourceApp?.toLowerCase()) return false;
    const pattern = parsePattern(rule.pattern, url.protocol);
    return (
      !!pattern &&
      (!pattern.protocol || pattern.protocol === url.protocol) &&
      glob(url.host.toLowerCase(), pattern.host) &&
      (pattern.path === null || glob(url.pathname, pattern.path))
    );
  });
}
