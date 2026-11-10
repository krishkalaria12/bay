/**
 * Saved logins (B20): what the server's HTTP sign-in asks for, stored per site so the next challenge is answered
 * silently. A single versioned JSON document (`bay-saved-logins`) in the secure store, like the browser's own
 * `browser.json`. Credentials never join the tab model, history or anything persisted to disk in the clear.
 *
 * Private tabs never read or write here: a private page's credentials stay in the private session, as its history
 * does. The pure format lives in `./logins` so it can be tested without the secure store's native module.
 */

import { formatSavedLogins, parseSavedLogins, type SavedLogin } from "./logins";

function secureStore(): typeof import("expo-secure-store") {
  // Required lazily so this module stays importable where the native module isn't (unit tests, tooling).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // SAFETY: the lazy require and the printed module type are the same published module surface; their runtime
  // properties are exactly the async accessors typed on it.
  return require("expo-secure-store") as typeof import("expo-secure-store");
}

const KEY = "bay-saved-logins";

export type { SavedLogin };

/** Every saved login, in the order they were saved. */
export async function savedLogins(): Promise<SavedLogin[]> {
  return parseSavedLogins(await secureStore().getItemAsync(KEY));
}

/** The saved login for an origin (scheme + host + port), if any. */
export async function savedLoginFor(origin: string): Promise<SavedLogin | null> {
  const logins = await savedLogins();

  return logins.find((login) => login.origin === origin) ?? null;
}

/** Saves (or replaces) a login for an origin + username. */
export async function saveLogin(login: SavedLogin): Promise<void> {
  const logins = (await savedLogins()).filter((existing) => !(existing.origin === login.origin && existing.username === login.username));
  logins.push(login);
  await secureStore().setItemAsync(KEY, formatSavedLogins(logins));
}

/** Forgets one saved login. */
export async function forgetLogin(origin: string, username: string): Promise<void> {
  const logins = (await savedLogins()).filter((existing) => !(existing.origin === origin && existing.username === username));
  await secureStore().setItemAsync(KEY, formatSavedLogins(logins));
}
