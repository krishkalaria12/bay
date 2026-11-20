import { BUILT_IN_ENGINES, engineById, searchUrl, type SearchEngine } from "@bay/core/src/engines.ts";
import { fixupUrl, hostOf } from "@bay/core/src/input.ts";

// Deep imports keep the bundle off @bay/core's desktop-only modules (shared collections, the bang list).
export const SEARCH_ENGINES: readonly SearchEngine[] = BUILT_IN_ENGINES;

/** The id the custom engine is chosen by (C17). */
export const CUSTOM_ENGINE_ID = "custom";

/**
 * The chosen search engine. The custom one is the address the user gave, named by its site; it asks for no
 * suggestions, since Bay can't know where that site keeps them. Without an address it falls back to the default.
 */
export function engineFor(id: string, customUrl: string | null = null): SearchEngine {
  if (id === CUSTOM_ENGINE_ID && customUrl) {
    const host = hostOf(customUrl.replaceAll("%s", "q")) || customUrl;

    return { id: CUSTOM_ENGINE_ID, name: host, keyword: host, url: customUrl, custom: true };
  }

  return engineById(SEARCH_ENGINES, id);
}

/** HTTP(S) with a host and no credentials: the only pages the engines open. */
export function isWebURL(value: string): boolean {
  try {
    const url = new URL(value);

    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** What typed text opens: a website address, or otherwise a search with the chosen engine. A leading "?" always searches. */
export function resolveAddress(input: string, engine: SearchEngine): string | null {
  const text = input.trim();

  if (!text) return null;

  if (text.startsWith("?")) return text.length > 1 ? searchUrl(engine, text.slice(1)) : null;
  const url = fixupUrl(text);

  return url && isWebURL(url) ? new URL(url).href : searchUrl(engine, text);
}

/** The host without "www.", for titles of pages that haven't loaded one. */
export function siteName(url: string): string {
  return hostOf(url) || url;
}
