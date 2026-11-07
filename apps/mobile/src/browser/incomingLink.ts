import { isWebURL } from "./address.ts";

/**
 * The web page a link from another app (the default browser or a share target) opens: HTTP(S) with a host and no
 * credentials, canonicalised as typed addresses are. Anything else — Bay's own scheme, the dev client, mailto — is
 * left alone, because the engines only open pages and the same rule applies to the address bar.
 */
export function incomingLink(value: string | null): string | null {
  if (!value) return null;
  const url = value.trim();

  return isWebURL(url) ? new URL(url).toString() : null;
}
