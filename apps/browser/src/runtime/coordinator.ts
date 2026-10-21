import type { CoordinatorRuntimeTransport, RuntimeResolution } from "@bay/platform/runtimeTransport";
import type { BrowserState, BrowserStore } from "../store/browser";
import { createBrowserAuthority, type BrowserCommand, type BrowserCommit, type CommandRequest } from "./authority";
import { decodeBrowserCommit } from "./client";
import type { BrowserProjection } from "./projection";
import type { LocationCommandEffects } from "./locationCommands";
import type { PersistenceOwner } from "../lib/persist";
import { startCoordinatorServices } from "./services";
import { onPageEvent, startPageEvents, stopPageEvents } from "@bay/nncore";
import { createPageFactConsumer } from "./pageFacts";

export type BrowserCoordinatorTransport = CoordinatorRuntimeTransport<BrowserProjection, BrowserCommand, string | null>;

/** Coordinator-only recovery. This full projection contains private data.
 * Merge into the sole authority store, retaining its actions and all accepted
 * live/navigation/adoption state. Session hydrate deliberately is not involved.
 */
function recover(store: BrowserStore, epoch: string, state: BrowserProjection) {
  const accepted = decodeBrowserCommit({ epoch, revision: 0, state });
  const detached = JSON.parse(JSON.stringify(accepted.state)) as Partial<BrowserState>;
  store.setState(detached);
}
function commandError(error: unknown): { code: string; message: string } {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z_]{1,128}$/.test(error.code)
      ? error.code
      : "command_failed";
  const message = error instanceof Error && error.message ? error.message.slice(0, 16384) : "Browser command failed";
  return { code, message };
}

/** The caller supplies restored state. Recovery replaces it before authority
 * creation. Services run once here, after publication is subscribed, and stop
 * with the coordinator. Native windows are reconciled before announceReady.
 */
export async function createBrowserCoordinator({
  store,
  transport,
  effects,
  startServices = startCoordinatorServices,
  onError = (error) => console.error("[runtime] coordinator failed", error),
}: {
  store: BrowserStore;
  transport: BrowserCoordinatorTransport;
  effects?: LocationCommandEffects;
  startServices?: (options: { store: BrowserStore }) => PersistenceOwner;
  onError?: (error: Error) => void;
}) {
  const identity = transport.bootstrap;
  let authority: ReturnType<typeof createBrowserAuthority>;
  try {
    if (
      identity.version !== 1 ||
      identity.role !== "coordinator" ||
      typeof identity.epoch !== "string" ||
      !identity.epoch ||
      typeof identity.clientId !== "string" ||
      !identity.clientId ||
      "windowId" in identity
    )
      throw new Error("A browser-assigned coordinator connection is required");
    if (identity.recoveryState !== undefined) recover(store, identity.epoch, identity.recoveryState);
    authority = createBrowserAuthority({ epoch: identity.epoch, store, effects });
  } catch (error) {
    transport.dispose();
    throw error;
  }
  const epoch = identity.epoch;
  let failure: Error | null = null;
  let disposed = false;
  let publishedRevision = -1;
  let publications = Promise.resolve();
  let ready: Promise<void> | null = null;
  let unsubscribeAuthority = () => {};
  let unsubscribeCommands = () => {};
  let unsubscribeClose = () => {};
  let services: PersistenceOwner | undefined;
  const pageFacts = createPageFactConsumer(store);
  let unsubscribePages = () => {};

  function active() {
    if (failure) throw failure;
    if (disposed) throw new Error("Browser coordinator is closed");
  }
  function stop(error?: unknown) {
    if (disposed) return;
    disposed = true;
    failure = error === undefined ? null : error instanceof Error ? error : new Error(String(error));
    pageFacts.dispose();
    for (const remove of [unsubscribePages, unsubscribeAuthority, unsubscribeCommands, unsubscribeClose, () => services?.dispose()]) {
      try {
        remove();
      } catch {}
    }
    authority.close();
    try {
      transport.dispose();
    } catch (cause) {
      console.error("[runtime] coordinator transport cleanup failed", cause);
    }
    if (failure) {
      try {
        onError(failure);
      } catch (cause) {
        console.error("[runtime] coordinator error handler failed", cause);
      }
    }
  }
  function publish(commit: BrowserCommit): Promise<void> {
    const task = publications.then(async () => {
      active();
      if (commit.epoch !== epoch || commit.revision !== publishedRevision + 1) throw new Error("Coordinator publication sequence is invalid");
      await transport.publish(commit);
      active();
      publishedRevision = commit.revision;
    });
    publications = task;
    void task.catch(stop);
    return task;
  }
  async function resolve(token: string, reply: RuntimeResolution<string | null>) {
    active();
    await transport.resolve(token, reply);
    active();
  }
  async function handleCommand(token: string, request: CommandRequest, initial: Promise<void>) {
    try {
      await initial;
      active();
      let response: RuntimeResolution<string | null>;
      try {
        const reply = await authority.dispatch(request);
        await publications;
        active();
        if (publishedRevision < reply.commit.revision) throw new Error("Command revision was not published");
        response = { epoch, revision: reply.commit.revision, value: reply.value };
      } catch (error) {
        active();
        await publications;
        active();
        response = { epoch, error: commandError(error) };
      }
      await resolve(token, response);
    } catch (error) {
      if (!disposed) stop(error);
    }
  }

  try {
    // Queue revision zero before subscribing, so synchronous service mutations
    // and commands can never overtake the initial publication.
    const initial = publish(authority.getSnapshot());
    unsubscribeAuthority = authority.subscribe((commit) => {
      void publish(commit);
    });
    const releaseClose = transport.subscribeClose((error) => stop(error));
    if (disposed) releaseClose();
    else unsubscribeClose = releaseClose;
    active();
    const releaseCommands = transport.subscribeCommands((token, request) => {
      void handleCommand(token, request, initial);
    });
    if (disposed) releaseCommands();
    else unsubscribeCommands = releaseCommands;
    active();
    const owner = startServices({ store });
    if (disposed) owner.dispose();
    else services = owner;
    active();
    const pages = onPageEvent((event) => {
      if (!disposed) pageFacts.apply(event);
    });
    unsubscribePages = () => {
      pages.remove();
      void stopPageEvents().catch((error) => console.error("[runtime] page event cleanup failed", error));
    };
    await initial;
    active();
    // Native authorizes page identity against its accepted projection. The
    // first commit must reach the browser before requesting cached page facts.
    await startPageEvents();
    active();
    return {
      getSnapshot: authority.getSnapshot,
      flushPersistence(options?: { final?: boolean }) {
        active();
        return services!.flush(options);
      },
      resumePersistence() {
        active();
        services!.resume();
      },
      async flushPublications() {
        active();
        await publications;
        active();
      },
      async announceReady() {
        active();
        ready ??= (async () => {
          await publications;
          active();
          await transport.announceReady();
          active();
        })();
        void ready.catch(stop);
        return ready;
      },
      dispose() {
        stop();
      },
    };
  } catch (error) {
    stop(error);
    throw error;
  }
}
