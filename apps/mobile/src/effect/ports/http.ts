// The app's network. The device's own fetch, wrapped so a request can be cancelled, its status kept, and its body
// decoded at the edge where it arrives. A status that isn't a success is a failure: the caller asked for something
// the server didn't give it.
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DecodeError, type Operation } from "../errors.ts";

export type HttpRequest = {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Whether the request carries the caller's credentials. The app's own requests send none. */
  readonly credentials?: "omit" | "include" | "same-origin";
  /** Whether a redirect is followed. */
  readonly redirect?: "follow" | "error" | "manual";
  /** The caller's own signal. It is cancelled along with the effect that made the request. */
  readonly signal?: AbortSignal;
};

export type HttpResponse = {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
  /** The response's headers, as the server sent them. */
  readonly headers: { get: (name: string) => string | null };
};

/** Where a request ended up and what the server said there. */
export type HttpProbe = {
  readonly status: number;
  /** The address the response came from, after the redirects that were followed. */
  readonly url: string;
  readonly headers: { get: (name: string) => string | null };
};

/** The request did not come back as a success: it failed, or it came back with a status that isn't one. */
export class HttpError extends TaggedError("HttpError")<{
  readonly operation: Operation;
  readonly status: number;
  /** How long the server asked the caller to wait, in milliseconds. */
  readonly retryAfterMs?: number;
  readonly cause: unknown;
}> {}

/** A signal that is cancelled when either of the two is. */
const link = (outer: AbortSignal | undefined, inner: AbortSignal): AbortSignal => {
  if (!outer) return inner;

  if (outer.aborted) return AbortSignal.abort();

  const controller = new AbortController();
  const cancel = () => controller.abort();

  outer.addEventListener("abort", cancel, { once: true });
  inner.addEventListener("abort", cancel, { once: true });

  return controller.signal;
};

/** The milliseconds a `Retry-After` header asks for, when it asks in seconds. */
const retryAfterMs = (response: { headers: { get: (name: string) => string | null } }): number | undefined => {
  const header = response.headers.get("retry-after");

  if (!header) return undefined;

  const seconds = Number(header);

  if (!Number.isFinite(seconds) || seconds < 0) return undefined;

  return Math.round(seconds * 1000);
};

export class Http extends Context.Service<
  Http,
  {
    /** Sends the request and reads the body as text. */
    readonly send: (request: HttpRequest) => Effect.Effect<HttpResponse, HttpError>;
    /** Sends the request and decodes the body. `decode` turns the raw text into the caller's own type. */
    readonly sendJson: <A>(request: HttpRequest, decode: (body: string) => A) => Effect.Effect<A, HttpError | DecodeError>;
    /**
     * Sends the request and reads where it ended up, whatever the status: only a request that never reached a server
     * fails. The body is never read. A request that keeps its redirects (`redirect: "manual"`) goes through Expo's
     * fetch, because React Native's follows them whatever it is asked.
     */
    readonly probe: (request: HttpRequest) => Effect.Effect<HttpProbe, HttpError>;
  }
>()("bay/Http") {
  static readonly layer = Layer.effect(
    Http,
    Effect.sync(() => {
      const send = (request: HttpRequest, operation: Operation) =>
        Effect.tryPromise({
          try: (signal) =>
            fetch(request.url, {
              method: request.method ?? "GET",
              headers: request.headers,
              body: request.body,
              credentials: request.credentials ?? "omit",
              redirect: request.redirect ?? "follow",
              signal: link(request.signal, signal),
            }).then(async (response) => {
              const body = await response.text();
              const result: HttpResponse = { status: response.status, ok: response.ok, body, headers: response.headers };

              if (!response.ok) {
                throw new HttpError({
                  operation,
                  status: response.status,
                  retryAfterMs: retryAfterMs(response),
                  cause: new Error(`${response.status} ${response.statusText}`),
                });
              }

              return result;
            }),
          catch: (cause) => (cause instanceof HttpError ? cause : new HttpError({ operation, status: 0, cause })),
        });

      const probe = (request: HttpRequest) =>
        Effect.tryPromise({
          try: async (signal): Promise<HttpProbe> => {
            const init = {
              method: request.method ?? "GET",
              headers: request.headers,
              credentials: request.credentials ?? "omit",
              redirect: request.redirect ?? "follow",
              signal: link(request.signal, signal),
            };

            const response = request.redirect === "manual" ? await (await import("expo/fetch")).fetch(request.url, init) : await fetch(request.url, init);

            return { status: response.status, url: response.url || request.url, headers: response.headers };
          },
          catch: (cause) => new HttpError({ operation: { name: "http.probe", resource: request.url }, status: 0, cause }),
        });

      return Http.of({
        send: (request) => send(request, { name: "http.send", resource: request.url }),
        sendJson: (request, decode) =>
          send(request, { name: "http.send", resource: request.url }).pipe(
            Effect.flatMap((response) =>
              Effect.try({
                try: () => decode(response.body),
                catch: (cause) => new DecodeError({ operation: { name: "http.decode", resource: request.url }, cause }),
              }),
            ),
          ),
        probe,
      });
    }),
  );
}
