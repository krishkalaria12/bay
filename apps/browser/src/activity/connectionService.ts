// The accounts the user connects: the OAuth tab, the device poll, the Keychain and the tokens.
//
// A connection is a job: it owns a tab, a watch or a poll, and it ends when the user closes it or replaces it.
// A disconnected account moves its generation before its state goes, so a late answer cannot bring it back.
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as v from "valibot";
import { AuthorityStore } from "../effect/ports/store";
import { Diagnostics } from "../effect/ports/diagnostics";
import { GOOGLE_REDIRECT, GOOGLE_SCOPE } from "./constants";
import { githubAnswer, githubBody, githubHeaders, VIEWER_QUERY, type ViewerAnswer } from "./github";
import { basic, deleteSecret, endpoints, form, getSecret, notionHeaders, request, setSecret } from "./net";
import { live, setAccount, updateConfig } from "./activityStore";
import { LiveError, type LiveAccount, type LiveSourceId } from "./types";

// The characters a state or a verifier is made of: the ones a URL carries as they are.
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const random = (n: number) => Array.from({ length: n }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join("");

// The query of a redirect: what the provider sent back.
function query(url: string): Map<string, string> {
  const search = url.split("#")[0]!.split("?")[1] ?? "";

  // SAFETY: each &-separated pair splits into a key and value; decoding maps the two parts in order into a tuple.
  const pairs = search
    .split("&")
    .filter(Boolean)
    .map((pair) => pair.split("=").map((v) => decodeURIComponent(v.replace(/\+/g, " "))) as [string, string]);

  return new Map(pairs);
}

// The tokens as they are kept in the Keychain.
const GoogleTokensSchema = v.object({
  access_token: v.string(),
  refresh_token: v.string(),
  expires_at: v.number(),
  client_secret: v.string(),
});

type GoogleTokens = v.InferOutput<typeof GoogleTokensSchema>;

// The tokens as they are read back: what is not one of them is not a sign-in.
const parseTokens = (secret: string): GoogleTokens | null => {
  try {
    const parsed = v.safeParse(GoogleTokensSchema, JSON.parse(secret));

    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
};

// The account as the app shows it.
const account = (login: string, name: string | null, avatar: string | null): LiveAccount => ({ login, name, avatar, connectedAt: Date.now() });

// Every account the app connects: an owner that goes moves each of them on.
const ACCOUNTS: readonly LiveSourceId[] = ["github", "bitbucket", "notion", "confluence", "gdrive"];

// The flow an account is having: the OAuth tab, or the device poll.
type Flow = { readonly cancel: () => void };

// The cancellations the user asked for: they are expected, and they are silent.
const CANCELLED = new LiveError("signedOut", "Cancelled");
const SIGNIN_CANCELLED = new LiveError("other", "Sign-in was cancelled");

// The account is not connected: that is a state, not a failure.
const NOT_SIGNED_IN = "Not signed in";

// What each failure is reported as. The words are ours: a provider's answer can carry a credential.
const REPORTS = {
  "connection.github": "GitHub didn't accept the sign-in",
  "connection.bitbucket": "Bitbucket didn't accept the sign-in",
  "connection.notion": "Notion didn't accept the sign-in",
  "connection.confluence": "Confluence didn't accept the sign-in",
  "connection.google": "Google didn't accept the sign-in",
  "connection.device": "The GitHub sign-in didn't finish",
  "connection.refresh": "The account's token could not be refreshed",
  "connection.keychain": "The Keychain could not be reached",
} satisfies Record<string, string>;

// The work the service reports under.
type Operation = keyof typeof REPORTS;

/** A request to a provider. */
export type ProviderRequest = {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
};

/** The native and network side of a connection, as the service reaches it. */
export class ConnectionEngine extends Context.Service<
  ConnectionEngine,
  {
    /** Reads the account's secret from the Keychain. */
    readonly readSecret: (source: LiveSourceId) => Effect.Effect<string | null, LiveError>;
    /** Writes the account's secret to the Keychain. */
    readonly writeSecret: (source: LiveSourceId, secret: string) => Effect.Effect<void, LiveError>;
    /** Removes the account's secret from the Keychain. */
    readonly deleteSecret: (source: LiveSourceId) => Effect.Effect<void, LiveError>;
    /** Sends a request to a provider. The request is cancelled with the effect that made it. */
    readonly send: <A>(request: ProviderRequest) => Effect.Effect<A, LiveError>;
    /** Opens the tab a sign-in happens in. */
    readonly openTab: (windowId: string, url: string) => Effect.Effect<string>;
    /** Closes the tab a sign-in happened in. */
    readonly closeTab: (tabId: string) => Effect.Effect<void>;
    /** Watches the tab a sign-in happens in: the listener hears the tab's address, or nothing when the tab is gone. */
    readonly watchTab: (tabId: string, listener: (url: string | null) => void) => () => void;
  }
>()("bay/ConnectionEngine") {
  static readonly layer = Layer.effect(
    ConnectionEngine,
    Effect.gen(function* () {
      const browser = yield* AuthorityStore;

      return ConnectionEngine.of({
        readSecret: (source) => Effect.tryPromise({ try: () => getSecret(source), catch: () => new LiveError("other", "Couldn't read the Keychain") }),
        writeSecret: (source, secret) =>
          Effect.tryPromise({
            try: () => setSecret(source, secret).then(() => undefined),
            catch: () => new LiveError("other", "Couldn't write to the Keychain"),
          }),
        deleteSecret: (source) =>
          Effect.tryPromise({ try: () => deleteSecret(source).then(() => undefined), catch: () => new LiveError("other", "Couldn't reach the Keychain") }),
        send: <A>(req: ProviderRequest) =>
          Effect.tryPromise({
            try: (signal) => request<A>(req.url, { method: req.method, headers: req.headers, body: req.body, signal }),
            catch: (cause) => {
              // The network's own failures are the app's; an answer that is not usable is a defect, as it was before.
              if (cause instanceof LiveError) return cause;

              throw cause;
            },
          }),
        openTab: (windowId, url) => Effect.sync(() => browser.getState().newTab(windowId, { url })),
        closeTab: (tabId) => Effect.sync(() => browser.getState().closeTab(tabId)),
        watchTab: (tabId, listener) =>
          browser.subscribe((s, prev) => {
            if (s.tabs === prev.tabs) return;

            const tab = s.tabs[tabId];

            listener(tab ? tab.url : null);
          }),
      });
    }),
  );
}

/** GitHub's device flow: the code the user types in, and the wait for it. */
export type DeviceFlow = {
  /** The code the user types in on GitHub. */
  readonly userCode: string;
  /** Where the user types it. */
  readonly verificationUri: string;
  /** When the code stops working. */
  readonly expiresAt: number;
  /** Waits for the sign-in to finish. */
  readonly done: Effect.Effect<void, LiveError>;
  /** Stops the wait. */
  readonly cancel: Effect.Effect<void>;
};

/** What the connections the app can do. */
export type Connections = ConnectionService["Service"];

export class ConnectionService extends Context.Service<
  ConnectionService,
  {
    /** Connects GitHub with a token the user pasted. */
    readonly connectGithub: (token: string) => Effect.Effect<void, LiveError>;
    /** Connects Bitbucket with the user's name and an API token. */
    readonly connectBitbucket: (user: string, token: string) => Effect.Effect<void, LiveError>;
    /** Connects Notion with an integration secret. */
    readonly connectNotion: (token: string) => Effect.Effect<void, LiveError>;
    /** Connects Confluence with a site, an email and an API token. */
    readonly connectConfluence: (site: string, email: string, token: string) => Effect.Effect<void, LiveError>;
    /** Signs in with Google: the tab, the redirect and the code. */
    readonly signInWithGoogle: (windowId: string, clientId: string, clientSecret: string) => Effect.Effect<void, LiveError>;
    /** Starts GitHub's device flow: the code to type in, and the wait for it. */
    readonly deviceFlow: (clientId: string) => Effect.Effect<DeviceFlow, LiveError>;
    /** Ends the flow an account is having. */
    readonly cancelFlow: (source: LiveSourceId) => Effect.Effect<void>;
    /** Disconnects an account: its secret goes, and a late answer cannot bring it back. */
    readonly disconnect: (source: LiveSourceId) => Effect.Effect<void, LiveError>;
    /** The account's token, refreshed when it is due. */
    readonly token: (source: LiveSourceId) => Effect.Effect<string, LiveError>;
    /**
     * The owner of the requests went: every flow ends and every account moves on, so an answer still on its way
     * writes neither the Keychain nor the account, here or in the owner that comes next.
     */
    readonly retire: Effect.Effect<void>;
  }
>()("bay/ConnectionService") {
  static readonly layer = Layer.effect(
    ConnectionService,
    Effect.gen(function* () {
      const engine = yield* ConnectionEngine;
      const diagnostics = yield* Diagnostics;
      const scope = yield* Scope.Scope;

      // Each account's generation: a disconnect moves it, so a late answer cannot bring the account back.
      const generations = new Map<LiveSourceId, number>();
      const generation = (source: LiveSourceId) => generations.get(source) ?? 0;

      // The refresh an account is having: one at a time, so two readers share one refresh.
      const locks = new Map<LiveSourceId, Semaphore.Semaphore>();
      // Keychain changes serialize separately, so disconnect never waits for a provider request.
      const mutations = new Map<LiveSourceId, Semaphore.Semaphore>();

      const lockOf = (source: LiveSourceId, pool = locks) => {
        const held = pool.get(source);

        if (held) return held;

        const made = Semaphore.makeUnsafe(1);

        pool.set(source, made);

        return made;
      };

      const writeCurrentSecret = (source: LiveSourceId, secret: string, gen: number): Effect.Effect<void, LiveError> =>
        Effect.suspend(() =>
          lockOf(source, mutations).withPermit(
            Effect.gen(function* () {
              if (generation(source) !== gen) return yield* Effect.fail(CANCELLED);

              // Native Keychain writes cannot be cancelled. Keep the permit until the write actually lands,
              // so a disconnect's delete follows it even when the caller is interrupted.
              yield* engine.writeSecret(source, secret);

              if (generation(source) !== gen) return yield* Effect.fail(CANCELLED);
            }).pipe(Effect.uninterruptible),
          ),
        );

      // The flow an account is having.
      const flows = new Map<LiveSourceId, Flow>();

      // A failure is reported once, and it never carries a token: the words are ours, not the provider's.
      const report = (operation: Operation, resource: LiveSourceId, error: LiveError): Effect.Effect<never, LiveError> => {
        // The user asked for it: a cancellation is expected, and it is silent.
        if (error === CANCELLED || error === SIGNIN_CANCELLED) return Effect.fail(error);

        // The account is not connected: that is a state, not a failure.
        if (error.message === NOT_SIGNED_IN) return Effect.fail(error);

        return Effect.andThen(diagnostics.report({ operation: { name: operation, resource }, message: REPORTS[operation] }), Effect.fail(error));
      };

      // The end of a flow: the watch goes, and the tab goes with it.
      const endFlow = (source: LiveSourceId): Effect.Effect<void> =>
        Effect.sync(() => {
          const flow = flows.get(source);

          if (!flow) return;

          flows.delete(source);
          flow.cancel();
        });

      // The account's secret: the token it uses, refreshed when it is due.
      const token = (source: LiveSourceId): Effect.Effect<string, LiveError> => Effect.suspend(() => lockOf(source).withPermit(refreshToken(source)));

      const refreshToken = (source: LiveSourceId): Effect.Effect<string, LiveError> =>
        Effect.gen(function* () {
          const gen = generation(source);
          const secret = yield* engine.readSecret(source);

          if (generation(source) !== gen) return yield* Effect.fail(new LiveError("signedOut", NOT_SIGNED_IN));

          if (!secret) return yield* Effect.fail(new LiveError(live().accounts[source] ? "signedOut" : "notConfigured", NOT_SIGNED_IN));

          // Only Google's token expires; the others are the credential itself.
          if (source !== "gdrive") return yield* Effect.succeed(secret);

          const stored = parseTokens(secret);

          if (!stored) return yield* Effect.fail(new LiveError("signedOut", "The stored sign-in is not usable"));

          if (stored.expires_at > Date.now() + 60_000) return yield* Effect.succeed(stored.access_token);

          const json = yield* engine.send<{ access_token: string; expires_in: number }>({
            url: endpoints.googleToken,
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form({
              client_id: live().config.googleClientId,
              client_secret: stored.client_secret,
              refresh_token: stored.refresh_token,
              grant_type: "refresh_token",
            }),
          });

          // The account was disconnected while the token was being refreshed: the answer belongs to nobody.
          if (generation(source) !== gen) return yield* Effect.fail(new LiveError("signedOut", NOT_SIGNED_IN));

          yield* writeCurrentSecret(
            source,
            JSON.stringify({ ...stored, access_token: json.access_token, expires_at: Date.now() + json.expires_in * 1000 }),
            gen,
          );

          return yield* Effect.succeed(json.access_token);
        }).pipe(Effect.catch((error) => report("connection.refresh", source, error)));

      const connectGithub = (token: string): Effect.Effect<void, LiveError> =>
        Effect.gen(function* () {
          const secret = token.trim();
          const gen = generation("github");

          const raw = yield* engine.send<ViewerAnswer & { errors?: { type?: string; message: string }[] }>({
            url: endpoints.githubGraphql,
            method: "POST",
            headers: githubHeaders(secret),
            body: githubBody(VIEWER_QUERY),
          });

          const answer = githubAnswer(raw);

          if (!answer.ok) return yield* Effect.fail(answer.error);

          const viewer = answer.data.data?.viewer;

          if (!viewer) return yield* Effect.fail(new LiveError("signedOut", "GitHub didn't accept the token"));

          // The account was disconnected while the token was being checked: it stays disconnected.
          if (generation("github") !== gen) return yield* Effect.fail(CANCELLED);

          yield* writeCurrentSecret("github", secret, gen);

          setAccount("github", account(viewer.login, viewer.name, viewer.avatarUrl));
        }).pipe(Effect.catch((error) => report("connection.github", "github", error)));

      const connectBitbucket = (user: string, token: string): Effect.Effect<void, LiveError> =>
        Effect.gen(function* () {
          const gen = generation("bitbucket");

          const me = yield* engine.send<{ account_id: string; display_name: string; links?: { avatar?: { href: string } } }>({
            url: `${endpoints.bitbucket}/user`,
            headers: { Authorization: basic(user.trim(), token.trim()) },
          });

          // The account was disconnected while the token was being checked: it stays disconnected.
          if (generation("bitbucket") !== gen) return yield* Effect.fail(CANCELLED);

          yield* writeCurrentSecret("bitbucket", token.trim(), gen);

          updateConfig({ bitbucketUser: user.trim() });

          setAccount("bitbucket", account(me.account_id, me.display_name, me.links?.avatar?.href ?? null));
        }).pipe(Effect.catch((error) => report("connection.bitbucket", "bitbucket", error)));

      const connectNotion = (token: string): Effect.Effect<void, LiveError> =>
        Effect.gen(function* () {
          const gen = generation("notion");

          const me = yield* engine.send<{ name?: string; bot?: { workspace_name?: string } }>({
            url: `${endpoints.notion}/users/me`,
            headers: notionHeaders(token.trim()),
          });

          // The account was disconnected while the token was being checked: it stays disconnected.
          if (generation("notion") !== gen) return yield* Effect.fail(CANCELLED);

          yield* writeCurrentSecret("notion", token.trim(), gen);

          setAccount("notion", account(me.bot?.workspace_name ?? me.name ?? "Notion", me.bot?.workspace_name ?? null, null));
        }).pipe(Effect.catch((error) => report("connection.notion", "notion", error)));

      const connectConfluence = (site: string, email: string, token: string): Effect.Effect<void, LiveError> =>
        Effect.gen(function* () {
          const base = site
            .trim()
            .replace(/\/+$/, "")
            .replace(/^(?!https?:\/\/)/, "https://");

          const gen = generation("confluence");

          const me = yield* engine.send<{ accountId: string; displayName: string }>({
            url: `${endpoints.confluence(base)}/wiki/rest/api/user/current`,
            headers: { Authorization: basic(email.trim(), token.trim()) },
          });

          // The account was disconnected while the token was being checked: it stays disconnected.
          if (generation("confluence") !== gen) return yield* Effect.fail(CANCELLED);

          yield* writeCurrentSecret("confluence", token.trim(), gen);

          updateConfig({ confluenceSite: base, confluenceEmail: email.trim() });

          setAccount("confluence", account(me.accountId, me.displayName, null));
        }).pipe(Effect.catch((error) => report("connection.confluence", "confluence", error)));

      // Google's answer to the code the redirect carried.
      const connectGoogle = (clientId: string, clientSecret: string, code: string, verifier: string, redirectUri: string): Effect.Effect<void, LiveError> =>
        Effect.gen(function* () {
          const gen = generation("gdrive");

          const json = yield* engine.send<{ access_token: string; refresh_token?: string; expires_in: number }>({
            url: endpoints.googleToken,
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form({
              client_id: clientId,
              client_secret: clientSecret,
              code,
              code_verifier: verifier,
              grant_type: "authorization_code",
              redirect_uri: redirectUri,
            }),
          });

          if (!json.refresh_token) return yield* Effect.fail(new LiveError("signedOut", "Google didn't return a refresh token"));

          const tokens: GoogleTokens = {
            access_token: json.access_token,
            refresh_token: json.refresh_token,
            expires_at: Date.now() + json.expires_in * 1000,
            client_secret: clientSecret,
          };

          // The account was disconnected while the code was being exchanged: it stays disconnected.
          if (generation("gdrive") !== gen) return yield* Effect.fail(CANCELLED);

          yield* writeCurrentSecret("gdrive", JSON.stringify(tokens), gen);

          const about = yield* engine
            .send<{ user?: { displayName: string; emailAddress: string; photoLink?: string } }>({
              url: `${endpoints.drive}/about?fields=user`,
              headers: { Authorization: `Bearer ${json.access_token}` },
            })
            .pipe(Effect.catch(() => Effect.succeed(null)));

          // The account was disconnected while the profile was being read: it stays disconnected.
          if (generation("gdrive") !== gen) return yield* Effect.fail(CANCELLED);

          updateConfig({ googleClientId: clientId });

          setAccount("gdrive", account(about?.user?.emailAddress ?? "Google Drive", about?.user?.displayName ?? null, about?.user?.photoLink ?? null));
        }).pipe(Effect.catch((error) => report("connection.google", "gdrive", error)));

      // What the sign-in tab says when it comes back from the provider.
      type Redirect = { readonly kind: "redirect"; readonly url: string } | { readonly kind: "gone" };

      const signInWithGoogle = (windowId: string, clientId: string, clientSecret: string): Effect.Effect<void, LiveError> =>
        Effect.gen(function* () {
          // The flow that was here ends: its watch goes, and its tab goes with it.
          yield* endFlow("gdrive");

          const verifier = random(64);
          const state = random(24);

          const url = `${endpoints.googleAuth}?${form({
            client_id: clientId.trim(),
            redirect_uri: GOOGLE_REDIRECT,
            response_type: "code",
            scope: GOOGLE_SCOPE,
            code_challenge: verifier,
            code_challenge_method: "plain",
            state,
            access_type: "offline",
            prompt: "consent",
          })}`;

          const tabId = yield* engine.openTab(windowId, url);

          // The watch on the tab, and the way back from it: the flow owns both.
          let stop: (() => void) | undefined;
          let back: ((effect: Effect.Effect<Redirect, LiveError>) => void) | undefined;

          // The watch goes once, whoever ends the flow.
          const stopWatch = () => {
            const watch = stop;

            stop = undefined;
            watch?.();
          };

          const flow: Flow = {
            cancel: () => {
              stopWatch();
              back?.(Effect.fail(CANCELLED));
            },
          };

          const redirect = yield* Effect.callback<Redirect, LiveError>((resume) => {
            back = resume;

            stop = engine.watchTab(tabId, (next) => {
              // The tab is gone: the user closed it.
              if (next === null) {
                resume(Effect.succeed({ kind: "gone" } as const));

                return;
              }

              if (!next.startsWith(GOOGLE_REDIRECT)) return;

              resume(Effect.succeed({ kind: "redirect", url: next } as const));
            });

            flows.set("gdrive", flow);
          }).pipe(
            // The flow ends here: the watch goes, and the tab goes with it.
            Effect.ensuring(
              Effect.sync(() => {
                stopWatch();

                if (flows.get("gdrive") === flow) flows.delete("gdrive");
              }),
            ),
            Effect.ensuring(engine.closeTab(tabId)),
          );

          if (redirect.kind === "gone") return yield* Effect.fail(SIGNIN_CANCELLED);

          const params = query(redirect.url);

          // The answer belongs to another request: it does not connect this one.
          if (params.get("state") !== state) return yield* Effect.fail(new LiveError("other", "Sign-in didn't match this request"));

          const code = params.get("code");

          if (!code) return yield* Effect.fail(new LiveError("signedOut", params.get("error") ?? "Google didn't grant access"));

          yield* connectGoogle(clientId.trim(), clientSecret.trim(), code, verifier, GOOGLE_REDIRECT);
        }).pipe(Effect.catch((error) => report("connection.google", "gdrive", error)));

      // GitHub's poll: the code is asked for until it is accepted, refused or too old.
      const pollDevice = (clientId: string, code: { device_code: string; expires_in: number; interval: number }): Effect.Effect<void, LiveError> =>
        Effect.gen(function* () {
          let interval = Math.max(code.interval, 1) * 1000;
          const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          const expiresAt = started + code.expires_in * 1000;

          for (;;) {
            const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

            if (now >= expiresAt) return yield* Effect.fail(new LiveError("signedOut", "The code expired"));

            yield* Effect.sleep(Duration.millis(interval));

            const json = yield* engine.send<{ access_token?: string; error?: string; interval?: number }>({
              url: `${endpoints.githubWeb}/login/oauth/access_token`,
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: form({ client_id: clientId, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
            });

            if (json.access_token) {
              yield* connectGithub(json.access_token);

              return;
            }

            // GitHub asks for a slower pace when the poll is too fast.
            if (json.error === "slow_down") interval = (json.interval ?? interval / 1000 + 5) * 1000;
            else if (json.error && json.error !== "authorization_pending")
              return yield* Effect.fail(new LiveError("signedOut", json.error === "access_denied" ? "Access was denied" : json.error));
          }
        });

      const deviceFlow = (clientId: string): Effect.Effect<DeviceFlow, LiveError> =>
        Effect.gen(function* () {
          // The flow that was here ends: the poll stops, and the wait ends with it.
          yield* endFlow("github");

          const code = yield* engine
            .send<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>({
              url: `${endpoints.githubWeb}/login/device/code`,
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: form({ client_id: clientId, scope: "repo read:org" }),
            })
            .pipe(Effect.catch((error) => report("connection.device", "github", error)));

          const deferred = yield* Deferred.make<void, LiveError>();

          // The poll stops when the flow is cancelled: the wait ends, and the poll goes with it.
          let fiber: Fiber.Fiber<boolean, LiveError> | undefined;

          const stop = () => {
            void Effect.runFork(Deferred.fail(deferred, CANCELLED));

            if (fiber) void Effect.runFork(Fiber.interrupt(fiber));
          };

          const flow: Flow = { cancel: stop };

          flows.set("github", flow);

          fiber = yield* Effect.forkIn(
            Deferred.complete(
              deferred,
              pollDevice(clientId, code).pipe(
                Effect.catch((error) => report("connection.device", "github", error)),
                // The flow ends here: the account has no flow of its own any more.
                Effect.ensuring(
                  Effect.sync(() => {
                    if (flows.get("github") === flow) flows.delete("github");
                  }),
                ),
              ),
            ),
            scope,
          );

          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

          return {
            userCode: code.user_code,
            verificationUri: code.verification_uri,
            expiresAt: now + code.expires_in * 1000,
            done: Deferred.await(deferred),
            cancel: Effect.gen(function* () {
              yield* Deferred.fail(deferred, CANCELLED);
              yield* Fiber.interrupt(fiber);
            }),
          } satisfies DeviceFlow;
        });

      const disconnect = (source: LiveSourceId): Effect.Effect<void, LiveError> =>
        Effect.gen(function* () {
          // The account moves on before its state goes: a late answer cannot bring it back.
          yield* Effect.sync(() => {
            generations.set(source, generation(source) + 1);
          });

          yield* endFlow(source);

          yield* lockOf(source, mutations).withPermit(engine.deleteSecret(source).pipe(Effect.andThen(Effect.sync(() => setAccount(source, null)))));
        }).pipe(
          Effect.uninterruptible,
          Effect.catch((error) => report("connection.keychain", source, error)),
        );

      const retire = Effect.forEach(
        ACCOUNTS,
        (source) =>
          Effect.suspend(() => {
            generations.set(source, generation(source) + 1);

            return endFlow(source);
          }),
        { discard: true },
      );

      const service = ConnectionService.of({
        connectGithub,
        connectBitbucket,
        connectNotion,
        connectConfluence,
        signInWithGoogle,
        deviceFlow,
        cancelFlow: endFlow,
        disconnect,
        token,
        retire,
      });

      // The sources ask for the token they need; the service owns the refresh behind it.
      const ownRefresh = (source: LiveSourceId) => Effect.runPromise(token(source));

      refresh = ownRefresh;
      installed = service;

      // The runtime that built the service goes: its late answers land nowhere, and the app no longer reaches it.
      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() => {
          if (installed === service) installed = null;

          if (refresh === ownRefresh) refresh = null;

          return retire;
        }),
      );

      return service;
    }),
  );
}

// The service the app's runtime built. The plain side reaches it here, so it does not need the runtime's list.
let installed: Connections | null = null;

/** The connections the app's runtime has built, when it has. */
export const currentConnections = (): Connections | null => installed;

// The refresh the sources ask for: the service owns it, so it is serialized per account.
let refresh: ((source: LiveSourceId) => Promise<string>) | null = null;

/** The account's token, refreshed when it is due. */
export const accountToken = (source: LiveSourceId): Promise<string> =>
  refresh ? refresh(source) : Promise.reject(new LiveError("signedOut", "Not signed in"));
