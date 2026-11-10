// The app's network. React Native's fetch, wrapped so a request can be cancelled, its status kept, and its body
// decoded at the edge where it arrives.
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Operation } from "../errors";

export type HttpRequest = {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** The caller's own signal. It is cancelled along with the effect that made the request. */
  readonly signal?: AbortSignal;
};

export type HttpResponse = {
  readonly status: number;
  readonly ok: boolean;
  readonly body: string;
};

/** The request did not come back as a success: it failed, or it came back with a status that isn't one. */
export class HttpError extends TaggedError("HttpError")<{
  readonly operation: Operation;
  readonly status: number;
  /** How long the server asked the caller to wait, in milliseconds. */
  readonly retryAfterMs?: number;
  readonly cause: unknown;
}> {}

/** The body came back, but it wasn't what the caller expected it to be. */
export class DecodeError extends TaggedError("DecodeError")<{
  readonly operation: Operation;
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
              signal: link(request.signal, signal),
            }).then(async (response) => {
              const body = await response.text();
              const result: HttpResponse = { status: response.status, ok: response.ok, body };

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
      });
    }),
  );
}
