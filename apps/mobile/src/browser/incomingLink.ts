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

/**
 * What a `bay://` command (B15) asks for. Quick actions and the search widget open these links; JavaScript answers
 * them with the matching action rather than a page, like `shareLink` answers its carry. Exactly these three hosts,
 * and nothing with a path or query: anything else (a stray `bay:` address) is left alone.
 */
export type BayCommand = "new-tab" | "private-tab" | "search";

export function bayCommand(value: string | null): BayCommand | null {
  if (!value) return null;

  let parsed: URL;

  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== "bay:" || (parsed.pathname !== "" && parsed.pathname !== "/") || parsed.search) return null;

  // Hosts are case-insensitive, and non-special schemes don't get normalised by the URL parser.
  const host = parsed.host.toLowerCase();

  // SAFETY: the host was checked to be one of the three commands above (bay scheme, no path, no query).
  return host === "new-tab" || host === "private-tab" || host === "search" ? (host as BayCommand) : null;
}
