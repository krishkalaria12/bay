// The accounts the user connects. The work is in activity/connectionService.ts; this is where the app reaches it.
import * as Effect from "effect/Effect";
import { runDesktop } from "../effect/runtime";
import { currentConnections, type Connections } from "./connectionService";
import { LiveError, type LiveSourceId } from "./types";

/** GitHub's device flow, as the app waits for it. */
export type DeviceSignIn = {
  /** The code the user types in on GitHub. */
  readonly userCode: string;
  /** Where the user types it. */
  readonly verificationUri: string;
  /** When the code stops working. */
  readonly expiresAt: number;
  /** Resolves when the sign-in is through, and rejects when it is not. */
  readonly done: Promise<void>;
  /** Stops the wait. */
  readonly cancel: () => void;
};

// The service the app's runtime built. It is there once the runtime has run once.
const connections = (): Connections => {
  const service = currentConnections();

  if (!service) throw new Error("The connections are not ready");

  return service;
};

const withConnections = <A>(use: (service: Connections) => Effect.Effect<A, LiveError>): Promise<A> =>
  runDesktop(
    Effect.suspend(() => {
      try {
        return use(connections());
      } catch (cause) {
        // SAFETY: Error assertion matches the runtime value validated at this call site.
        return Effect.fail(cause as Error);
      }
    }),
  );

/** Connects GitHub with a token the user pasted. */
export const connectGithub = (token: string): Promise<void> => withConnections((service) => service.connectGithub(token));

/** Connects Bitbucket with the user's name and an API token. */
export const connectBitbucket = (user: string, token: string): Promise<void> => withConnections((service) => service.connectBitbucket(user, token));

/** Connects Notion with an integration secret. */
export const connectNotion = (token: string): Promise<void> => withConnections((service) => service.connectNotion(token));

/** Connects Confluence with a site, an email and an API token. */
export const connectConfluence = (site: string, email: string, token: string): Promise<void> =>
  withConnections((service) => service.connectConfluence(site, email, token));

/** Signs in with Google: the tab, the redirect and the code. */
export const connectGoogleDrive = (windowId: string, clientId: string, clientSecret: string): Promise<void> =>
  withConnections((service) => service.signInWithGoogle(windowId, clientId, clientSecret));

/** Ends the flow an account is having: the watch goes, and the tab goes with it. */
export const cancelConnection = (source: LiveSourceId): void => {
  const service = currentConnections();

  if (!service) return;

  void Effect.runFork(service.cancelFlow(source));
};

/** Starts GitHub's device flow: the code to type in, and the wait for it. */
export const startGithubDeviceFlow = async (clientId: string): Promise<DeviceSignIn> => {
  const flow = await withConnections((service) => service.deviceFlow(clientId));

  return {
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
    expiresAt: flow.expiresAt,
    done: runDesktop(flow.done),
    cancel: () => {
      void Effect.runFork(flow.cancel);
    },
  };
};

/** Disconnects an account: its secret goes, and a late answer cannot bring it back. */
export const disconnect = (source: LiveSourceId): Promise<void> => withConnections((service) => service.disconnect(source));
