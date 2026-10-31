/** Phase 1 accepts addresses only. Search engine routing and bangs land with the shared omnibox in phase 2. */
export function addressToURL(input: string): string {
  const address = input.trim();
  if (!address || /\s/.test(address)) throw new Error("Enter a website address.");
  // A host:port is an address, while javascript:, file:, and other schemes are not.
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(address) && !/^[^/:]+:\d+(?:\/|$)/.test(address);
  const url = new URL(hasScheme ? address : `https://${address}`);
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("Enter an HTTP or HTTPS website address.");
  }
  return url.href;
}
