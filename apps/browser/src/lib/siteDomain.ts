// A host's registrable domain ("eTLD+1"): what people mean by a site, its subdomains included. Engine rules
// (store/engines.ts) and sign-in carrying key by it, so accounts.example.com and www.example.com go together.
// The app has no copy of the Public Suffix List: this covers country codes' common second levels and the hosting
// suffixes people meet most. Anything else falls back to the last two labels.

// Second levels under a two-letter country code: co.uk, com.au, ne.jp, gov.in…
const COUNTRY_SECOND_LEVELS = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "go",
  "gob",
  "gov",
  "gv",
  "ltd",
  "me",
  "mil",
  "ne",
  "net",
  "nic",
  "nom",
  "or",
  "org",
  "plc",
  "sch",
]);

// Hosting suffixes on the Public Suffix List's private section, where each customer's subdomain is its own site.
const SHARED_HOSTS = [
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "herokuapp.com",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
  "blogspot.com",
  "cloudfront.net",
  "azurewebsites.net",
  "fly.dev",
  "onrender.com",
  "glitch.me",
  "myshopify.com",
];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The registrable domain of a host name: "accounts.example.co.uk" → "example.co.uk". IPs and one-label hosts are
 *  their own site. */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (!host.includes(".") || IPV4.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  const shared = SHARED_HOSTS.find((suffix) => host === suffix || host.endsWith(`.${suffix}`));

  if (shared) return labels.slice(-(shared.split(".").length + 1)).join(".");
  const tld = labels.at(-1)!;
  const second = labels.at(-2)!;
  const keep = labels.length >= 3 && tld.length === 2 && COUNTRY_SECOND_LEVELS.has(second) ? 3 : 2;

  return labels.slice(-keep).join(".");
}

/** A rule's site as typed: a host, an address or a domain, reduced to its registrable domain. Null for anything
 *  that names no web site. */
export function siteFromInput(input: string): string | null {
  const text = input.trim().toLowerCase();

  if (!text) return null;
  let host = text;

  try {
    host = new URL(/^[a-z][\w+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname;
  } catch {
    return null;
  }

  if (!/^[a-z0-9.-]+$/.test(host) || !/[a-z0-9]/.test(host) || host.startsWith(".") || host.includes("..")) return null;

  return registrableDomain(host);
}
