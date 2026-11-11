/** Which failure it was, so the screen can say it in the reader's language: a `pageError.<id>` message. */
export type PageErrorId = "offline" | "notFound" | "timeout" | "refused" | "certificate" | "unknown";

export interface PageErrorText {
  kind: "offline" | "error";
  title: string;
  detail: string;
}

// Chromium's net:: codes (Android) and NSURLError descriptions (iOS) for the failures people actually hit.
const KNOWN: [RegExp, Exclude<PageErrorId, "unknown">, PageErrorText][] = [
  [
    /INTERNET_DISCONNECTED|NETWORK_CHANGED|appears to be offline|network connection was lost/i,
    "offline",
    { kind: "offline", title: "You're offline", detail: "Check your connection and try again." },
  ],
  [/NAME_NOT_RESOLVED|hostname could not be found/i, "notFound", { kind: "error", title: "Can't find this site", detail: "Check the address for typos." }],
  [/TIMED_OUT|timed out/i, "timeout", { kind: "error", title: "This site took too long", detail: "It may be busy or down. Try again in a moment." }],
  [
    /CONNECTION_REFUSED|ADDRESS_UNREACHABLE|could not connect to the server/i,
    "refused",
    { kind: "error", title: "This site refused to connect", detail: "It may be down, or blocked on this network." },
  ],
  [
    /CERT|SSL|certificate|secure connection/i,
    "certificate",
    { kind: "error", title: "This connection isn't private", detail: "Bay stopped loading because the site's certificate isn't valid." },
  ],
];

/** Plain words for an engine's load failure; unknown failures keep the engine's message. */
export function describePageError(message: string): PageErrorText {
  return KNOWN.find(([pattern]) => pattern.test(message))?.[2] ?? { kind: "error", title: "Can't open this page", detail: message };
}

/** Which of the known failures a load failure is, or "unknown" when none matches. */
export function pageErrorId(message: string): PageErrorId {
  return KNOWN.find(([pattern]) => pattern.test(message))?.[1] ?? "unknown";
}
