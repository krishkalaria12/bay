import type { SecureDns } from "@bay/chromium";

// Secure DNS's providers and how a saved setting reads back (Settings › Privacy › Secure DNS).

export const DNS_PROVIDERS = [
  { id: "cloudflare", title: "Cloudflare (1.1.1.1)", template: "https://chrome.cloudflare-dns.com/dns-query" },
  { id: "quad9", title: "Quad9", template: "https://dns.quad9.net/dns-query" },
  { id: "google", title: "Google Public DNS", template: "https://dns.google/dns-query{?dns}" },
  { id: "mullvad", title: "Mullvad", template: "https://dns.mullvad.net/dns-query" },
] as const;

export type DnsChoice = "off" | "automatic" | (typeof DNS_PROVIDERS)[number]["id"] | "nextdns" | "custom";

export const NEXTDNS = /^https:\/\/dns\.nextdns\.io\/([a-z0-9]+)$/i;

/** Which choice a saved setting is. */
export function choiceOf(dns: Pick<SecureDns, "mode" | "templates">): DnsChoice {
  if (dns.mode !== "secure") return dns.mode;
  const provider = DNS_PROVIDERS.find((p) => p.template === dns.templates.trim());

  if (provider) return provider.id;

  return NEXTDNS.test(dns.templates.trim()) ? "nextdns" : "custom";
}

/** A DoH URI template Chrome takes: https, with a host, and {?dns} if it has a variable at all. */
export function validTemplate(text: string): boolean {
  const template = text.trim();

  if (!/^https:\/\/[^\s/{}]+/i.test(template)) return false;

  return !template.includes("{") || /\{\?dns\}/.test(template);
}
