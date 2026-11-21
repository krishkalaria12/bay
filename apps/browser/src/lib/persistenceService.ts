// The app's saving, for the callers that reach it by this name.
//
// The saving itself is lib/persist.ts: one owner per store, one subscription to that store, one timer and one quit
// handshake. The app's entries reach it through the coordinator (runtime/services.ts), which owns the store's saving;
// there is no runtime service that starts a second one.
import { liveFoldersDocument } from "../activity/activityStore";
import { startPersistence as startBrowserPersistence } from "./persist";
import type { SavedDocument } from "./savedDocument";

// The documents other stores keep, saved with the session's own: one timer, the same retry, and the same quit.
const OTHER_DOCS: readonly SavedDocument[] = [liveFoldersDocument];

export { createBrowserPersistence, createPersistence, flushPersistence, resumePersistence } from "./persist";

export type { PersistenceOwner } from "./persist";

/** Starts the app's saving: the session, the downloads, and the live folders' own document. */
export const startPersistence = (): (() => void) => startBrowserPersistence({ documents: OTHER_DOCS });
