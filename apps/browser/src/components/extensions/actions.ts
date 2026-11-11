// The app's extension actions: the commands the user asked for, and the toolbar's own read.
//
// The commands are the service's: it names the failure, and it reads the profile's list again. They are programs,
// and the runtime runs them where the app's own boundary is (effect/commands.ts).
//
// The toolbar's action states stay plain: the answer belongs to the tab that was shown when it was asked, and the
// pass is one at a time so a tab switch mid-pass is not dropped.
import { extensionActionStates } from "@bay/chromium";
import * as Effect from "effect/Effect";
import { useBrowser } from "../../store/browserStore";
import { activeTabId } from "../../store/model";
import { ExtensionsService, type ExtensionUpdate } from "./service";
import { browserIdOf, useExtensions, windowExtensions } from "./store";

/** Reads a profile's extensions from the engine, and shows them. */
export const refreshExtensions = (profile: string) =>
  Effect.gen(function* () {
    const extensions = yield* ExtensionsService;

    yield* extensions.refresh(profile);
  });

/** Installs an unpacked extension into a profile. */
export const installExtension = (path: string, profile: string) =>
  Effect.gen(function* () {
    const extensions = yield* ExtensionsService;

    yield* extensions.install(path, profile);
  });

/** Turns an extension on or off, pins it, or changes what it may do. */
export const updateExtension = (id: string, profile: string, options: ExtensionUpdate) =>
  Effect.gen(function* () {
    const extensions = yield* ExtensionsService;

    yield* extensions.update(id, profile, options);
  });

/** Removes an extension from a profile. */
export const uninstallExtension = (id: string, profile: string) =>
  Effect.gen(function* () {
    const extensions = yield* ExtensionsService;

    yield* extensions.uninstall(id, profile);
  });

/** Answers the engine's question about an extension's permissions. */
export const answerExtensionPrompt = (requestId: string, accepted: boolean) =>
  Effect.gen(function* () {
    const extensions = yield* ExtensionsService;

    yield* extensions.answer(requestId, accepted);
  });

// The toolbar's action states (icon, badge, title) for each window's active tab. One pass at a time: asking while one
// runs runs another right after it, so a tab switch mid-pass is never dropped and the last pass sees the latest tabs.
let running: Promise<void> | null = null;
let again = false;

export function refreshActionStates(): Promise<void> {
  if (running) {
    again = true;

    return running;
  }

  running = (async () => {
    try {
      do {
        again = false;
        await pass();
      } while (again);
    } finally {
      running = null; // in the same turn as the last check of `again`: no request falls between
    }
  })();

  return running;
}

async function pass() {
  const s = useBrowser.getState();
  const { popup } = useExtensions.getState();
  await Promise.all(
    s.windowOrder.map(async (windowId) => {
      const ids = windowExtensions(s, windowId)
        .filter((x) => x.hasAction !== false && (x.pinned || popup?.extensionId === x.id))
        .map((x) => x.id);

      const browserId = browserIdOf(activeTabId(s, windowId));

      if (!ids.length || !browserId) return;
      const states = await extensionActionStates(browserId, ids).catch(() => null);
      const previous = useExtensions.getState().actions[browserId];

      if (!states || (previous && JSON.stringify(previous) === JSON.stringify(states))) return;
      useExtensions.setState((e) => ({ actions: { ...e.actions, [browserId]: states } }));
    }),
  );
}
