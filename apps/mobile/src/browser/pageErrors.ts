export interface PageErrorText {
  kind: "offline" | "error";
  title: string;
  detail: string;
}

// Chromium's net:: codes (Android) and NSURLError descriptions (iOS) for the failures people actually hit.
const KNOWN: [RegExp, PageErrorText][] = [
  [
    /INTERNET_DISCONNECTED|NETWORK_CHANGED|appears to be offline|network connection was lost/i,
    { kind: "offline", title: "You're offline", detail: "Check your connection and try again." },
  ],
  [/NAME_NOT_RESOLVED|hostname could not be found/i, { kind: "error", title: "Can't find this site", detail: "Check the address for typos." }],
  [/TIMED_OUT|timed out/i, { kind: "error", title: "This site took too long", detail: "It may be busy or down. Try again in a moment." }],
  [
    /CONNECTION_REFUSED|ADDRESS_UNREACHABLE|could not connect to the server/i,
    { kind: "error", title: "This site refused to connect", detail: "It may be down, or blocked on this network." },
  ],
  [
    /CERT|SSL|certificate|secure connection/i,
    { kind: "error", title: "This connection isn't private", detail: "Bay stopped loading because the site's certificate isn't valid." },
  ],
];

/** Plain words for an engine's load failure; unknown failures keep the engine's message. */
export function describePageError(message: string): PageErrorText {
  return KNOWN.find(([pattern]) => pattern.test(message))?.[1] ?? { kind: "error", title: "Can't open this page", detail: message };
}
