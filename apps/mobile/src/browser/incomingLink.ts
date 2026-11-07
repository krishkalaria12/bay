import { isWebURL } from "./address.ts";

/**
 * The web page a link from another app (the default browser or a share target) opens: HTTP(S) with a host and no
 * credentials, canonicalised as typed addresses are. `bay://share` links (B14, an extension's or intent's handoff)
 * carry the page in their `url` parameter and are answered from it. Anything else — the dev client, mailto — is
 * left alone, because the engines only open pages and the same rule applies to the address bar.
 */
export function incomingLink(value: string | null): string | null {
  if (!value) return null;
  const url = value.trim();

  const shared = shareLink(url);

  if (shared) return shared;

  return isWebURL(url) ? new URL(url).toString() : null;
}

/** The page a `bay://share` link (B14) carries, or null for any other form. */
export function shareLink(url: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "bay:" || parsed.host !== "share") return null;

  return incomingLink(parsed.searchParams.get("url"));
}
