import * as v from "valibot";

// Hosts include their subdomains, but never a suffix without a dot boundary.
export const DEFAULT_AWAKE_SITES = ["web.whatsapp.com", "web.telegram.org", "slack.com", "discord.com", "mail.google.com", "open.spotify.com"];

export function normalizeAwakeSite(input: string): string | null {
  const value = input.trim();

  if (!value || /\s|\*/.test(value)) return null;

  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);

    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");

    if (!host || (!host.includes(".") && host !== "localhost" && !host.startsWith("["))) return null;

    return host;
  } catch {
    return null;
  }
}

export function normalizeAwakeSites(input: readonly string[]): string[] {
  const normalized = new Set<string>();

  for (const site of input) {
    if (!v.is(v.string(), site)) continue;
    const host = normalizeAwakeSite(site);

    if (host !== null) normalized.add(host);
  }

  return [...normalized];
}

export function siteKeptAwake(url: string | undefined, sites: readonly string[]): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  const host = normalizeAwakeSite(url);

  return host !== null && sites.some((site) => host === site || host.endsWith(`.${site}`));
}
