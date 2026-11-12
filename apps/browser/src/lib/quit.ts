// The quit: the native side asks the app to close, the app saves what it has and answers, and the native side
// goes. The answer never waits for the network: what is saved is saved, and the app says so.
//
// The quit can be called off (a page's beforeunload said Stay): the app keeps running, and the saving goes on
// with what changed meanwhile.
import { replyToTerminate } from "@bay/desktop";
import { flushPersistence, resumePersistence } from "./persistenceService";

let quitting = false;

/** Whether the app is quitting: its windows are closing because the user asked. */
export const isQuitting = () => quitting;

/**
 * The native side asks the app to quit. The session is written and frozen, and the app answers: the native side
 * waits for the answer, and the answer is not held up by anything that needs the network.
 */
export const beginQuit = (): void => {
  quitting = true;
  flushPersistence({ final: true });
  void replyToTerminate(true);
};

/** The quit was called off: the app keeps running, and the saving goes on with what changed meanwhile. */
export const cancelQuit = (): void => {
  quitting = false;
  resumePersistence();
};
